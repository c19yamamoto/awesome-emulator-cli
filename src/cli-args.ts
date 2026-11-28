import type { EmulatorCredentialsMode, RunWithEmulatorOptions } from "./emulator-options.js";
import { DEFAULT_AWS_REGION, SUPPORTED_EMULATOR_SDKS, type EmulatorSdk } from "./emulator-environment.js";
import {
  EMULATOR_BACKENDS,
  DEFAULT_EMULATOR_CREDENTIALS_MODE,
  DEFAULT_EMULATOR_MEMORY,
  DEFAULT_EMULATOR_PORT,
  DEFAULT_EMULATOR_STATE_DIRECTORY_PARTS,
  DEFAULT_EMULATOR_TELEMETRY,
  DEFAULT_VERSION,
} from "./emulator-options.js";

type CliOptionSource = RunWithEmulatorOptions & { session?: string; init?: boolean };
type CliCommand = "prepare" | "start" | "run" | "up" | "exec" | "down";
type CliOptionKey = keyof CliOptionSource;

type CliOptionDefinition = {
  [Key in CliOptionKey]: {
    key: Key;
    kind: Key extends "sdks" ? "sdk" : Key extends "shell" | "init" ? "flag" : "value";
    names: readonly string[];
    commands: readonly CliCommand[];
    upRequiresInit?: boolean;
    valueLabel: string;
    description: string;
  }
}[CliOptionKey];

const CLI_CREDENTIAL_MODE_NAMES = {
  files: "files",
  env: "environment",
} as const satisfies Record<string, EmulatorCredentialsMode>;

function getCredentialModeHelp(): string {
  const modes = Object.entries(CLI_CREDENTIAL_MODE_NAMES).map(([name, mode]) =>
    mode === DEFAULT_EMULATOR_CREDENTIALS_MODE ? `${name} (default)` : name);
  return `Credentials delivery: ${modes.join(" or ")}`;
}

export const CLI_OPTION_DEFINITIONS = [
  {
    key: "backend",
    kind: "value",
    names: ["--backend"],
    commands: ["prepare", "start", "run", "up"],
    valueLabel: "<docker|native|auto>",
    description: "Runtime backend (default: docker)",
  },
  {
    key: "version",
    kind: "value",
    names: ["-v", "--version"],
    commands: ["prepare", "start", "run", "up"],
    valueLabel: "<version>",
    description: `AWS Emulator version (default: ${DEFAULT_VERSION})`,
  },
  {
    key: "port",
    kind: "value",
    names: ["-p", "--port"],
    commands: ["start", "run", "up"],
    valueLabel: "<port>",
    description: `Host port; 0 selects an available port (default: ${DEFAULT_EMULATOR_PORT})`,
  },
  {
    key: "telemetry",
    kind: "value",
    names: ["-t", "--telemetry"],
    commands: ["start", "run", "up"],
    valueLabel: "<on|off>",
    description: `Telemetry setting (default: ${DEFAULT_EMULATOR_TELEMETRY})`,
  },
  {
    key: "memory",
    kind: "value",
    names: ["--memory"],
    commands: ["start", "run", "up"],
    valueLabel: "<limit>",
    description: `Docker container memory limit (default: ${DEFAULT_EMULATOR_MEMORY}; unavailable with native)`,
  },
  {
    key: "stateDirectory",
    kind: "value",
    names: ["--state-dir"],
    commands: ["start", "run", "up", "exec", "down"],
    valueLabel: "<path>",
    description: `Emulator state directory (default: AWS_EMULATOR_STATE_DIR or ~/${DEFAULT_EMULATOR_STATE_DIRECTORY_PARTS.join("/")})`,
  },
  {
    key: "region",
    kind: "value",
    names: ["--region"],
    commands: ["run", "exec", "up"],
    upRequiresInit: true,
    valueLabel: "<region>",
    description: `Default region for the child command (default: ${DEFAULT_AWS_REGION})`,
  },
  {
    key: "session",
    kind: "value",
    names: ["--session"],
    commands: ["up", "exec", "down"],
    valueLabel: "<name>",
    description: "Persistent emulator session name",
  },
  {
    key: "sdks",
    kind: "sdk",
    names: ["--sdk"],
    commands: ["run", "exec", "up"],
    upRequiresInit: true,
    valueLabel: "<family>",
    description: `Add SDK-specific TLS settings; repeatable (${SUPPORTED_EMULATOR_SDKS.join(", ")})`,
  },
  {
    key: "credentials",
    kind: "value",
    names: ["--credentials"],
    commands: ["run", "exec", "up"],
    upRequiresInit: true,
    valueLabel: `<${Object.keys(CLI_CREDENTIAL_MODE_NAMES).join("|")}>`,
    description: getCredentialModeHelp(),
  },
  {
    key: "shell",
    kind: "flag",
    names: ["--shell"],
    commands: ["run", "exec", "up"],
    upRequiresInit: true,
    valueLabel: "",
    description: "Enable .cmd/.bat and built-ins; trusted values only",
  },
  {
    key: "init",
    kind: "flag",
    names: ["--init"],
    commands: ["up"],
    valueLabel: "",
    description: "Run a command after the emulator becomes healthy",
  },
] as const satisfies readonly CliOptionDefinition[];

type DefinedCliOption = (typeof CLI_OPTION_DEFINITIONS)[number];
type CliOption = DefinedCliOption["key"];

