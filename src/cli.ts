#!/usr/bin/env node

import {
  prepareEmulatorImage,
  downEmulatorSession,
  execEmulatorSession,
  runWithEmulator,
  startEmulator,
  upEmulatorSession,
} from "./index.js";
import { formatCliOptionHelp, parseCliArgs } from "./cli-args.js";
import { FORWARDED_SIGNALS, getSignalExitCode, type ForwardedSignal } from "./signals.js";

function usage() {
  console.log(`Usage:
  awesome-emulator prepare [options]
  awesome-emulator start [options]
  awesome-emulator run [options] -- <command> [args...]
  awesome-emulator up --session <name> [options] [--init -- <command> [args...]]
  awesome-emulator exec --session <name> [options] -- <command> [args...]
  awesome-emulator down --session <name> [options]

Options:\n${formatCliOptionHelp().join("\n")}
  -h, --help                  Show this help`);
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
  const parsed = parseCliArgs(process.argv.slice(2));
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
    const [initCommand, ...initArgs] = parsed.commandArgs;
    const session = await upEmulatorSession(parsed.options.session!, {
      backend: parsed.options.backend,
      version: parsed.options.version,
      port: parsed.options.port,
      telemetry: parsed.options.telemetry,
      memory: parsed.options.memory,
      stateDirectory: parsed.options.stateDirectory,
      signal,
      init: parsed.options.init ? {
        command: initCommand!,
        args: initArgs,
        region: parsed.options.region,
        sdks: parsed.options.sdks,
        shell: parsed.options.shell,
        credentials: parsed.options.credentials,
      } : undefined,
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
      stateDirectory: parsed.options.stateDirectory,
      credentials: parsed.options.credentials,
      signal,
    });
  }

  if (parsed.command === "down") {
    if (parsed.commandArgs.length > 0) throw new Error("The down command does not accept child command arguments.");
    await downEmulatorSession(parsed.options.session!, { stateDirectory: parsed.options.stateDirectory });
    console.log(`Emulator session "${parsed.options.session}" stopped.`);
    return 0;
  }

  if (parsed.command === "prepare") {
    const runtime = await prepareEmulatorImage({ backend: parsed.options.backend, version: parsed.options.version, signal });
    console.log(`AWS Emulator runtime is ready: ${runtime}`);
    return 0;
  }

  if (parsed.command === "start") {
    const emulator = await startEmulator({
      backend: parsed.options.backend,
      version: parsed.options.version,
      port: parsed.options.port,
      telemetry: parsed.options.telemetry,
      memory: parsed.options.memory,
      stateDirectory: parsed.options.stateDirectory,
      signal,
    });
    try {
      if (!signal.aborted) {
        console.log(JSON.stringify({
          backend: emulator.backend,
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
