import type { EmulatorCredentialsMode, RunWithEmulatorOptions, StartEmulatorOptions } from "./emulator-options.js";
import { SUPPORTED_EMULATOR_SDKS, type EmulatorSdk } from "./emulator-environment.js";

export type CliValueOption = "version" | "port" | "telemetry" | "memory" | "region" | "session" | "stateDirectory" | "credentials";
export type CliOptions = Pick<StartEmulatorOptions, "version" | "port" | "telemetry" | "memory" | "stateDirectory">
  & Pick<RunWithEmulatorOptions, "region" | "sdks">
  & { shell?: boolean; session?: string; init?: boolean; credentials?: EmulatorCredentialsMode };
export type ParsedArgs =
  | { help: true }
  | { help: false; command?: string; options: CliOptions; commandArgs: string[] };

type CliOption = CliValueOption | "sdk" | "shell" | "init";

const VALUE_OPTION_NAMES: Record<string, CliValueOption> = {
  "-v": "version", "--version": "version",
  "-p": "port", "--port": "port",
  "-t": "telemetry", "--telemetry": "telemetry",
  "--memory": "memory",
  "--region": "region",
  "--session": "session",
  "--state-dir": "stateDirectory",
  "--credentials": "credentials",
};

const OPTION_COMMANDS: Record<CliOption, readonly string[]> = {
  version: ["prepare", "start", "run", "up"],
  port: ["start", "run", "up"],
  telemetry: ["start", "run", "up"],
  memory: ["start", "run", "up"],
  region: ["run", "exec", "up"],
  session: ["up", "exec", "down"],
  stateDirectory: ["start", "run", "up", "exec", "down"],
  credentials: ["run", "exec", "up"],
  sdk: ["run", "exec", "up"],
  shell: ["run", "exec", "up"],
  init: ["up"],
};

function requireOptionCommand(command: string | undefined, key: CliOption, token: string): void {
  if (command && OPTION_COMMANDS[key].includes(command)) return;
  if (key === "region") {
    throw new Error("--region can only be used with the run or exec command, or with up --init.");
  }
  if (key === "session") {
    throw new Error("--session can only be used with the up, exec, or down command.");
  }
  if (key === "stateDirectory") {
    throw new Error("--state-dir can only be used with start, run, up, exec, or down.");
  }
  if (key === "credentials") {
    throw new Error("--credentials can only be used with the run or exec command, or with up --init.");
  }
  if (key === "sdk") {
    throw new Error("--sdk can only be used with the run or exec command, or with up --init.");
  }
  if (key === "shell") {
    throw new Error("--shell can only be used with the run or exec command, or with up --init.");
  }
  if (key === "init") {
    throw new Error("--init can only be used with the up command.");
  }
  if (command === "exec" || command === "down") {
    throw new Error(`${token} cannot be used with the ${command} command.`);
  }
  if (command === "prepare") {
    throw new Error(`${token} can only be used with the start or run command.`);
  }
  const allowedCommands = OPTION_COMMANDS[key];
  throw new Error(`${token} can only be used with ${allowedCommands.join(", ")} commands.`);
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (command === "-h" || command === "--help") return { help: true };
  const options: CliOptions = {};
  const commandArgs: string[] = [];
  let separator = false;
  let initRequested = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (separator) {
      commandArgs.push(token);
      continue;
    }
    if (token === "--") {
      if (command === "up" && !initRequested) throw new Error("The up command accepts child arguments only after --init --.");
      separator = true;
      continue;
    }
    if (token === "-h" || token === "--help") return { help: true };
    if (token === "--init") {
      requireOptionCommand(command, "init", token);
      if (initRequested) throw new Error("--init can only be specified once.");
      initRequested = true;
      options.init = true;
      continue;
    }
    if (token === "--shell") {
      requireOptionCommand(command, "shell", token);
      options.shell = true;
      continue;
    }
    if (token === "--sdk") {
      requireOptionCommand(command, "sdk", token);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --sdk");
      if (!(SUPPORTED_EMULATOR_SDKS as readonly string[]).includes(value)) {
        throw new Error(`Unsupported SDK: ${value}. Choose from ${SUPPORTED_EMULATOR_SDKS.join(", ")}.`);
      }
      options.sdks ??= [];
      options.sdks.push(value as EmulatorSdk);
      index += 1;
      continue;
    }
    const key = VALUE_OPTION_NAMES[token];
    if (!key) throw new Error(`Unknown option: ${token}`);
    requireOptionCommand(command, key, token);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    if (key === "credentials") {
      if (value !== "files" && value !== "env") throw new Error("--credentials must be files or env.");
      options.credentials = value === "env" ? "environment" : "files";
    } else {
      options[key] = value;
    }
    index += 1;
  }
  if ((command === "up" || command === "exec" || command === "down") && !options.session) {
    throw new Error(`--session is required with the ${command} command.`);
  }
  if (command === "up") {
    if (initRequested && (!separator || commandArgs.length === 0)) {
      throw new Error("Usage: awesome-emulator up --session <name> [options] --init -- <command> [args...]");
    }
    if (!initRequested && (separator || options.region || options.sdks || options.shell || options.credentials)) {
      throw new Error("Child command options and arguments for up require --init.");
    }
  }
  return { help: false, command, options, commandArgs };
}
