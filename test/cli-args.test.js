import assert from "node:assert/strict";
import test from "node:test";
import { CLI_OPTION_DEFINITIONS, formatCliOptionHelp, parseCliArgs } from "../dist/cli-args.js";

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
  assert.throws(() => parseCliArgs(["run", "--credentials", "invalid"]), /files or env/);
  assert.throws(() => parseCliArgs(["run", "--credentials", "constructor"]), /files or env/);
  assert.throws(() => parseCliArgs(["start", "--sdk", "java-v2"]), /--sdk can only be used/);
  assert.throws(() => parseCliArgs(["exec", "--region", "us-west-2"]), /--session is required/);
});

test("parses every declared option in a supported command context", () => {
  const values = {
    backend: "native",
    version: "1.2.3",
    port: "0",
    telemetry: "off",
    memory: "1g",
    stateDirectory: "/tmp/emulator-state",
    region: "eu-west-1",
    session: "ci-tests",
    sdks: "java-v2",
    credentials: "files",
  };

  for (const definition of CLI_OPTION_DEFINITIONS) {
    const command = definition.commands.find((candidate) => candidate !== "up" || !definition.upRequiresInit) ?? "up";
    const argv = [command];
    if (["up", "exec", "down"].includes(command) && definition.key !== "session") argv.push("--session", "ci-tests");
    if (definition.kind === "flag") {
      argv.push(definition.names[0]);
      if (definition.key === "init") argv.push("--", "node");
    } else {
      argv.push(definition.names[0], values[definition.key]);
    }
    assert.equal(parseCliArgs(argv).help, false, `${definition.names[0]} should parse for ${command}`);
  }

  const help = formatCliOptionHelp().join("\n");
  assert.match(help, /--init\s+\(up only\)/);
  assert.match(help, /--region <region>\s+\(run\/exec\/up --init\)/);
});

test("formats unsupported command scopes and rejects duplicate or missing values", () => {
  assert.throws(() => parseCliArgs(["other", "--version", "1.2.3"]), /prepare, start, run, or up/);
  assert.throws(() => parseCliArgs(["other", "--telemetry", "off"]), /start, run, or up/);
  assert.throws(() => parseCliArgs(["other", "--sdk", "rust"]), /run or exec/);
  assert.throws(() => parseCliArgs(["exec", "--version", "1.2.3"]), /cannot be used with the exec command/);
  assert.throws(() => parseCliArgs(["down", "--version", "1.2.3"]), /cannot be used with the down command/);
  assert.throws(() => parseCliArgs(["", "--version", "1.2.3"]), /can only be used/);
  assert.throws(() => parseCliArgs(["run", "--port"]), /Missing value/);
  assert.throws(() => parseCliArgs(["run", "--port", "--sdk"]), /Missing value/);
  assert.throws(() => parseCliArgs(["up", "--session", "ci-tests", "--init", "--init", "--", "node"]), /only be specified once/);
  assert.throws(() => parseCliArgs(["up", "--session", "ci-tests", "--"]), /accepts child arguments only after --init/);
  assert.throws(() => parseCliArgs(["up", "--session", "ci-tests", "--init"]), /Usage: awesome-emulator up/);
  assert.deepEqual(parseCliArgs(["up", "--session", "ci-tests"]), {
    help: false,
    command: "up",
    options: { session: "ci-tests" },
    commandArgs: [],
  });
  assert.deepEqual(parseCliArgs(["exec", "--session", "ci-tests"]), {
    help: false,
    command: "exec",
    options: { session: "ci-tests" },
    commandArgs: [],
  });
  assert.deepEqual(parseCliArgs(["down", "--session", "ci-tests"]), {
    help: false,
    command: "down",
    options: { session: "ci-tests" },
    commandArgs: [],
  });
  assert.deepEqual(parseCliArgs(["run", "--shell", "--", "echo", "x"]), {
    help: false,
    command: "run",
    options: { shell: true },
    commandArgs: ["echo", "x"],
  });
  assert.deepEqual(parseCliArgs(["-h"]), { help: true });
  assert.deepEqual(parseCliArgs(["run", "-h"]), { help: true });
  assert.deepEqual(parseCliArgs(["run", "--help"]), { help: true });
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
  assert.throws(() => parseCliArgs(["run", "--unknown-option"]), /Unknown option/);
  assert.deepEqual(parseCliArgs(["run", "--", "--help"]), {
    help: false,
    command: "run",
    options: {},
    commandArgs: ["--help"],
  });
});

test("keeps option scope formatting correct for edge definitions", () => {
  const region = CLI_OPTION_DEFINITIONS.find((definition) => definition.key === "region");
  const originalRequiresInit = region.upRequiresInit;
  const originalCommands = region.commands;
  try {
    region.upRequiresInit = false;
    assert.match(formatCliOptionHelp().find((line) => line.includes("--region")), /\(run\/exec\/up\)/);

    region.upRequiresInit = true;
    region.commands = ["run", "exec"];
    assert.throws(() => parseCliArgs(["other", "--region", "us-west-2"]), /run or exec/);

    region.commands = ["up"];
    assert.throws(() => parseCliArgs(["other", "--region", "us-west-2"]), /can only be used with up --init/);
  } finally {
    region.upRequiresInit = originalRequiresInit;
    region.commands = originalCommands;
  }
});
