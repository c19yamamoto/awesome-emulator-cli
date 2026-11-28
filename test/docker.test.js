import assert from "node:assert/strict";
import test from "node:test";
import { DockerCommandError, isMissingDockerResource } from "../dist/docker.js";
import { ensureEmulatorImage } from "../dist/emulator-image.js";

const architecture = { docker: "amd64", rpm: "x86_64" };

test("classifies missing Docker resources from structured command output", () => {
  const missingImage = new DockerCommandError(
    ["image", "inspect", "awesome-emulator-cli:test"],
    1,
    null,
    "",
    "Error response from daemon: No such image: awesome-emulator-cli:test",
  );
  assert.equal(isMissingDockerResource(missingImage, "image"), true);
  assert.equal(isMissingDockerResource(missingImage, "container"), false);
  assert.equal(isMissingDockerResource(new Error("No such container: test"), "container"), true);
  assert.equal(isMissingDockerResource(new Error("Cannot connect to the Docker daemon"), "image"), false);
});

test("builds an image only when inspection reports that the image is missing", async () => {
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    if (args[0] === "image") {
      throw new DockerCommandError(args, 1, null, "", "Error response from daemon: No such image: cached-tag");
    }
    return "";
  };

  const image = await ensureEmulatorImage("1.2.3", architecture, undefined, runDocker);
  assert.match(image, /^awesome-emulator-cli:1\.2\.3-amd64-/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["image", "inspect"]);
  assert.equal(calls[1][0], "build");
});

test("surfaces Docker daemon errors without attempting an image build", async () => {
  const calls = [];
  const daemonError = new DockerCommandError(
    ["image", "inspect", "awesome-emulator-cli:test"],
    1,
    null,
    "",
    "Cannot connect to the Docker daemon",
  );
  const runDocker = async (args) => {
    calls.push(args);
    throw daemonError;
  };

  await assert.rejects(ensureEmulatorImage("1.2.3", architecture, undefined, runDocker), (error) => error === daemonError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "image");
});
