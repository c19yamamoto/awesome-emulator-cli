import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import https from "node:https";
import test from "node:test";
import { startEmulator } from "../dist/index.js";

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
