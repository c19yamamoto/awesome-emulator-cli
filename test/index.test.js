import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const state = {};

function resetState() {
  Object.assign(state, {
    calls: [],
    records: new Map(),
    containerId: "a1b2c3d4e5f6",
    containerPort: 9297,
    publishedPort: 43123,
    commandExitCode: 0,
    containerDetails: "a1b2c3d4e5f6|true|true|ci-tests",
    dockerError: undefined,
    imageError: undefined,
    startError: undefined,
    stopError: undefined,
    writeError: undefined,
    ownerRunning: true,
    credentialsContents: undefined,
    architecture: { docker: "amd64", rpm: "x86_64" },
    invokeHealthCheck: false,
    startupTimeoutMs: 1000,
    healthBehavior: "success",
    healthStatus: 200,
    healthBody: "ok",
    healthContainerRunning: true,
    containerLogs: "",
    healthRequests: [],
    writeHealthCertificate: true,
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}

async function runDocker(args, options = {}) {
  state.calls.push(["docker", args, options]);
  if (state.dockerError) throw state.dockerError;
  if (args[0] === "inspect" && args[2] === "{{.State.Running}}") return state.healthContainerRunning ? "true" : "false";
  if (args[0] === "logs") return state.containerLogs;
  if (args[0] === "inspect" && args[1] === "--format") return state.containerDetails;
  return "";
}

function readRecord(name) {
  const record = state.records.get(name);
  if (!record) throw new Error(`Emulator session "${name}" was not found.`);
  return record;
}

mock.module("../dist/container-lifecycle.js", {
  namedExports: {
    createRetryableStop: (stop) => {
      let pending;
      return () => {
        if (!pending) pending = Promise.resolve().then(stop).catch((error) => {
          pending = undefined;
          throw error;
        });
        return pending;
      };
    },
    startContainer: async (name, args, signal, waitUntilHealthy) => {
      state.calls.push(["startContainer", name, args, signal]);
      if (state.startError) throw state.startError;
      const mount = args.find((arg) => arg.startsWith("type=bind,source="));
      state.stateDirectory = mount?.slice("type=bind,source=".length).split(",target=")[0];
      const portIndex = args.indexOf("-p");
      state.containerPort = Number(args[portIndex + 1]);
      if (state.credentialsContents) {
        const credentialsDirectory = path.join(state.stateDirectory, String(state.containerPort));
        await mkdir(credentialsDirectory, { recursive: true });
        await writeFile(path.join(credentialsDirectory, "emulator_credentials"), state.credentialsContents);
      }
      if (state.invokeHealthCheck) {
        const portDirectory = path.join(state.stateDirectory, String(state.containerPort));
        await mkdir(portDirectory, { recursive: true });
        if (state.writeHealthCertificate === true) await writeFile(path.join(portDirectory, "ca.pem"), "test CA");
        if (state.writeHealthCertificate === "directory") await mkdir(path.join(portDirectory, "ca.pem"));
        await waitUntilHealthy(state.containerId, signal);
      }
      return state.containerId;
    },
    stopContainer: async (containerId) => {
      state.calls.push(["stopContainer", containerId]);
      if (state.stopError) throw state.stopError;
    },
    withEmulator: async (start, run) => {
      const emulator = await start();
      try {
        return await run(emulator);
      } finally {
        await emulator.stop();
      }
    },
  },
});

mock.module("../dist/container-ports.js", {
  namedExports: {
    formatPortBinding: (requestedPort, containerPort) => requestedPort === 0
      ? `127.0.0.1::${containerPort}`
      : `127.0.0.1:${requestedPort}:${containerPort}`,
    getPublishedPort: async () => state.publishedPort,
    reserveContainerPort: async () => state.containerPort,
  },
});

mock.module("../dist/docker.js", {
  namedExports: {
    docker: runDocker,
    isMissingDockerResource: (error, kind) => error?.missingKind === kind,
    throwIfAborted,
  },
});

mock.module("../dist/emulator-image.js", {
  namedExports: {
    ensureEmulatorImage: async (version, architecture, signal) => {
      state.calls.push(["ensureEmulatorImage", version, architecture, signal]);
      if (state.imageError) throw state.imageError;
      return `awesome-emulator-cli:${version}`;
    },
    getArchitecture: () => state.architecture,
  },
});

mock.module("../dist/session-store.js", {
  namedExports: {
    getProcessStartMarker: () => "test",
    isSessionOwnerRunning: () => state.ownerRunning,
    readSession: async (_directory, name) => readRecord(name),
    removeSession: async (_directory, name) => {
      state.calls.push(["removeSession", name]);
      state.records.delete(name);
    },
    reserveSession: async (_directory, name, containerName) => {
      if (state.records.has(name)) throw new Error(`Emulator session "${name}" already exists.`);
      state.records.set(name, { schemaVersion: 1, name, state: "starting", containerName, ownerPid: process.pid, ownerStartMarker: "test" });
    },
    validateSessionName: (name) => {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error("Invalid session name.");
      return name;
    },
    writeRunningSession: async (_directory, record) => {
      if (state.writeError) throw state.writeError;
      state.records.set(record.name, record);
    },
    writeStartingNativeSession: async () => {},
  },
});

mock.module("../dist/process.js", {
  namedExports: {
    runCommand: async (command, args, environment, signal, shell, stdout) => {
      state.calls.push(["runCommand", command, args, environment, signal, shell, stdout]);
      if (state.commandError) throw state.commandError;
      if (state.abortDuringCommand) state.abortDuringCommand.abort("SIGTERM");
      return state.commandExitCode;
    },
  },
});

mock.module("node:https", {
  defaultExport: {
    get: (options, callback) => {
      state.healthRequests.push(options);
      const request = new EventEmitter();
      request.destroy = () => request.emit("error", new Error("health request timed out"));
      queueMicrotask(() => {
        if (state.healthBehavior === "error") {
          request.emit("error", new Error("connection refused"));
          return;
        }
        if (state.healthBehavior === "timeout") {
          request.emit("timeout");
          return;
        }
        const response = new EventEmitter();
        response.statusCode = state.healthStatus;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", state.healthBody);
        response.emit("end");
      });
      return request;
    },
  },
});

const {
  createContainerRunArguments,
  downEmulatorSession,
  execEmulatorSession,
  prepareEmulatorImage,
  runWithEmulator,
  startEmulator,
  upEmulatorSession,
} = await import("../dist/index.js");

async function makeStateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runningRecord(name = "ci-tests", overrides = {}) {
  return {
    schemaVersion: 2,
    name,
    state: "running",
    containerName: `awesome-emulator-cli-session-test-${name}`,
    containerId: state.containerId,
    version: "1.0.1",
    port: 43210,
    containerPort: 51234,
    ...overrides,
  };
}

test.beforeEach(resetState);

test("prepares the selected image and honors cancellation", async () => {
  assert.equal(await prepareEmulatorImage({ version: "1.0.1" }), "awesome-emulator-cli:1.0.1");
  assert.equal(state.calls[0][0], "ensureEmulatorImage");
  assert.equal(state.calls[0][1], "1.0.1");

  const controller = new AbortController();
  controller.abort("SIGINT");
  await assert.rejects(prepareEmulatorImage({ signal: controller.signal }), { name: "AbortError" });
});

test("starts an emulator with validated options and an idempotent stop", async (t) => {
  const directory = await makeStateDirectory(t);
  const emulator = await startEmulator({ version: "1.0.1", port: 43210, stateDirectory: directory });
  assert.equal(emulator.version, "1.0.1");
  assert.equal(emulator.port, 43210);
  assert.equal(emulator.endpointUrl, "https://127.0.0.1:43210");
  assert.equal(emulator.containerId, state.containerId);
  const start = state.calls.find(([kind]) => kind === "startContainer");
  assert.equal(start[1].startsWith("awesome-emulator-cli-"), true);
  assert.ok(start[2].includes("--memory"));
  assert.ok(start[2].some((argument) => argument.includes("managed=true")));
  await emulator.stop();
  await emulator.stop();
  assert.equal(state.calls.filter(([kind]) => kind === "stopContainer").length, 1);
});

test("builds Docker run arguments for Linux and portable hosts", () => {
  const configuration = {
    architecture: { docker: "arm64", rpm: "aarch64" },
    containerName: "awesome-emulator-test",
    image: "awesome-emulator-cli:test",
    labels: { managed: "true", session: "test" },
    memory: "2g",
    requestedPort: 0,
    containerPort: 51234,
    stateDirectory: "/tmp/emulator-state",
    telemetry: "off",
  };
  const linux = createContainerRunArguments(configuration, {
    platform: "linux",
    getuid: () => 501,
    getgid: () => 20,
  });
  assert.ok(linux.includes("--user"));
  assert.ok(linux.includes("501:20"));
  assert.ok(linux.includes("127.0.0.1::51234"));
  assert.ok(linux.includes("--label"));
  assert.ok(linux.includes("managed=true"));
  assert.ok(linux.includes("session=test"));

  for (const host of [
    { platform: "darwin", getuid: () => 501, getgid: () => 20 },
    { platform: "linux", getgid: () => 20 },
    { platform: "linux", getuid: () => 501 },
  ]) {
    assert.equal(createContainerRunArguments(configuration, host).includes("--user"), false);
  }
});

test("rejects image and container startup failures", async (t) => {
  const directory = await makeStateDirectory(t);
  state.imageError = new Error("image build failed");
  await assert.rejects(startEmulator({ stateDirectory: directory }), /image build failed/);

  state.imageError = undefined;
  state.startError = new Error("container launch failed");
  await assert.rejects(startEmulator({ stateDirectory: directory }), /container launch failed/);
});

test("starts a persistent session, records it, and returns public session data", async (t) => {
  const directory = await makeStateDirectory(t);
  const session = await upEmulatorSession("ci-tests", { stateDirectory: directory, port: 54321 });
  assert.equal(session.name, "ci-tests");
  assert.equal(session.port, 54321);
  assert.equal("containerId" in session, false);
  assert.equal("stop" in session, false);
  assert.equal(state.records.get("ci-tests").state, "running");
  assert.equal(state.records.get("ci-tests").containerPort, 54321);
});

test("validates and initializes persistent sessions with child environment settings", async (t) => {
  const directory = await makeStateDirectory(t);
  state.stateDirectory = directory;
  state.credentialsContents = "[default]\naws_access_key_id = test-key\naws_secret_access_key = test-secret\naws_session_token = test-token\n";
  await upEmulatorSession("ci-tests", {
    stateDirectory: directory,
    port: 54321,
    init: { command: "node", args: ["seed.js"], region: "ap-northeast-1", sdks: ["java-v2"], credentials: "environment" },
  });
  const command = state.calls.find(([kind]) => kind === "runCommand");
  assert.equal(command[1], "node");
  assert.deepEqual(command[2], ["seed.js"]);
  assert.equal(command[3].AWS_REGION, "ap-northeast-1");
  assert.equal(command[3].AWS_ACCESS_KEY_ID, "test-key");
  assert.equal(command[3].AWS_SECRET_ACCESS_KEY, "test-secret");
  assert.equal(command[3].AWS_SESSION_TOKEN, "test-token");
  assert.equal(command[6], "stderr");
});

test("cleans up failed initialization and startup reservations", async (t) => {
  const directory = await makeStateDirectory(t);
  state.commandExitCode = 19;
  await assert.rejects(upEmulatorSession("failed-init", {
    stateDirectory: directory,
    init: { command: "seed", args: [] },
  }), /initialization command failed with exit code 19/);
  assert.equal(state.records.has("failed-init"), false);
  assert.ok(state.calls.some(([kind]) => kind === "stopContainer"));

  state.startError = new Error("start failed");
  await assert.rejects(upEmulatorSession("failed-start", { stateDirectory: directory }), /start failed/);
  assert.equal(state.records.has("failed-start"), false);
  await assert.rejects(upEmulatorSession("invalid name", { stateDirectory: directory }), /Invalid session name/);
  await assert.rejects(upEmulatorSession("empty-init", { stateDirectory: directory, init: { command: "" } }), /initialization command is required/);
});

test("aggregates cleanup failures when persistent initialization fails", async (t) => {
  const directory = await makeStateDirectory(t);
  state.commandExitCode = 2;
  state.stopError = new Error("cleanup failed");
  await assert.rejects(upEmulatorSession("cleanup-fail", {
    stateDirectory: directory,
    init: { command: "seed" },
  }), (error) => error instanceof AggregateError && /Failed to start emulator session/.test(error.message));
});

test("executes a validated persistent session and rejects stale or mismatched containers", async (t) => {
  const directory = await makeStateDirectory(t);
  state.records.set("ci-tests", runningRecord());
  state.commandExitCode = 7;
  assert.equal(await execEmulatorSession("ci-tests", "node", ["check.js"], { region: "eu-west-1", sdks: ["rust"] }), 7);
  const command = state.calls.find(([kind]) => kind === "runCommand");
  assert.equal(command[1], "node");
  assert.deepEqual(command[2], ["check.js"]);
  assert.equal(command[3].AWS_REGION, "eu-west-1");
  assert.equal(command[3].SSL_CERT_FILE, command[3].AWS_EMULATOR_CA_FILE);

  await assert.rejects(execEmulatorSession("ci-tests", "", [], {}), /A command is required/);
  state.records.set("ci-tests", { ...runningRecord(), state: "starting" });
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /still starting/);
  state.records.set("ci-tests", runningRecord());
  state.dockerError = Object.assign(new Error("missing"), { missingKind: "container" });
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /is stale/);
  state.dockerError = undefined;
  state.containerDetails = "ffffffffffff|true|true|ci-tests";
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /no longer matches/);
  state.containerDetails = "a1b2c3d4e5f6|false|true|ci-tests";
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /is not running/);
});

