import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls = [];
let emulatorSession;
let startResult = 0;
let startError;

mock.module("../dist/index.js", {
  namedExports: {
    prepareEmulatorImage: async (options) => {
      calls.push(["prepare", options]);
      return "image:ready";
    },
    startEmulator: async (options) => {
      calls.push(["start", options]);
      if (startError) throw startError;
      return emulatorSession;
    },
    runWithEmulator: async (command, args, options) => {
      calls.push(["run", command, args, options]);
      return startResult;
    },
    upEmulatorSession: async (name, options) => {
      calls.push(["up", name, options]);
      return { name, version: "1.0.0", endpointUrl: "https://localhost" };
    },
    execEmulatorSession: async (name, command, args, options) => {
      calls.push(["exec", name, command, args, options]);
      return startResult;
    },
    downEmulatorSession: async (name, options) => {
      calls.push(["down", name, options]);
    },
  },
});

const { formatError, launchCli, runCli } = await import("../dist/cli.js");

function withConsole(method, callback) {
  const original = console[method];
  const values = [];
  console[method] = (...args) => values.push(args.join(" "));
  return Promise.resolve().then(callback).then((result) => ({ result, values })).finally(() => {
    console[method] = original;
  });
}

test.beforeEach(() => {
  calls.length = 0;
  startResult = 0;
  startError = undefined;
  emulatorSession = {
    version: "1.0.0",
    endpointUrl: "https://localhost",
    healthCheckUrl: "https://localhost/health",
    configFile: "/tmp/config",
    credentialsFile: "/tmp/credentials",
    caFile: "/tmp/ca.pem",
    environment: {},
    stop: async () => { calls.push(["stop"]); },
  };
});

test("prints help for help and an omitted command", async () => {
  const { values } = await withConsole("log", async () => {
    assert.equal(await runCli(["--help"], new AbortController().signal), 0);
    assert.equal(await runCli([], new AbortController().signal), 0);
    assert.equal(await runCli(["help"], new AbortController().signal), 0);
  });
  assert.equal(values.length, 3);
  assert.match(values[0], /awesome-emulator run/);
  assert.match(values[1], /--session <name>/);
});

test("runs a child with parsed options and returns its exit code", async () => {
  startResult = 17;
  assert.equal(await runCli(["run", "--region", "ap-northeast-1", "--shell", "--", "npm", "test"], new AbortController().signal), 17);
  assert.deepEqual(calls[0], ["run", "npm", ["test"], { region: "ap-northeast-1", shell: true, signal: calls[0][3].signal }]);
});

test("rejects missing child commands and unknown commands", async () => {
  await assert.rejects(runCli(["run"], new AbortController().signal), /Usage: awesome-emulator run/);
  await assert.rejects(runCli(["exec", "--session", "ci-tests"], new AbortController().signal), /Usage: awesome-emulator exec/);
  await assert.rejects(runCli(["down", "--session", "ci-tests", "--", "node"], new AbortController().signal), /does not accept child command arguments/);
  await assert.rejects(runCli(["rename"], new AbortController().signal), /Unknown command: rename/);
});

test("handles prepare and persistent-session commands", async () => {
  const { values } = await withConsole("log", async () => {
    assert.equal(await runCli(["prepare", "--backend", "native", "--version", "1.0.5"], new AbortController().signal), 0);
    assert.equal(await runCli(["up", "--session", "ci-tests", "--init", "--region", "us-west-2", "--", "node", "seed.js"], new AbortController().signal), 0);
    assert.equal(await runCli(["exec", "--session", "ci-tests", "--", "node", "check.js"], new AbortController().signal), 0);
    assert.equal(await runCli(["down", "--session", "ci-tests"], new AbortController().signal), 0);
  });
  assert.match(values[0], /image:ready/);
  assert.deepEqual(calls[0], ["prepare", { backend: "native", version: "1.0.5", signal: calls[0][1].signal }]);
  assert.equal(calls[1][2].init.command, "node");
  assert.deepEqual(calls[1][2].init.args, ["seed.js"]);
  assert.equal(calls[1][2].init.region, "us-west-2");
  assert.equal(calls[2][0], "exec");
  assert.equal(calls[3][0], "down");
});

test("starts an emulator, waits for cancellation, and always stops it", async () => {
  const controller = new AbortController();
  const { values } = await withConsole("log", async () => {
    const pending = runCli(["start"], controller.signal);
    controller.abort("SIGINT");
    return pending;
  });
  assert.equal(values.length, 0);
  assert.equal(calls[0][0], "start");
  assert.deepEqual(calls.at(-1), ["stop"]);
});

test("prints the started emulator settings before waiting for a signal", async () => {
  const controller = new AbortController();
  const { values } = await withConsole("log", async () => {
    const pending = runCli(["start", "--port", "12345"], controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort("SIGINT");
    return pending;
  });
  assert.match(values[0], /"endpointUrl": "https:\/\/localhost"/);
  assert.equal(calls[0][1].port, "12345");
  assert.deepEqual(calls.at(-1), ["stop"]);
});

test("reports signal exit codes and formats aggregate errors", async () => {
  const controller = new AbortController();
  emulatorSession.stop = async () => { calls.push(["stop"]); };
  const pending = runCli(["start"], controller.signal);
  controller.abort("SIGTERM");
  assert.equal(await pending, 143);
  assert.equal(formatError(new AggregateError([new Error("first"), "second"], "cleanup failed")), "cleanup failed\n  first\n  second");
  assert.equal(formatError(new AggregateError([], "no cleanup errors")), "no cleanup errors");
  assert.equal(formatError("plain failure"), "plain failure");
});

test("launchCli sets the process exit code and removes signal handlers", async () => {
  const originalExitCode = process.exitCode;
  const { values } = await withConsole("log", () => launchCli(["--help"]));
  assert.equal(process.exitCode, 0);
  assert.match(values[0], /awesome-emulator run/);
  process.exitCode = originalExitCode;
});

test("launchCli logs formatted failures and sets a nonzero process exit code", async () => {
  const originalExitCode = process.exitCode;
  const { values } = await withConsole("error", () => launchCli(["unknown"]));
  assert.equal(process.exitCode, 1);
  assert.match(values[0], /awesome-emulator: Unknown command: unknown/);
  process.exitCode = originalExitCode;
});

test("launchCli maps an abort error after its signal handler fires", async () => {
  const originalExitCode = process.exitCode;
  startError = Object.assign(new Error("operation aborted"), { name: "AbortError" });
  const pending = launchCli(["start"]);
  process.emit("SIGINT");
  await pending;
  assert.equal(process.exitCode, 130);
  process.exitCode = originalExitCode;
});

test("launchCli reports non-abort errors even after a signal has fired", async () => {
  const originalExitCode = process.exitCode;
  startError = new Error("startup failed");
  const { values } = await withConsole("error", async () => {
    const pending = launchCli(["start"]);
    process.emit("SIGINT");
    await pending;
  });
  assert.equal(process.exitCode, 1);
  assert.match(values[0], /awesome-emulator: startup failed/);
  process.exitCode = originalExitCode;
});

test("launchCli formats non-Error failures after cancellation", async () => {
  const originalExitCode = process.exitCode;
  startError = "plain startup failure";
  const { values } = await withConsole("error", async () => {
    const pending = launchCli(["start"]);
    process.emit("SIGINT");
    await pending;
  });
  assert.equal(process.exitCode, 1);
  assert.match(values[0], /awesome-emulator: plain startup failure/);
  process.exitCode = originalExitCode;
});
