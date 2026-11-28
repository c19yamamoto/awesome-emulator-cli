import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";

const state = { behavior: undefined, calls: [], streamMode: "both" };

mock.module("node:child_process", {
  namedExports: {
    spawn: (...args) => {
      state.calls.push(args);
      const child = new EventEmitter();
      child.stdout = state.streamMode === "stderr-only" ? undefined : new PassThrough();
      child.stderr = state.streamMode === "stdout-only" ? undefined : new PassThrough();
      queueMicrotask(() => state.behavior?.(child));
      return child;
    },
  },
});

const { DockerCommandError, docker, isMissingDockerResource, throwIfAborted } = await import("../dist/docker.js");
const { ensureEmulatorImage, getArchitecture } = await import("../dist/emulator-image.js");
const architecture = { docker: "amd64", rpm: "x86_64" };

test.beforeEach(() => {
  state.behavior = undefined;
  state.calls = [];
  state.streamMode = "both";
});

test("captures Docker output and trims successful results", async () => {
  state.behavior = (child) => {
    child.stdout.write("  container-id\n");
    child.stderr.write("diagnostic\n");
    child.emit("close", 0, null);
  };

  assert.equal(await docker(["inspect", "container-id"], { capture: true }), "container-id");
  assert.deepEqual(state.calls[0], ["docker", ["inspect", "container-id"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }]);
});

test("uses inherited stdio and resolves empty output on success", async () => {
  state.behavior = (child) => child.emit("close", 0, null);
  assert.equal(await docker(["version"]), "");
  assert.equal(state.calls[0][2].stdio, "inherit");
});

test("handles Docker children without capture streams and passes abort signals", async () => {
  const signal = new AbortController().signal;
  state.streamMode = "stderr-only";
  state.behavior = (child) => child.emit("close", 0, null);
  assert.equal(await docker(["version"], { capture: true, signal }), "");
  assert.equal(state.calls[0][2].signal, signal);

  state.streamMode = "stdout-only";
  state.behavior = (child) => child.emit("close", 0, null);
  assert.equal(await docker(["version"], { capture: true }), "");
});

test("preserves command output, exit code, and signal in Docker errors", async () => {
  state.behavior = (child) => {
    child.stdout.write("stdout detail");
    child.stderr.write("stderr detail");
    child.emit("close", 17, null);
  };
  await assert.rejects(docker(["run", "image"], { capture: true }), (error) => {
    assert.ok(error instanceof DockerCommandError);
    assert.equal(error.exitCode, 17);
    assert.equal(error.signal, null);
    assert.equal(error.stdout, "stdout detail");
    assert.equal(error.stderr, "stderr detail");
    assert.match(error.message, /docker run failed with exit code 17/);
    assert.match(error.message, /stderr detail/);
    return true;
  });

  state.behavior = (child) => child.emit("close", null, "SIGTERM");
  await assert.rejects(docker(["stop", "container"]), /docker stop failed \(SIGTERM\)/);

  state.behavior = (child) => {
    child.stdout.write("stdout only");
    child.emit("close", 2, null);
  };
  await assert.rejects(docker(["image", "inspect"], { capture: true }), /stdout only/);

  state.behavior = (child) => child.emit("close", 1, null);
  await assert.rejects(docker(["rm", "missing"]), /docker rm failed with exit code 1\./);
});

test("maps a missing Docker executable and preserves other spawn errors", async () => {
  const missing = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  state.behavior = (child) => child.emit("error", missing);
  await assert.rejects(docker(["version"]), /Docker was not found/);

  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  state.behavior = (child) => {
    child.emit("error", denied);
    child.emit("close", null, null);
  };
  await assert.rejects(docker(["version"]), (error) => error === denied);
});