test("rejects session containers with invalid ownership or identifier details", async (t) => {
  const directory = await makeStateDirectory(t);
  state.records.set("ci-tests", runningRecord());
  state.containerDetails = "a1b2c3d4e5f6|true|false|ci-tests";
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /not owned/);
  state.containerDetails = "invalid|true|true|ci-tests";
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /invalid session details/);
  await assert.rejects(execEmulatorSession("UpperCase", "node", [], { stateDirectory: directory }), /Invalid session name/);
  await assert.rejects(execEmulatorSession("missing", "node", [], { stateDirectory: directory }), /was not found/);
});

test("passes emulator credentials from a legacy session file", async (t) => {
  const directory = await makeStateDirectory(t);
  const portDirectory = path.join(directory, "43210");
  await mkdir(portDirectory, { recursive: true });
  await writeFile(path.join(portDirectory, "emulator_credentials"), "[default]\naws_access_key_id = legacy-key\naws_secret_access_key = legacy-secret\n");
  state.records.set("ci-tests", runningRecord("ci-tests", { schemaVersion: 1, port: 43210, containerPort: undefined }));
  await execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory, credentials: "environment" });
  const command = state.calls.find(([kind]) => kind === "runCommand");
  assert.equal(command[3].AWS_ACCESS_KEY_ID, "legacy-key");
  assert.equal(command[3].AWS_SHARED_CREDENTIALS_FILE, path.join(portDirectory, "emulator_credentials"));
});

