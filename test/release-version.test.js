import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/check-release-version.js", import.meta.url));

test("release version check accepts a tag matching package.json", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: "v0.1.0" },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("release version check rejects a mismatched tag", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: "v9.9.9" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must match package version/);
});
