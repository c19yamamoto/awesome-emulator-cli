import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runWithEmulator, startEmulator } from "../dist/index.js";
import { resolveEmulatorCredentialsMode, resolveEmulatorStateDirectory } from "../dist/emulator-options.js";

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

test("resolves credentials modes and their default from one supported list", () => {
  assert.equal(resolveEmulatorCredentialsMode(undefined), "files");
  assert.equal(resolveEmulatorCredentialsMode("environment"), "environment");
  assert.throws(() => resolveEmulatorCredentialsMode("invalid"), /files or environment/);
});

test("uses the shared default state-directory path parts", () => {
  assert.equal(
    resolveEmulatorStateDirectory(undefined, {}, "/home/test", "/workspace"),
    path.resolve("/home/test/.aws/emulator"),
  );
});

test("rejects an empty child region before requiring Docker", async () => {
  await assert.rejects(runWithEmulator("echo", [], { region: "   " }), /Region must not be empty/);
});

test("CLI help works without Docker", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /awesome-emulator run/);
  assert.match(result.stdout, /--region <region>/);
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
  assert.match(result.stderr, /--sdk can only be used with the run or exec command/);
  assert.doesNotMatch(result.stderr, /Docker was not found/);
});

test("CLI only accepts --region with run", () => {
  const result = spawnSync(process.execPath, [cliPath, "start", "--region", "ap-northeast-1"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--region can only be used with the run or exec command/);
  assert.doesNotMatch(result.stderr, /Docker was not found/);
});

test("CLI accepts --region before the child command", () => {
  const result = spawnSync(process.execPath, [cliPath, "run", "--region", "ap-northeast-1"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: awesome-emulator run/);
  assert.doesNotMatch(result.stderr, /Unknown option|Docker was not found/);
});

test("persistent session commands require a session name before Docker startup", () => {
  for (const command of ["up", "exec", "down"]) {
    const result = spawnSync(process.execPath, [cliPath, command], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`--session is required with the ${command} command`));
    assert.doesNotMatch(result.stderr, /Docker was not found/);
  }
});

test("exec accepts session-specific child options without requiring Docker when no command is given", () => {
  const result = spawnSync(process.execPath, [cliPath, "exec", "--session", "ci-tests", "--region", "ap-northeast-1"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: awesome-emulator exec/);
  assert.doesNotMatch(result.stderr, /Unknown option|Docker was not found/);
});

test("up requires a command after --init", () => {
  const result = spawnSync(process.execPath, [cliPath, "up", "--session", "ci-tests", "--init", "--"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: awesome-emulator up .*--init/);
  assert.doesNotMatch(result.stderr, /Docker was not found/);
});

test("up only accepts child command options when --init is enabled", () => {
  const result = spawnSync(process.execPath, [cliPath, "up", "--session", "ci-tests", "--region", "ap-northeast-1"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Child command options and arguments for up require --init/);
  assert.doesNotMatch(result.stderr, /Docker was not found/);
});
