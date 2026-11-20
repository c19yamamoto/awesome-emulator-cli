import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downEmulatorSession, execEmulatorSession, startEmulator, upEmulatorSession } from "../dist/index.js";

const enabled = process.env.AWS_EMULATOR_INTEGRATION_TESTS === "1";

function getHealth(url, ca) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { ca, timeout: 3000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: body.trim() }));
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("health request timed out")));
  });
}

test("starts AWS Emulator in Docker and returns usable connection settings", { skip: !enabled }, async () => {
  const emulator = await startEmulator({
    port: 0,
    telemetry: "off",
    startupTimeoutMs: 300_000,
  });

  try {
    assert.equal(emulator.environment.AWS_ENDPOINT_URL, emulator.endpointUrl);
    assert.match(emulator.endpointUrl, /^https:\/\/127\.0\.0\.1:\d+$/);
    await Promise.all([
      access(emulator.configFile),
      access(emulator.credentialsFile),
      access(emulator.caFile),
    ]);

    const ca = await readFile(emulator.caFile);
    const health = await getHealth(emulator.healthCheckUrl, ca);
    assert.deepEqual(health, { statusCode: 200, body: "ok" });
  } finally {
    await emulator.stop();
  }
});

test("keeps a named emulator session available across child commands", { skip: !enabled }, async () => {
  const name = `integration-${randomUUID()}`;
  let started = false;
  try {
    const initializer = [
      "const fs = require('node:fs')",
      "const https = require('node:https')",
      "if (process.argv[1] !== 'seed-marker' || process.argv[2] !== 'seed-value' || !process.env.AWS_SHARED_CREDENTIALS_FILE || process.env.AWS_REGION !== 'ap-northeast-1' || process.env.AWS_DEFAULT_REGION !== 'ap-northeast-1') process.exit(1)",
      "https.get(process.env.AWS_ENDPOINT_URL + '/__admin/health', { ca: fs.readFileSync(process.env.AWS_CA_BUNDLE) }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk }); response.on('end', () => { if (response.statusCode !== 200 || body.trim() !== 'ok') process.exitCode = 1 }) }).on('error', () => { process.exitCode = 1 })",
    ].join("; ");
    const session = await upEmulatorSession(name, {
      port: 0,
      telemetry: "off",
      startupTimeoutMs: 300_000,
      init: {
        command: process.execPath,
        args: ["-e", initializer, "seed-marker", "seed-value"],
        region: "ap-northeast-1",
      },
    });
    started = true;
    assert.equal(session.name, name);
    assert.match(session.endpointUrl, /^https:\/\/127\.0\.0\.1:\d+$/);

    const checkEnvironment = "if (!process.env.AWS_ENDPOINT_URL || !process.env.AWS_SHARED_CREDENTIALS_FILE || !process.env.AWS_CA_BUNDLE || process.env.AWS_REGION !== 'ap-northeast-1' || process.env.AWS_DEFAULT_REGION !== 'ap-northeast-1') process.exit(1)";
    assert.equal(await execEmulatorSession(name, process.execPath, ["-e", checkEnvironment], { region: "ap-northeast-1" }), 0);
    assert.equal(await execEmulatorSession(name, process.execPath, ["-e", checkEnvironment], { region: "ap-northeast-1" }), 0);
  } finally {
    if (started) await downEmulatorSession(name);
  }
});

test("cleans up a persistent session when initialization fails", { skip: !enabled }, async () => {
  const name = `integration-${randomUUID()}`;
  await assert.rejects(upEmulatorSession(name, {
    port: 0,
    telemetry: "off",
    startupTimeoutMs: 300_000,
    init: { command: process.execPath, args: ["-e", "process.exit(17)"] },
  }), /initialization command failed with exit code 17/);
  await assert.rejects(downEmulatorSession(name), /was not found/);
});

test("preserves signal cancellation and cleans up during initialization", { skip: !enabled }, async () => {
  const name = `integration-${randomUUID()}`;
  const marker = path.join(os.tmpdir(), `awesome-emulator-init-${randomUUID()}`);
  const controller = new AbortController();
  const starting = upEmulatorSession(name, {
    port: 0,
    telemetry: "off",
    startupTimeoutMs: 300_000,
    signal: controller.signal,
    init: {
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started'); setTimeout(() => {}, 30_000)", marker],
    },
  });

  try {
    const deadline = Date.now() + 300_000;
    const waitForMarker = async () => {
      while (Date.now() < deadline) {
        try {
          await access(marker);
          return true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return false;
    };
    const initialized = await Promise.race([
      waitForMarker(),
      starting.then(() => new Promise(() => {})),
    ]);
    assert.equal(initialized, true, "initializer should start after the emulator becomes healthy");
    controller.abort("SIGINT");
    await assert.rejects(starting, (error) => error instanceof Error && error.name === "AbortError");
    await assert.rejects(downEmulatorSession(name), /was not found/);
  } finally {
    controller.abort("SIGINT");
    await starting.catch(() => {});
    await rm(marker, { force: true });
  }
});
