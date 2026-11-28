import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatPortBinding,
  getPublishedPort,
  parsePublishedPort,
  reserveContainerPort,
} from "../dist/container-ports.js";

test("publishes a Docker-selected host port on loopback for port zero", () => {
  assert.equal(formatPortBinding(0, 51234), "127.0.0.1::51234");
  assert.equal(formatPortBinding(9297, 51234), "127.0.0.1:9297:51234");
});

test("reads and validates Docker's published host port", async () => {
  const calls = [];
  const runDocker = async (args, options) => {
    calls.push({ args, options });
    return "54321";
  };

  assert.equal(await getPublishedPort("container-id", 51234, undefined, runDocker), 54321);
  assert.deepEqual(calls, [{
    args: [
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "51234/tcp") 0).HostPort}}',
      "container-id",
    ],
    options: { capture: true, signal: undefined },
  }]);
  for (const value of ["", "<no value>", "0", "65536", "50000.5"]) {
    assert.throws(() => parsePublishedPort(value, 51234), /valid host port/);
  }
});

test("reserves distinct state-directory ports for concurrent containers", async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-port-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));

  const firstPort = await reserveContainerPort(stateDirectory);
  const secondPort = await reserveContainerPort(stateDirectory);
  assert.notEqual(firstPort, secondPort);
  for (const port of [firstPort, secondPort]) {
    assert.ok(port >= 49_152 && port <= 65_535);
    assert.equal((await stat(path.join(stateDirectory, String(port)))).isDirectory(), true);
  }
});
