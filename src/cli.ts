#!/usr/bin/env node

import { prepareEmulatorImage, runWithEmulator, startEmulator, type StartEmulatorOptions } from "./index.js";
import { DEFAULT_VERSION } from "./emulator-options.js";
import { FORWARDED_SIGNALS, getSignalExitCode, type ForwardedSignal } from "./signals.js";

type ParsedArgs =
  | { help: true }
  | { help: false; command?: string; options: CliOptions; commandArgs: string[] };

type CliValueOption = keyof Pick<StartEmulatorOptions, "version" | "port" | "telemetry" | "memory">;
type CliOptions = Pick<StartEmulatorOptions, CliValueOption> & { shell?: boolean };

function usage() {
  console.log(`Usage:
  awesome-emulator prepare [--version <version>]
  awesome-emulator start [options]
  awesome-emulator run [options] [--shell] -- <command> [args...]

Options:
  -v, --version <version>     AWS Emulator version (default: ${DEFAULT_VERSION})
  -p, --port <port>           (start/run) Host port; 0 chooses an available port (default: 9297)
  -t, --telemetry <on|off>    (start/run) Telemetry setting (default: on)
      --memory <limit>        (start/run) Container memory limit (default: 2g)
      --shell                 (run only) Enable .cmd/.bat and built-ins; trusted values only
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
      if (command !== "run") throw new Error("--shell can only be used with the run command.");
      options.shell = true;
      continue;
    }
    const optionNames: Record<string, CliValueOption> = {
      "-v": "version", "--version": "version",
      "-p": "port", "--port": "port",
      "-t": "telemetry", "--telemetry": "telemetry",
      "--memory": "memory",
    };
    const key = optionNames[token];
    if (!key) throw new Error(`Unknown option: ${token}`);
    if (command === "prepare" && key !== "version") {
      throw new Error(`${token} can only be used with the start or run command.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[key] = value;
    index += 1;
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
