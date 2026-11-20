import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("resolves nested npx packages when launched through npm exec --package", { skip: !enabled, timeout: 600_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-nested-npx-"));
  try {
    const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
    const cliPackageDirectory = path.join(tempDirectory, "cli-package");
    const fixturePackageDirectory = path.join(tempDirectory, "fixture-package");
    const packedCliDirectory = path.join(tempDirectory, "packed-cli");
    const packedFixtureDirectory = path.join(tempDirectory, "packed-fixture");
    const projectDirectory = path.join(tempDirectory, "project");
    const packCache = path.join(tempDirectory, "pack-cache");
    const launcherCache = path.join(tempDirectory, "launcher-cache");
    const childCache = path.join(tempDirectory, "child-cache");
    const fixtureName = "awesome-emulator-nested-npx-fixture";
    const fixtureVersion = "1.0.0";
    const fixtureTarball = path.join(packedFixtureDirectory, `${fixtureName}-${fixtureVersion}.tgz`);
    const cliManifest = JSON.parse(await readFile(path.join(repositoryDirectory, "package.json"), "utf8"));
    const cliTarball = path.join(packedCliDirectory, `${cliManifest.name}-${cliManifest.version}.tgz`);

    await Promise.all([
      mkdir(cliPackageDirectory, { recursive: true }),
      mkdir(fixturePackageDirectory, { recursive: true }),
      mkdir(packedCliDirectory, { recursive: true }),
      mkdir(packedFixtureDirectory, { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    await cp(path.join(repositoryDirectory, "bin"), path.join(cliPackageDirectory, "bin"), { recursive: true });
    await cp(path.join(repositoryDirectory, "dist"), path.join(cliPackageDirectory, "dist"), { recursive: true });
    await writeFile(path.join(cliPackageDirectory, "package.json"), JSON.stringify({
      name: cliManifest.name,
      version: cliManifest.version,
      type: cliManifest.type,
      bin: cliManifest.bin,
      files: ["bin/", "dist/"],
    }));
    await writeFile(path.join(fixturePackageDirectory, "package.json"), JSON.stringify({
      name: fixtureName,
      version: fixtureVersion,
      bin: { [fixtureName]: "./bin.js" },
    }));
    await writeFile(path.join(fixturePackageDirectory, "bin.js"), "#!/usr/bin/env node\nconsole.log(`nested-npx-ok:${process.argv.slice(2).join(' ')}`);\n", { mode: 0o755 });

    const npmEnvironment = { ...process.env };
    for (const key of Object.keys(npmEnvironment)) {
      if (["npm_config_package", "npm_config_cache"].includes(key.toLowerCase())) delete npmEnvironment[key];
    }
    npmEnvironment.npm_config_cache = packCache;
    const packCli = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packedCliDirectory], {
      cwd: cliPackageDirectory,
      env: npmEnvironment,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(packCli.status, 0, `could not pack CLI fixture:\n${packCli.stdout}\n${packCli.stderr}`);
    const packFixture = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packedFixtureDirectory], {
      cwd: fixturePackageDirectory,
      env: npmEnvironment,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(packFixture.status, 0, `could not pack nested npx fixture:\n${packFixture.stdout}\n${packFixture.stderr}`);
    await assert.rejects(access(childCache), { code: "ENOENT" }, "nested npx should start with an empty npm cache");

    const nestedNpxScript = [
      "const { spawnSync } = require('node:child_process')",
      "const [packageSpec, cache] = process.argv.slice(1)",
      "if (process.env.npm_config_package) process.exit(42)",
      "const env = { ...process.env, npm_config_cache: cache }",
      "const nested = spawnSync('npx', ['--yes', packageSpec, 'hello'], { env, encoding: 'utf8' })",
      "process.stdout.write(nested.stdout || '')",
      "process.stderr.write(nested.stderr || '')",
      "process.exit(nested.status ?? 1)",
    ].join("; ");
    const wrappedRun = spawnSync("npm", [
      "exec", "--yes", `--package=${cliTarball}`, "--",
      "awesome-emulator", "run", "--port", "0", "--telemetry", "off", "--",
      process.execPath, "-e", nestedNpxScript, `${fixtureName}@file:${fixtureTarball}`, childCache,
    ], {
      cwd: projectDirectory,
      env: { ...npmEnvironment, npm_config_cache: launcherCache },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 600_000,
    });

    assert.equal(wrappedRun.status, 0, `wrapped nested npx failed:\n${wrappedRun.stdout}\n${wrappedRun.stderr}`);
    assert.match(wrappedRun.stdout, /nested-npx-ok:hello/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
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
