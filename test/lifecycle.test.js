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