test("stops and removes persistent sessions according to owner and container state", async (t) => {
  const directory = await makeStateDirectory(t);
  const starting = { schemaVersion: 1, name: "ci-tests", state: "starting", containerName: "awesome-emulator-cli-session-test-ci-tests", ownerPid: 123, ownerStartMarker: "test" };
  state.records.set("ci-tests", starting);
  await assert.rejects(downEmulatorSession("ci-tests", { stateDirectory: directory }), /still starting/);
  state.ownerRunning = false;
  state.dockerError = Object.assign(new Error("missing"), { missingKind: "container" });
  await downEmulatorSession("ci-tests", { stateDirectory: directory });
  assert.equal(state.records.has("ci-tests"), false);
  assert.equal(state.calls.some(([kind]) => kind === "stopContainer"), false);

  state.records.set("ci-tests", runningRecord());
  state.dockerError = undefined;
  state.containerDetails = "a1b2c3d4e5f6|false|true|ci-tests";
  await downEmulatorSession("ci-tests", { stateDirectory: directory });
  assert.equal(state.calls.at(-2)[0], "stopContainer");
  assert.equal(state.records.has("ci-tests"), false);
  await assert.rejects(downEmulatorSession("Upper", { stateDirectory: directory }), /Invalid session name/);
});

test("runs a command with a temporary emulator and preserves cleanup", async (t) => {
  const directory = await makeStateDirectory(t);
  state.commandExitCode = 11;
  assert.equal(await runWithEmulator("node", ["check.js"], {
    stateDirectory: directory,
    port: 43210,
    region: "ap-southeast-2",
    sdks: ["dotnet"],
  }), 11);
  const command = state.calls.find(([kind]) => kind === "runCommand");
  assert.equal(command[3].AWS_REGION, "ap-southeast-2");
  assert.equal(command[3].SSL_CERT_FILE, command[3].AWS_EMULATOR_CA_FILE);
  assert.ok(state.calls.some(([kind]) => kind === "stopContainer"));
  await assert.rejects(runWithEmulator("", []), /A command is required/);
});

