import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSessionOwnerRunning, readSession, removeSession, reserveSession, validateSessionName, writeRunningSession } from "../dist/session-store.js";

test("validates session names before using them as file names", () => {
  assert.equal(validateSessionName("ci-tests-1"), "ci-tests-1");
  for (const name of ["", "../other", "Uppercase", "-starts-with-dash", "ends-with-dash-"]) {
    assert.throws(() => validateSessionName(name), /Invalid session name/);
  }
});

test("reserves a session with restrictive permissions and rejects duplicate names", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = await reserveSession(directory, "ci-tests", "awesome-emulator-cli-session-abcd1234-ci-tests", () => "2026-11-28 00:00:00");

  const record = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(record.state, "starting");
  assert.equal(record.name, "ci-tests");
  assert.equal(typeof record.ownerStartMarker, "string");
  assert.ok(record.ownerStartMarker.length > 0);
  const originalTimeZone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Honolulu";
    assert.equal(isSessionOwnerRunning(record, () => record.ownerStartMarker), true);
    process.env.TZ = "Asia/Tokyo";
    assert.equal(isSessionOwnerRunning(record, () => record.ownerStartMarker), true);
    assert.equal(isSessionOwnerRunning({ ...record, ownerStartMarker: "different-process-start" }, () => record.ownerStartMarker), false);
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
  }
  await assert.rejects(
    reserveSession(directory, "ci-tests", "awesome-emulator-cli-session-efgh5678-ci-tests", () => "2026-11-28 00:00:00"),
    /already exists/,
  );
});

test("checks process ownership when the start marker is unavailable", () => {
  const record = {
    schemaVersion: 1,
    name: "ci-tests",
    state: "starting",
    containerName: "awesome-emulator-cli-session-abcd1234-ci-tests",
    ownerPid: 123,
    ownerStartMarker: "owner-start",
  };

  assert.throws(() => isSessionOwnerRunning(record, () => undefined, () => true), /Could not verify the owner process/);
  assert.equal(isSessionOwnerRunning(record, () => undefined, () => false), false);
});

test("continues to read legacy v1 running session records", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const containerName = "awesome-emulator-cli-session-abcd1234-ci-tests";
  await mkdir(path.join(directory, "sessions"));
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

test("round-trips v2 session records with separate host and container ports", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const containerName = "awesome-emulator-cli-session-abcd1234-ci-tests";
  await mkdir(path.join(directory, "sessions"));
  const record = {
    schemaVersion: 2,
    name: "ci-tests",
    state: "running",
    containerName,
    containerId: "a1b2c3d4e5f6",
    version: "1.0.757",
    port: 54321,
    containerPort: 51234,
  };

  await writeRunningSession(directory, record);
  assert.deepEqual(await readSession(directory, "ci-tests"), record);
});

test("rejects malformed session metadata across starting and running record boundaries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-invalid-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionsDirectory = path.join(directory, "sessions");
  await mkdir(sessionsDirectory);
  const filename = path.join(sessionsDirectory, "ci-tests.json");
  const writeRecord = async (record) => writeFile(filename, JSON.stringify(record));
  const containerName = "awesome-emulator-cli-session-abcd1234-ci-tests";
  const starting = {
    schemaVersion: 1,
    name: "ci-tests",
    state: "starting",
    containerName,
    ownerPid: 123,
    ownerStartMarker: "process-start",
  };
  const validRunning = {
    schemaVersion: 1,
    name: "ci-tests",
    state: "running",
    containerName,
    containerId: "a1b2c3d4e5f6",
    version: "1.0.1",
    port: 9297,
  };

  await writeRecord(starting);
  assert.deepEqual(await readSession(directory, "ci-tests"), starting);
  for (const candidate of [
    null,
    7,
    {},
    { ...starting, schemaVersion: 2 },
    { ...starting, ownerPid: "123" },
    { ...starting, ownerPid: -1 },
    { ...starting, ownerStartMarker: null },
    { ...starting, ownerStartMarker: "" },
    { ...starting, state: "unknown" },
    { ...validRunning, containerId: 123 },
    { ...validRunning, containerId: "invalid" },
    { ...validRunning, version: 1 },
    { ...validRunning, port: 9297.5 },
    { ...validRunning, port: 0 },
    { ...validRunning, port: 65_536 },
    { ...validRunning, schemaVersion: 3 },
    { ...validRunning, schemaVersion: 2, containerPort: "9297" },
    { ...validRunning, schemaVersion: 2, containerPort: 0 },
    { ...validRunning, schemaVersion: 2, containerPort: 65_536 },
    { ...validRunning, name: "another-session" },
    { ...validRunning, containerName: 123 },
    { ...validRunning, containerName: "foreign-container-ci-tests" },
    { ...validRunning, containerName: "awesome-emulator-cli-session-other-name" },
    { ...validRunning, state: "stopped" },
  ]) {
    await writeRecord(candidate);
    await assert.rejects(readSession(directory, "ci-tests"), /invalid metadata/);
  }

  await writeRecord(validRunning);
  assert.deepEqual(await readSession(directory, "ci-tests"), validRunning);
  await writeRecord({ ...validRunning, schemaVersion: 2, containerPort: 54321 });
  assert.equal((await readSession(directory, "ci-tests")).containerPort, 54321);
  await writeFile(filename, "{");
  await assert.rejects(readSession(directory, "ci-tests"), /invalid metadata/);
});

test("handles unavailable process markers and non-missing session file errors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-marker-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(reserveSession(directory, "ci-tests", "awesome-emulator-cli-session-abcd1234-ci-tests", () => undefined), /Could not identify the startup process/);

  const starting = {
    schemaVersion: 1,
    name: "ci-tests",
    state: "starting",
    containerName: "awesome-emulator-cli-session-abcd1234-ci-tests",
    ownerPid: 123,
    ownerStartMarker: "recorded-start",
  };
  assert.equal(isSessionOwnerRunning(starting, () => "same-start"), false);
  assert.equal(isSessionOwnerRunning(starting, () => undefined, () => false), false);
  assert.throws(() => isSessionOwnerRunning(starting, () => undefined, () => true), /Could not verify the owner process/);

  const blockedDirectory = path.join(directory, "blocked.json");
  await writeFile(blockedDirectory, "file");
  await assert.rejects(readSession(blockedDirectory, "ci-tests"), { code: "ENOTDIR" });
});

test("uses system process markers when available and detects absent owner processes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-system-marker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const containerName = "awesome-emulator-cli-session-abcd1234-ci-tests";

  try {
    const filename = await reserveSession(directory, "ci-tests", containerName);
    const record = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(record.ownerPid, process.pid);
    const markerResult = isSessionOwnerRunning({ ...record, ownerStartMarker: "different-process-start" });
    assert.equal(markerResult, false);
  } catch (error) {
    assert.match(String(error), /Could not identify the startup process/);
  }

  const absentOwner = {
    schemaVersion: 1,
    name: "ci-tests",
    state: "starting",
    containerName,
    ownerPid: 2_000_000_000,
    ownerStartMarker: "missing-process-start",
  };
  assert.equal(isSessionOwnerRunning(absentOwner), false);

  if (process.platform !== "win32") {
    assert.throws(() => isSessionOwnerRunning({ ...absentOwner, ownerPid: 0 }), /Could not verify the owner process/);
  }
});
