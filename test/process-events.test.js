import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

const state = { behavior: undefined, calls: [] };

mock.module("node:child_process", {
  namedExports: {
    spawn: (...args) => {
      state.calls.push(args);
      const child = new EventEmitter();
      child.kill = (signal) => {
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      queueMicrotask(() => state.behavior?.(child));
      return child;
    },
  },
});

const { runCommand } = await import("../dist/process.js");

test.beforeEach(() => {
  state.behavior = undefined;
  state.calls = [];
});

test("returns child exit codes and maps an unknown signal termination to failure", async () => {
  state.behavior = (child) => child.emit("close", 23, null);
  assert.equal(await runCommand("fake-command", ["arg"], {}), 23);
  assert.equal(state.calls[0][2].shell, false);
  assert.equal(state.calls[0][2].windowsHide, false);

  state.behavior = (child) => child.emit("close", null, "SIGTERM");
  assert.equal(await runCommand("fake-command", [], {}), 1);

  state.behavior = (child) => child.emit("close", null, null);
  assert.equal(await runCommand("fake-command", [], {}), 1);
});

test("handles errors before close and ignores an error after close", async () => {
  const spawnError = new Error("child could not start");
  state.behavior = (child) => {
    child.emit("error", spawnError);
    child.emit("close", null, null);
  };
  await assert.rejects(runCommand("fake-command", [], {}), (error) => error === spawnError);

  state.behavior = (child) => {
    child.emit("close", 0, null);
    child.emit("error", new Error("late process error"));
  };
  assert.equal(await runCommand("fake-command", [], {}), 0);
});

test("forwards fallback and pre-existing abort signals once", async () => {
  const controller = new AbortController();
  const running = runCommand("fake-command", [], {}, controller.signal);
  controller.abort("caller cancelled");
  process.emit("SIGTERM");
  assert.equal(await running, 143);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort("not a signal name");
  assert.equal(await runCommand("fake-command", [], {}, alreadyAborted.signal), 143);
  assert.equal(state.calls[1][2].shell, false);
});

test("removes the abort listener after a child exits normally", async () => {
  const controller = new AbortController();
  state.behavior = (child) => child.emit("close", 0, null);
  assert.equal(await runCommand("fake-command", [], {}, controller.signal), 0);
  controller.abort("late cancellation");
  assert.equal(state.calls.length, 1);
});
