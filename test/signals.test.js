import assert from "node:assert/strict";
import test from "node:test";
import { FORWARDED_SIGNALS, getSignalExitCode, isForwardedSignal } from "../dist/signals.js";

test("recognizes each forwarded signal and maps its conventional exit status", () => {
  assert.deepEqual(FORWARDED_SIGNALS, ["SIGINT", "SIGTERM", "SIGHUP"]);
  assert.equal(isForwardedSignal("SIGHUP"), true);
  assert.equal(isForwardedSignal("SIGINT"), true);
  assert.equal(isForwardedSignal("SIGTERM"), true);
  assert.equal(getSignalExitCode("SIGHUP"), 129);
  assert.equal(getSignalExitCode("SIGINT"), 130);
  assert.equal(getSignalExitCode("SIGTERM"), 143);
});

test("rejects non-signal values without coercing them", () => {
  for (const value of [undefined, null, 15, {}, "SIGKILL", "sigint"]) {
    assert.equal(isForwardedSignal(value), false);
    assert.equal(getSignalExitCode(value), 1);
  }
});
