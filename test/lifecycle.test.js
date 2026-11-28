import assert from "node:assert/strict";
import test from "node:test";
import { createRetryableStop, startContainer, stopContainer, withEmulator } from "../dist/container-lifecycle.js";
import { throwIfAborted } from "../dist/docker.js";
import { runCommand } from "../dist/process.js";

test("stops the emulator when a child command exits unsuccessfully", async () => {
  let stopCalls = 0;
  const result = await withEmulator(
    async () => ({ stop: async () => { stopCalls += 1; } }),
    async () => runCommand(process.execPath, ["-e", "process.exit(23)"], process.env),
  );

  assert.equal(result, 23);
  assert.equal(stopCalls, 1);
});

test("cleans up a partially started container when startup is interrupted", async () => {
  const controller = new AbortController();
  const dockerCalls = [];
  const runDocker = async (args, options = {}) => {
    dockerCalls.push(args);
    if (args[0] === "run") {
      assert.equal(options.signal, controller.signal);
      controller.abort("SIGINT");
      throwIfAborted(controller.signal);
    }
    return "";
  };

  await assert.rejects(
    startContainer("awesome-emulator-test", ["run", "--detach"], controller.signal, async () => {}, runDocker),
    { name: "AbortError" },
  );
  assert.deepEqual(dockerCalls, [
    ["run", "--detach"],
    ["stop", "--time", "10", "awesome-emulator-test"],
    ["rm", "--force", "awesome-emulator-test"],
  ]);
});

test("reports failed container removal and allows stop to be retried", async () => {
  let removeCalls = 0;
  const runDocker = async (args) => {
    if (args[0] === "stop") return "";
    removeCalls += 1;
    if (removeCalls === 1) throw new Error("Docker daemon is unavailable");
    return "";
  };
  const stop = createRetryableStop(() => stopContainer("container-id", runDocker));

  await assert.rejects(stop(), AggregateError);
  await stop();
  await stop();
  assert.equal(removeCalls, 2);
});

test("stops containers idempotently when Docker already removed them", async () => {
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    throw Object.assign(new Error("No such container: old-id"), { missingKind: "container" });
  };
  await stopContainer("old-id", runDocker);
  assert.deepEqual(calls, [["stop", "--time", "10", "old-id"]]);

  await stopContainer("removed-before-rm", async (args) => {
    if (args[0] === "rm") throw new Error("No such container: removed-before-rm");
    return "";
  });
});

test("removes a container after stop fails and aggregates a second failure", async () => {
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    if (args[0] === "stop") throw new Error("stop failed");
    return "";
  };
  await stopContainer("container-id", runDocker);
  assert.deepEqual(calls.map(([command]) => command), ["stop", "rm"]);

  const removeError = new Error("remove failed");
  await assert.rejects(stopContainer("container-id", async (args) => {
    if (args[0] === "stop") throw new Error("stop failed");
    throw removeError;
  }), (error) => error instanceof AggregateError
    && error.errors[0].message === "stop failed"
    && error.errors[1] === removeError);
});

test("starts a healthy container and cleans up each startup failure", async () => {
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    return args[0] === "run" ? "container-id" : "";
  };
  assert.equal(await startContainer("container-name", ["run"], undefined, async (id) => {
    assert.equal(id, "container-id");
  }, runDocker), "container-id");

  const emptyIdCalls = [];
  await assert.rejects(startContainer("empty-id", ["run"], undefined, async () => {}, async (args) => {
    emptyIdCalls.push(args);
    return "";
  }), /did not return a container ID/);
  assert.deepEqual(emptyIdCalls.map(([command]) => command), ["run", "stop", "rm"]);

  const healthError = new Error("health check failed");
  const cleanupCalls = [];
  await assert.rejects(startContainer("container-name", ["run"], undefined, async () => {
    throw healthError;
  }, async (args) => {
    cleanupCalls.push(args);
    return "container-id";
  }), (error) => error === healthError);
  assert.deepEqual(cleanupCalls.map(([command]) => command), ["run", "stop", "rm"]);
});

test("aggregates startup and cleanup errors and retries after rejection", async () => {
  const startupError = new Error("startup failed");
  const cleanupError = new Error("cleanup failed");
  await assert.rejects(startContainer("container-name", ["run"], undefined, async () => {
    throw startupError;
  }, async (args) => {
    if (args[0] === "run") return "container-id";
    throw cleanupError;
  }), (error) => error instanceof AggregateError
    && error.errors[0] === startupError
    && error.errors[1] instanceof AggregateError
    && error.errors[1].errors[0] === cleanupError);

  let calls = 0;
  const stop = createRetryableStop(async () => {
    calls += 1;
    if (calls === 1) throw new Error("first attempt failed");
  });
  await assert.rejects(stop(), /first attempt failed/);
  await stop();
  assert.equal(calls, 2);
});

test("formats non-Error startup failures when cleanup also fails", async () => {
  await assert.rejects(startContainer("container-name", ["run"], undefined, async () => {
    throw "startup returned a string failure";
  }, async (args) => {
    if (args[0] === "run") return "container-id";
    throw new Error("cleanup failed");
  }), (error) => error instanceof AggregateError
    && error.message.includes("startup returned a string failure")
    && error.message.includes("cleanup also failed"));
});

test("stops a session when its callback throws and does not run after startup fails", async () => {
  let stopped = 0;
  const callbackError = new Error("callback failed");
  await assert.rejects(withEmulator(
    async () => ({ stop: async () => { stopped += 1; } }),
    async () => { throw callbackError; },
  ), (error) => error === callbackError);
  assert.equal(stopped, 1);

  await assert.rejects(withEmulator(async () => { throw new Error("start failed"); }, async () => assert.fail("run should not start")), /start failed/);
});