export type CliValueOption = Extract<DefinedCliOption, { kind: "value" }>["key"];
export type CliOptions = Partial<Pick<CliOptionSource, CliOption>>;
export type ParsedArgs =
  | { help: true }
  | { help: false; command?: string; options: CliOptions; commandArgs: string[] };

const OPTION_DEFINITION_BY_NAME = new Map<string, DefinedCliOption>();
for (const definition of CLI_OPTION_DEFINITIONS) {
  for (const name of definition.names) OPTION_DEFINITION_BY_NAME.set(name, definition);
}

function requiresUpInit(definition: DefinedCliOption): boolean {
  return "upRequiresInit" in definition && definition.upRequiresInit;
}

export function formatCliOptionHelp(): string[] {
  return CLI_OPTION_DEFINITIONS.map((definition) => {
    const names = definition.names.join(", ");
    const valueLabel = definition.valueLabel ? ` ${definition.valueLabel}` : "";
    const optionSyntax = `${names}${valueLabel}`;
    const scope = definition.key === "init"
      ? "(up only)"
      : `(${definition.commands.map((command) => command === "up" && requiresUpInit(definition) ? "up --init" : command).join("/")})`;
    return `  ${optionSyntax.padEnd(34)}${scope.padEnd(25)}${definition.description}`;
  });
}

function requireOptionCommand(command: string | undefined, definition: DefinedCliOption, token: string): void {
  const allowedCommands: readonly string[] = definition.commands;
  if (command && allowedCommands.includes(command)) return;
  if (command === "exec" || command === "down") {
    throw new Error(`${token} cannot be used with the ${command} command.`);
  }
  const formatCommandList = (commands: readonly string[]): string => {
    const lastCommand = commands.at(-1);
    const commandList = commands.length === 2
      ? `${commands[0]} or ${lastCommand}`
      : commands.length > 2
        ? `${commands.slice(0, -1).join(", ")}, or ${lastCommand}`
        : commands[0];
    return commands.length <= 3 ? `the ${commandList} command` : commandList;
  };
  const directCommands = definition.commands.filter((allowedCommand) =>
    !(allowedCommand === "up" && requiresUpInit(definition)));
  const upInitOnly = requiresUpInit(definition) && definition.commands.includes("up");
  const directCommandList = directCommands.length > 0 ? formatCommandList(directCommands) : undefined;
  const initContext = upInitOnly ? "up --init" : undefined;
  const allowedContexts = [directCommandList, initContext].filter((context): context is string => Boolean(context));
  throw new Error(`${token} can only be used with ${allowedContexts.join(", or with ")}.`);
}

function hasUpInitOnlyOption(options: CliOptions): boolean {
  const parsedOptionKeys = new Set(Object.keys(options));
  return CLI_OPTION_DEFINITIONS.some((definition) =>
    requiresUpInit(definition) && parsedOptionKeys.has(definition.key));
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (command === "-h" || command === "--help") return { help: true };
  const options: CliOptions = {};
  const commandArgs: string[] = [];
  let separator = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (separator) {
      commandArgs.push(token);
      continue;
    }
    if (token === "--") {
      if (command === "up" && !options.init) throw new Error("The up command accepts child arguments only after --init --.");
      separator = true;
      continue;
    }
    if (token === "-h" || token === "--help") return { help: true };

    const definition = OPTION_DEFINITION_BY_NAME.get(token);
    if (!definition) throw new Error(`Unknown option: ${token}`);
    requireOptionCommand(command, definition, token);

    if (definition.kind === "flag") {
      if (definition.key === "init") {
        if (options.init) throw new Error("--init can only be specified once.");
        options.init = true;
      } else {
        options.shell = true;
      }
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    if (definition.kind === "sdk") {
      if (!(SUPPORTED_EMULATOR_SDKS as readonly string[]).includes(value)) {
        throw new Error(`Unsupported SDK: ${value}. Choose from ${SUPPORTED_EMULATOR_SDKS.join(", ")}.`);
      }
      options.sdks ??= [];
      options.sdks.push(value as EmulatorSdk);
    } else if (definition.key === "credentials") {
      const mode = Object.hasOwn(CLI_CREDENTIAL_MODE_NAMES, value)
        ? CLI_CREDENTIAL_MODE_NAMES[value as keyof typeof CLI_CREDENTIAL_MODE_NAMES]
        : undefined;
      if (!mode) throw new Error(`--credentials must be ${Object.keys(CLI_CREDENTIAL_MODE_NAMES).join(" or ")}.`);
      options.credentials = mode;
    } else if (definition.key === "backend") {
      if (!(EMULATOR_BACKENDS as readonly string[]).includes(value)) {
        throw new Error(`--backend must be ${EMULATOR_BACKENDS.join(", ")}.`);
      }
      options.backend = value as CliOptions["backend"];
    } else {
      options[definition.key] = value;
    }
    index += 1;
  }
  if ((command === "up" || command === "exec" || command === "down") && !options.session) {
    throw new Error(`--session is required with the ${command} command.`);
  }
  if (command === "up") {
    if (options.init && (!separator || commandArgs.length === 0)) {
      throw new Error("Usage: awesome-emulator up --session <name> [options] --init -- <command> [args...]");
    }
    if (!options.init && (separator || hasUpInitOnlyOption(options))) {
      throw new Error("Child command options and arguments for up require --init.");
    }
  }
  return { help: false, command, options, commandArgs };
}
