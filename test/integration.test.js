import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import https from "node:https";
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
    const session = await upEmulatorSession(name, {
      port: 0,
      telemetry: "off",
      startupTimeoutMs: 300_000,
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