test("classifies missing Docker resources from errors and plain values", () => {
  assert.equal(isMissingDockerResource(new DockerCommandError([], 1, null, "", "No such container"), "container"), true);
  assert.equal(isMissingDockerResource(new DockerCommandError([], 1, null, "No such object", ""), "image"), true);
  assert.equal(isMissingDockerResource(new Error("no such image"), "image"), true);
  assert.equal(isMissingDockerResource({ message: "no such container" }, "container"), false);
  assert.equal(isMissingDockerResource(new Error("connection refused"), "container"), false);
});

test("throws the abort reason or a named fallback error", () => {
  assert.equal(throwIfAborted(), undefined);
  assert.equal(throwIfAborted(new AbortController().signal), undefined);
  const reason = new Error("cancelled by caller");
  const withErrorReason = new AbortController();
  withErrorReason.abort(reason);
  assert.throws(() => throwIfAborted(withErrorReason.signal), (error) => error === reason);

  const withTextReason = new AbortController();
  withTextReason.abort("SIGTERM");
  assert.throws(() => throwIfAborted(withTextReason.signal), { name: "AbortError", message: /SIGTERM/ });
  assert.throws(() => throwIfAborted({ aborted: true, reason: undefined }), { name: "AbortError", message: "Operation aborted." });
});

test("builds an emulator image when the cache misses", async () => {
  const calls = [];
  const runDocker = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === "image") throw new DockerCommandError(args, 1, null, "", "No such image");
    assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(`${args.at(-1)}/Dockerfile`, "utf8")).then((contents) => contents.includes("gpgv --keyring")), true);
    return "";
  };
  const image = await ensureEmulatorImage("1.2.3", architecture, undefined, runDocker);
  assert.match(image, /^awesome-emulator-cli:1\.2\.3-amd64-/);
  assert.deepEqual(calls.map(({ args }) => args[0]), ["image", "build"]);
  assert.deepEqual(calls[0].options, { capture: true, signal: undefined });
  assert.equal(calls[1].options.signal, undefined);
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(calls[1].args.at(-1))), { code: "ENOENT" });
});

test("reuses cached images and propagates unrelated inspection errors", async () => {
  const calls = [];
  const cached = await ensureEmulatorImage("1.2.3", architecture, undefined, async (args) => {
    calls.push(args);
    return "";
  });
  assert.match(cached, /^awesome-emulator-cli:1\.2\.3-amd64-/);
  assert.deepEqual(calls.map(([command]) => command), ["image"]);

  const daemonError = new Error("Docker daemon unavailable");
  await assert.rejects(ensureEmulatorImage("1.2.3", architecture, undefined, async () => {
    throw daemonError;
  }), (error) => error === daemonError);
});

test("checks cancellation before inspection, after inspection, and after building", async () => {
  const before = new AbortController();
  before.abort("SIGINT");
  let calls = 0;
  await assert.rejects(ensureEmulatorImage("1.2.3", architecture, before.signal, async () => {
    calls += 1;
    return "";
  }), { name: "AbortError" });
  assert.equal(calls, 0);

  const duringInspect = new AbortController();
  await assert.rejects(ensureEmulatorImage("1.2.3", architecture, duringInspect.signal, async () => {
    duringInspect.abort("SIGTERM");
    return "";
  }), { name: "AbortError" });

  const duringBuild = new AbortController();
  let buildContext;
  await assert.rejects(ensureEmulatorImage("1.2.3", architecture, duringBuild.signal, async (args) => {
    if (args[0] === "image") throw new DockerCommandError(args, 1, null, "", "No such image");
    buildContext = args.at(-1);
    duringBuild.abort("SIGTERM");
    return "";
  }), { name: "AbortError" });
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(buildContext)), { code: "ENOENT" });
});

test("maps supported architectures and rejects unknown ones", () => {
  assert.deepEqual(getArchitecture("x64"), architecture);
  assert.deepEqual(getArchitecture("arm64"), { docker: "arm64", rpm: "aarch64" });
  assert.throws(() => getArchitecture("ia32"), /not available for this architecture/);
});
