import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSession, removeSession, reserveSession, validateSessionName, writeRunningSession } from "../dist/session-store.js";

test("validates session names before using them as file names", () => {
  assert.equal(validateSessionName("ci-tests-1"), "ci-tests-1");
  for (const name of ["", "../other", "Uppercase", "-starts-with-dash", "ends-with-dash-"]) {
    assert.throws(() => validateSessionName(name), /Invalid session name/);
  }
});

test("reserves a session with restrictive permissions and rejects duplicate names", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = await reserveSession(directory, "ci-tests", "awesome-emulator-cli-session-abcd1234-ci-tests");

  const record = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(record.state, "starting");
  assert.equal(record.name, "ci-tests");
  if (process.platform !== "win32") {
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
  }
  await assert.rejects(
    reserveSession(directory, "ci-tests", "awesome-emulator-cli-session-efgh5678-ci-tests"),
    /already exists/,
  );
});

test("updates and reads a running session record without credential values", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const containerName = "awesome-emulator-cli-session-abcd1234-ci-tests";
  await reserveSession(directory, "ci-tests", containerName);
  await writeRunningSession(directory, {
    schemaVersion: 1,
    name: "ci-tests",
    state: "running",
    containerName,
    containerId: "a1b2c3d4e5f6",
    version: "1.0.533",
    port: 9297,
  });

  assert.deepEqual(await readSession(directory, "ci-tests"), {
    schemaVersion: 1,
    name: "ci-tests",
    state: "running",
    containerName,
    containerId: "a1b2c3d4e5f6",
    version: "1.0.533",
    port: 9297,
  });
  await removeSession(directory, "ci-tests");
  await assert.rejects(readSession(directory, "ci-tests"), /was not found/);
});
