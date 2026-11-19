import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/check-release-version.js", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("release version check accepts a tag matching package.json", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: `v${packageJson.version}` },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("release version check rejects a mismatched tag", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: `v${packageJson.version}-mismatch` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must match package version/);
});