test("waits for a healthy TLS endpoint and checks the certificate on the selected port", async (t) => {
  const directory = await makeStateDirectory(t);
  state.invokeHealthCheck = true;
  const emulator = await startEmulator({ stateDirectory: directory, port: 0, startupTimeoutMs: 1000 });
  assert.equal(emulator.port, state.publishedPort);
  assert.equal(state.healthRequests.length, 1);
  const request = state.healthRequests[0];
  assert.equal(request.hostname, "127.0.0.1");
  assert.equal(request.port, state.publishedPort);
  assert.equal(request.path, "/__admin/health");
  assert.deepEqual(request.ca, Buffer.from("test CA"));
  assert.equal(request.timeout, 1000);
  assert.equal(request.signal, undefined);
  assert.equal(state.calls.some(([kind, args]) => kind === "docker" && args[0] === "inspect" && args[2] === "{{.State.Running}}"), false);
  await emulator.stop();
});

test("reports early container exit and startup timeouts with Docker logs", async (t) => {
  const directory = await makeStateDirectory(t);
  state.invokeHealthCheck = true;
  state.healthContainerRunning = false;
  state.healthBehavior = "error";
  state.containerLogs = "container exited with code 42";
  await assert.rejects(startEmulator({ stateDirectory: directory, port: 43210, startupTimeoutMs: 1000 }), /container exited before becoming healthy\.\ncontainer exited with code 42/);

  state.healthContainerRunning = true;
  await assert.rejects(startEmulator({ stateDirectory: directory, port: 43210, startupTimeoutMs: 1000 }), /did not become healthy within 1000 ms\.\ncontainer exited with code 42/);
  assert.ok(state.calls.some(([kind, args]) => kind === "docker" && args[0] === "logs"));
});

