#!/usr/bin/env node

import {
  prepareEmulatorImage,
  downEmulatorSession,
  execEmulatorSession,
  runWithEmulator,
  startEmulator,
  upEmulatorSession,
  type RunWithEmulatorOptions,
  type StartEmulatorOptions,
} from "./index.js";
import { DEFAULT_VERSION } from "./emulator-options.js";
import { FORWARDED_SIGNALS, getSignalExitCode, type ForwardedSignal } from "./signals.js";
import { DEFAULT_AWS_REGION, SUPPORTED_EMULATOR_SDKS, type EmulatorSdk } from "./emulator-environment.js";

type ParsedArgs =
  | { help: true }
  | { help: false; command?: string; options: CliOptions; commandArgs: string[] };

type CliValueOption = "version" | "port" | "telemetry" | "memory" | "region" | "session";
type CliOptions = Pick<StartEmulatorOptions, "version" | "port" | "telemetry" | "memory">
  & Pick<RunWithEmulatorOptions, "region" | "sdks">
  & { shell?: boolean; session?: string };

function usage() {
  console.log(`Usage:
  awesome-emulator prepare [--version <version>]
  awesome-emulator start [options]
  awesome-emulator run [options] [--region <region>] [--sdk <family>]... [--shell] -- <command> [args...]
  awesome-emulator up --session <name> [options]
  awesome-emulator exec --session <name> [--region <region>] [--sdk <family>]... [--shell] -- <command> [args...]
  awesome-emulator down --session <name>

Options:
  -v, --version <version>     AWS Emulator version (default: ${DEFAULT_VERSION})
  -p, --port <port>           (start/run/up) Host port; 0 chooses an available port (default: 9297)
  -t, --telemetry <on|off>    (start/run/up) Telemetry setting (default: on)
      --memory <limit>        (start/run/up) Container memory limit (default: 2g)
      --region <region>       (run/exec only) Default region for the child command (default: ${DEFAULT_AWS_REGION})
      --session <name>        (up/exec/down) Persistent emulator session name
      --sdk <family>          (run/exec) Add SDK-specific TLS settings; repeatable
                              (${SUPPORTED_EMULATOR_SDKS.join(", ")})
      --shell                 (run/exec) Enable .cmd/.bat and built-ins; trusted values only
  -h, --help                  Show this help`);
}

function parse(argv: string[]): ParsedArgs {
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
      separator = true;
      continue;
    }
    if (token === "-h" || token === "--help") return { help: true };
    if (token === "--shell") {
      if (command !== "run" && command !== "exec") throw new Error("--shell can only be used with the run or exec command.");
      options.shell = true;
      continue;
    }
    if (token === "--sdk") {
      if (command !== "run" && command !== "exec") throw new Error("--sdk can only be used with the run or exec command.");
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
    const optionNames: Record<string, CliValueOption> = {
      "-v": "version", "--version": "version",
      "-p": "port", "--port": "port",
      "-t": "telemetry", "--telemetry": "telemetry",
      "--memory": "memory",
      "--region": "region",
      "--session": "session",
    };
    const key = optionNames[token];
    if (!key) throw new Error(`Unknown option: ${token}`);
    if (key === "region" && command !== "run" && command !== "exec") {
      throw new Error("--region can only be used with the run or exec command.");
    }
    if (key === "session" && command !== "up" && command !== "exec" && command !== "down") {
      throw new Error("--session can only be used with the up, exec, or down command.");
    }
    if (command === "prepare" && key !== "version") {
      throw new Error(`${token} can only be used with the start or run command.`);
    }
    if ((command === "exec" || command === "down") && key !== "region" && key !== "session") {
      throw new Error(`${token} cannot be used with the ${command} command.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[key] = value;
    index += 1;
  }
  if ((command === "up" || command === "exec" || command === "down") && !options.session) {
    throw new Error(`--session is required with the ${command} command.`);
  }
  return { help: false, command, options, commandArgs };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function signalExitCode(signal: AbortSignal): number {
  return getSignalExitCode(signal.reason);
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = [...error.errors].map(formatError);
    return causes.length > 0 ? `${error.message}\n${causes.map((cause) => `  ${cause}`).join("\n")}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function main(signal: AbortSignal): Promise<number> {
  const parsed = parse(process.argv.slice(2));
  if (parsed.help || !parsed.command || parsed.command === "help") {
    usage();
    return 0;
  }

  if (parsed.command === "run") {
    const [program, ...args] = parsed.commandArgs;
    if (!program) throw new Error("Usage: awesome-emulator run [options] -- <command> [args...]");
    return runWithEmulator(program, args, { ...parsed.options, signal });
  }

  if (parsed.command === "up") {
    if (parsed.commandArgs.length > 0) throw new Error("The up command does not accept child command arguments.");
    const session = await upEmulatorSession(parsed.options.session!, {
      version: parsed.options.version,
      port: parsed.options.port,
      telemetry: parsed.options.telemetry,
      memory: parsed.options.memory,
      signal,
    });
    console.log(JSON.stringify(session, null, 2));
    return 0;
  }

  if (parsed.command === "exec") {
    const [program, ...args] = parsed.commandArgs;
    if (!program) throw new Error("Usage: awesome-emulator exec --session <name> -- <command> [args...]");
    return execEmulatorSession(parsed.options.session!, program, args, {
      region: parsed.options.region,
      sdks: parsed.options.sdks,
      shell: parsed.options.shell,
      signal,
    });
  }

  if (parsed.command === "down") {
    if (parsed.commandArgs.length > 0) throw new Error("The down command does not accept child command arguments.");
    await downEmulatorSession(parsed.options.session!);
    console.log(`Emulator session "${parsed.options.session}" stopped.`);
    return 0;
  }

  if (parsed.command === "prepare") {
    const image = await prepareEmulatorImage({ version: parsed.options.version, signal });
    console.log(`AWS Emulator image is ready: ${image}`);
    return 0;
  }

  if (parsed.command === "start") {
    const emulator = await startEmulator({
      version: parsed.options.version,
      port: parsed.options.port,
      telemetry: parsed.options.telemetry,
      memory: parsed.options.memory,
      signal,
    });
    try {
      if (!signal.aborted) {
        console.log(JSON.stringify({
          version: emulator.version,
          endpointUrl: emulator.endpointUrl,
          healthCheckUrl: emulator.healthCheckUrl,
          configFile: emulator.configFile,
          credentialsFile: emulator.credentialsFile,
          caFile: emulator.caFile,
          environment: emulator.environment,
        }, null, 2));
      }
      await waitForAbort(signal);
      return signalExitCode(signal);
    } finally {
      await emulator.stop();
    }
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

const controller = new AbortController();
const signalHandlers = new Map<ForwardedSignal, () => void>();
for (const signal of FORWARDED_SIGNALS) {
  const handler = () => controller.abort(signal);
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

main(controller.signal).then((code: number) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
    process.exitCode = signalExitCode(controller.signal);
  } else {
    console.error(`awesome-emulator: ${formatError(error)}`);
    process.exitCode = 1;
  }
}).finally(() => {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
});
