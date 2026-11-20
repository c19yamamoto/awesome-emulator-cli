import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../dist/process.js";

test("passes shell metacharacters as literal argument data by default", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-process-test-"));
  const outputPath = path.join(directory, "received-args.json");
  const probeSource = [
    "import { writeFile } from 'node:fs/promises';",
    "const [outputPath, ...receivedArgs] = process.argv.slice(1);",
    "await writeFile(outputPath, JSON.stringify(receivedArgs), 'utf8');",
  ].join(" ");
  const markerName = `windows-shell-injection-${randomUUID()}.txt`;
  const markerPath = path.resolve(markerName);
  const payloads = [
    `safe & echo INJECTED> ${markerName}`,
    `safe | echo PIPELINED> ${markerName}`,
    "literal %COMSPEC% ! ^ ( )",
  ];

  await rm(markerPath, { force: true });
  try {
    const exitCode = await runCommand(
      process.execPath,
      ["--input-type=module", "-e", probeSource, outputPath, ...payloads],
      process.env,
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), payloads);
    await assert.rejects(readFile(markerPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(markerPath, { force: true });
  }
});

test("can route child stdout to stderr to preserve a machine-readable parent stdout", () => {
  const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
  const source = `import { runCommand } from ${JSON.stringify(processModuleUrl)}; await runCommand(process.execPath, ["-e", "process.stdout.write('initializer output')"], process.env, undefined, false, "stderr");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "initializer output");
});

test(
  "supports Windows batch commands through an explicit trusted-shell opt-in",
  { skip: process.platform !== "win32" },
  async () => {
    const batchExitCode = await runCommand("npm.cmd", ["--version"], process.env, undefined, true);
    const builtinExitCode = await runCommand("echo", ["trusted shell opt-in"], process.env, undefined, true);

    assert.equal(batchExitCode, 0);
    assert.equal(builtinExitCode, 0);
  },
);
