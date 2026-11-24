import type { EmulatorSdk } from "./emulator-environment.js";
import os from "node:os";
import path from "node:path";

export type EmulatorCredentialsMode = "files" | "environment";

export function resolveEmulatorCredentialsMode(value: string | undefined): EmulatorCredentialsMode {
  const mode = value ?? "files";
  if (mode !== "files" && mode !== "environment") {
    throw new Error("Credentials mode must be files or environment.");
  }
  return mode;
}

export type StartEmulatorOptions = {
  version?: string;
  stateDirectory?: string;
  port?: number | string;
  telemetry?: string;
  memory?: string;
  startupTimeoutMs?: number;
  signal?: AbortSignal;
};

export type RunWithEmulatorOptions = StartEmulatorOptions & {
  /**
   * Run the child command through a shell. Shell metacharacters in command or
   * arguments are interpreted, so only enable this for trusted values.
   * Defaults to false.
   */
  shell?: boolean;
  /** Set AWS_REGION and AWS_DEFAULT_REGION for the child command. */
  region?: string;
  /** Add SDK-specific TLS settings for the selected SDK families. */
  sdks?: EmulatorSdk[];
  /** Pass Emulator-generated credentials through AWS credential environment variables instead of relying only on files. */
  credentials?: EmulatorCredentialsMode;
};

export type PrepareEmulatorOptions = Pick<StartEmulatorOptions, "version" | "signal">;

export type ResolvedEmulatorOptions = {
  version: string;
  requestedPort: number;
  telemetry: "on" | "off";
  memory: string;
  startupTimeoutMs: number;
};

export function resolveEmulatorStateDirectory(
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
  workingDirectory = process.cwd(),
): string {
  const configuredDirectory = value ?? environment.AWS_EMULATOR_STATE_DIR;
  if (configuredDirectory !== undefined && configuredDirectory.trim().length === 0) {
    throw new Error("Emulator state directory must not be empty.");
  }
  return path.resolve(workingDirectory, configuredDirectory ?? path.join(homeDirectory, ".aws", "emulator"));
}

export const DEFAULT_VERSION = "1.0.598";
const DEFAULT_PORT = 9297;
const DEFAULT_MEMORY = "2g";

function normalizeVersion(value: string | undefined, environment: NodeJS.ProcessEnv): string {
  const version = value ?? environment.AWS_EMULATOR_VERSION ?? DEFAULT_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
    throw new Error(`Invalid AWS Emulator version: ${version}. Use a version such as ${DEFAULT_VERSION}.`);
  }
  return String(version);
}

export function resolveEmulatorVersion(
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return normalizeVersion(value, environment);
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
    version: resolveEmulatorVersion(options.version, environment),
    requestedPort: normalizePort(options.port, environment),
    telemetry: normalizeTelemetry(options.telemetry, environment),
    memory: normalizeMemory(options.memory),
    startupTimeoutMs: normalizeStartupTimeout(options.startupTimeoutMs),
  };
}