test("handles unsuccessful health responses, timed out requests, and a missing certificate", async (t) => {
  const directory = await makeStateDirectory(t);
  state.invokeHealthCheck = true;
  state.healthStatus = 503;
  await assert.rejects(startEmulator({ stateDirectory: directory, port: 43210, startupTimeoutMs: 1000 }), /did not become healthy/);

  state.healthStatus = 200;
  state.healthBody = "not ready";
  await assert.rejects(startEmulator({ stateDirectory: directory, port: 43210, startupTimeoutMs: 1000 }), /did not become healthy/);

  state.healthBehavior = "timeout";
  await assert.rejects(startEmulator({ stateDirectory: directory, port: 43210, startupTimeoutMs: 1000 }), /did not become healthy/);

  state.healthBehavior = "success";
  state.writeHealthCertificate = false;
  await assert.rejects(startEmulator({ stateDirectory: directory, port: 43210, startupTimeoutMs: 1000 }), /did not become healthy/);
});

test("propagates non-missing certificate and Docker inspection errors", async (t) => {
  const directory = await makeStateDirectory(t);
  state.invokeHealthCheck = true;
  state.writeHealthCertificate = "directory";
  await assert.rejects(startEmulator({ stateDirectory: directory, port: 43210, startupTimeoutMs: 1000 }), { code: "EISDIR" });

  const missingContainerDirectory = await makeStateDirectory(t);
  state.writeHealthCertificate = true;
  state.healthBehavior = "error";
  state.dockerError = Object.assign(new Error("container was removed"), { missingKind: "container" });
  await assert.rejects(startEmulator({ stateDirectory: missingContainerDirectory, port: 43210, startupTimeoutMs: 1000 }), /container exited before becoming healthy/);

  const daemonError = new Error("Docker inspection failed");
  state.dockerError = daemonError;
  await assert.rejects(startEmulator({ stateDirectory: missingContainerDirectory, port: 43210, startupTimeoutMs: 1000 }), (error) => error === daemonError);
});

test("rejects session containers with mismatched names, missing identifiers, and inspection errors", async (t) => {
  const directory = await makeStateDirectory(t);
  state.records.set("ci-tests", runningRecord());
  state.containerDetails = "a1b2c3d4e5f6|true|true|another-session";
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /not owned/);

  state.containerDetails = "|true|true|ci-tests";
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), /invalid session details/);

  const daemonError = new Error("Docker inspect failed");
  state.dockerError = daemonError;
  await assert.rejects(execEmulatorSession("ci-tests", "node", [], { stateDirectory: directory }), (error) => error === daemonError);
});
