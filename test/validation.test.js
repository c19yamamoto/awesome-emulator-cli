import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startEmulator } from "../dist/index.js";

const cliPath = fileURLToPath(new URL("../bin/awesome-emulator.js", import.meta.url));

test("rejects an invalid version before requiring Docker", async () => {
  await assert.rejects(startEmulator({ version: "latest" }), /Invalid AWS Emulator version/);
});

test("rejects invalid ports before requiring Docker", async () => {
  await assert.rejects(startEmulator({ port: 65536 }), /Invalid port/);
});

test("rejects invalid telemetry settings before requiring Docker", async () => {
  await assert.rejects(startEmulator({ telemetry: "sometimes" }), /Invalid telemetry setting/);
});

test("rejects invalid memory limits before requiring Docker", async () => {
  await assert.rejects(startEmulator({ memory: "0g" }), /Invalid memory limit/);
});

test("rejects startup timeouts shorter than one second", async () => {
  await assert.rejects(startEmulator({ startupTimeoutMs: 999 }), /startupTimeoutMs/);
});

test("CLI help works without Docker", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /awesome-emulator run/);
});

test("CLI reports an invalid emulator version without starting Docker", () => {
  const result = spawnSync(process.execPath, [cliPath, "start", "--version", "latest"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid AWS Emulator version/);
  assert.doesNotMatch(result.stderr, /Docker was not found/);
});

test("CLI rejects an unsupported SDK without starting Docker", () => {
  const result = spawnSync(process.execPath, [cliPath, "run", "--sdk", "unknown", "--", "echo", "test"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported SDK: unknown/);
  assert.doesNotMatch(result.stderr, /Docker was not found/);
});

test("CLI only accepts SDK-specific TLS settings for run", () => {
  const result = spawnSync(process.execPath, [cliPath, "start", "--sdk", "java-v2"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--sdk can only be used with the run command/);
  assert.doesNotMatch(result.stderr, /Docker was not found/);
});
