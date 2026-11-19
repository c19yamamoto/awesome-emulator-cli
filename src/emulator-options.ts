export type StartEmulatorOptions = {
  version?: string;
  port?: number | string;
  telemetry?: string;
  memory?: string;
  startupTimeoutMs?: number;
  signal?: AbortSignal;
};

export type ResolvedEmulatorOptions = {
  version: string;
  requestedPort: number;
  telemetry: "on" | "off";
  memory: string;
  startupTimeoutMs: number;
};

const DEFAULT_VERSION = "1.0.522";
const DEFAULT_PORT = 9297;
const DEFAULT_MEMORY = "2g";

function normalizeVersion(value: string | undefined, environment: NodeJS.ProcessEnv): string {
  const version = value ?? environment.AWS_EMULATOR_VERSION ?? DEFAULT_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
    throw new Error(`Invalid AWS Emulator version: ${version}. Use a version such as 1.0.522.`);
  }
  return String(version);
}

function normalizePort(value: number | string | undefined, environment: NodeJS.ProcessEnv): number {
  const port = Number(value ?? environment.AWS_EMULATOR_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}. Use a number from 0 to 65535.`);
  }
  return port;
}

function normalizeTelemetry(value: string | undefined, environment: NodeJS.ProcessEnv): "on" | "off" {
  const telemetry = String(value ?? environment.EMULATOR_TELEMETRY ?? "on").toLowerCase();
  if (["on", "true", "1"].includes(telemetry)) return "on";
  if (["off", "false", "0"].includes(telemetry)) return "off";
  throw new Error(`Invalid telemetry setting: ${value}. Use on or off.`);
}

function normalizeMemory(value: string | undefined): string {
  const memory = String(value ?? DEFAULT_MEMORY);
  if (!/^\d+(?:\.\d+)?[kmgt]$/i.test(memory) || Number.parseFloat(memory) <= 0) {
    throw new Error(`Invalid memory limit: ${value}. Use a Docker memory value such as 2g.`);
  }
  return memory;
}

function normalizeStartupTimeout(value: number | undefined): number {
  const timeout = Number(value ?? 120_000);
  if (!Number.isInteger(timeout) || timeout < 1000) {
    throw new Error("startupTimeoutMs must be an integer of at least 1000.");
  }
  return timeout;
}

export function resolveEmulatorOptions(
  options: StartEmulatorOptions,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedEmulatorOptions {
  return {
    version: normalizeVersion(options.version, environment),
    requestedPort: normalizePort(options.port, environment),
    telemetry: normalizeTelemetry(options.telemetry, environment),
    memory: normalizeMemory(options.memory),
    startupTimeoutMs: normalizeStartupTimeout(options.startupTimeoutMs),
  };
}
