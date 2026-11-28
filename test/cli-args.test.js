import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../dist/cli-args.js";

test("parses child options and preserves command arguments", () => {
  assert.deepEqual(parseCliArgs([
    "run", "--region", "ap-northeast-1", "--sdk", "rust", "--sdk", "dotnet",
    "--credentials", "env", "--shell", "--", "npm", "test",
  ]), {
    help: false,
    command: "run",
    options: {
      region: "ap-northeast-1",
      sdks: ["rust", "dotnet"],
      credentials: "environment",
      shell: true,
    },
    commandArgs: ["npm", "test"],
  });
});

test("accepts initialization options only with up --init", () => {
  assert.deepEqual(parseCliArgs([
    "up", "--session", "ci-tests", "--init", "--region", "us-west-2", "--", "node", "seed.js",
  ]), {
    help: false,
    command: "up",
    options: { session: "ci-tests", init: true, region: "us-west-2" },
    commandArgs: ["node", "seed.js"],
  });
  assert.throws(
    () => parseCliArgs(["up", "--session", "ci-tests", "--region", "us-west-2"]),
    /Child command options and arguments for up require --init/,
  );
});

test("rejects unsupported and command-ineligible options", () => {
  assert.throws(() => parseCliArgs(["run", "--sdk", "unknown"]), /Unsupported SDK: unknown/);
  assert.throws(() => parseCliArgs(["start", "--sdk", "java-v2"]), /--sdk can only be used/);
  assert.throws(() => parseCliArgs(["exec", "--region", "us-west-2"]), /--session is required/);
});
