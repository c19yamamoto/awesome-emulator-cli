import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRetryableStop, startContainer, stopContainer, withEmulator } from "./container-lifecycle.js";
import { docker, throwIfAborted } from "./docker.js";
import {
  createChildEnvironment,
  createEmulatorConnectionSettings,
  normalizeEmulatorSdks,
  type EmulatorEnvironment,
} from "./emulator-environment.js";
import { ensureEmulatorImage, getArchitecture, type EmulatorArchitecture } from "./emulator-image.js";
import {
  resolveEmulatorOptions,
  resolveEmulatorVersion,
  type PrepareEmulatorOptions,
  type RunWithEmulatorOptions,
  type StartEmulatorOptions,
} from "./emulator-options.js";
import { runCommand } from "./process.js";

export type { PrepareEmulatorOptions, RunWithEmulatorOptions, StartEmulatorOptions } from "./emulator-options.js";
export type { EmulatorEnvironment, EmulatorSdk } from "./emulator-environment.js";

export type EmulatorSession = {
  version: string;
  port: number;
  endpointUrl: string;
  healthCheckUrl: string;
  configFile: string;
  credentialsFile: string;
  caFile: string;
  environment: EmulatorEnvironment;
  containerId: string;
  stop: () => Promise<void>;
};

/** Build or reuse the selected AWS Emulator Docker image without starting a container. */
export async function prepareEmulatorImage(options: PrepareEmulatorOptions = {}): Promise<string> {
  throwIfAborted(options.signal);
  const version = resolveEmulatorVersion(options.version);
  return ensureEmulatorImage(version, getArchitecture(), options.signal);
}

async function getAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine an available local port.");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function requestHealth(port: number, ca: Buffer, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const request = https.get({
      hostname: "127.0.0.1",
      port,
      path: "/__admin/health",
      ca,
      timeout: 1000,
      signal,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(response.statusCode === 200 && body.trim() === "ok"));
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => request.destroy());
  });
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

type ContainerRunConfiguration = {
  architecture: EmulatorArchitecture;
  containerName: string;
  image: string;
  memory: string;
  port: number;
  stateDirectory: string;
  telemetry: "on" | "off";
};

function createContainerRunArguments({
  architecture,
  containerName,
  image,
  memory,
  port,
  stateDirectory,
  telemetry,
}: ContainerRunConfiguration): string[] {
  const hostUser = process.platform === "linux"
    && typeof process.getuid === "function"
    && typeof process.getgid === "function"
    ? ["--user", `${process.getuid()}:${process.getgid()}`]
    : [];

  return [
    "run", "--detach",
    "--platform", `linux/${architecture.docker}`,
    ...hostUser,
    "--memory", memory,
    "--memory-swap", memory,
    "--publish", `127.0.0.1:${port}:${port}`,
    "--mount", `type=bind,source=${stateDirectory},target=/home/emulator/.aws/emulator`,
    "--env", "HOME=/home/emulator",
    "--name", containerName,
    image,
    "-p", String(port),
    "-t", telemetry,
  ];
}

async function waitUntilHealthy(containerId: string, port: number, stateDirectory: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const caFile = path.join(stateDirectory, String(port), "ca.pem");
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const ca = await readFile(caFile);
      if (await requestHealth(port, ca, signal)) return;
    } catch {
      // The container creates its certificate before the health route is ready.
    }
    throwIfAborted(signal);

    try {
      const running = await docker(["inspect", "--format", "{{.State.Running}}", containerId], { capture: true, signal });
      if (running !== "true") {
        const logs = await docker(["logs", "--tail", "100", containerId], { capture: true }).catch(() => "");
        throw new Error(`AWS Emulator container exited before becoming healthy.${logs ? `\n${logs}` : ""}`);
      }
    } catch (error: unknown) {
      throwIfAborted(signal);
      if (error instanceof Error && error.message.startsWith("AWS Emulator container exited")) throw error;
    }
    await delay(250);
  }
  throwIfAborted(signal);
  const logs = await docker(["logs", "--tail", "100", containerId], { capture: true }).catch(() => "");
  throw new Error(`AWS Emulator did not become healthy within ${timeoutMs} ms.${logs ? `\n${logs}` : ""}`);
}

/**
 * Start AWS Emulator in a local Docker container.
 *
 * The returned object includes SDK environment variables and an idempotent
 * stop() function. Port 0 asks the wrapper to choose an available local port.
 */
export async function startEmulator(options: StartEmulatorOptions = {}): Promise<EmulatorSession> {
  throwIfAborted(options.signal);
  const { version, requestedPort, telemetry, memory, startupTimeoutMs } = resolveEmulatorOptions(options);
  const port = requestedPort === 0 ? await getAvailablePort() : requestedPort;
  throwIfAborted(options.signal);
  const architecture = getArchitecture();
  const stateDirectory = path.join(os.homedir(), ".aws", "emulator");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

  const image = await ensureEmulatorImage(version, architecture, options.signal);
  throwIfAborted(options.signal);
  const containerName = `awesome-emulator-cli-${process.pid}-${randomBytes(4).toString("hex")}`;
  const runArguments = createContainerRunArguments({
    architecture,
    containerName,
    image,
    memory,
    port,
    stateDirectory,
    telemetry,
  });
  const runningContainerId = await startContainer(containerName, runArguments, options.signal, (id, signal) =>
    waitUntilHealthy(id, port, stateDirectory, startupTimeoutMs, signal));
  const stop = createRetryableStop(() => stopContainer(runningContainerId));
  try {
    throwIfAborted(options.signal);
  } catch (startupError) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        `AWS Emulator startup was interrupted and container cleanup also failed (${runningContainerId}).`,
      );
    }
    throw startupError;
  }
  const connectionSettings = createEmulatorConnectionSettings(port, stateDirectory);

  return {
    version,
    port,
    ...connectionSettings,
    containerId: runningContainerId,
    stop,
  };
}

/**
 * Run a child process with AWS Emulator settings and stop the emulator afterward.
 */
export async function runWithEmulator(command: string, args: string[] = [], options: RunWithEmulatorOptions = {}): Promise<number> {
  if (!command) throw new Error("A command is required.");
  const { shell = false, sdks: requestedSdks = [], ...emulatorOptions } = options;
  const sdks = normalizeEmulatorSdks(requestedSdks);
  return withEmulator(() => startEmulator(emulatorOptions), async (emulator) => {
    const childEnvironment = createChildEnvironment(process.env, emulator.environment, sdks);
    return runCommand(command, args, childEnvironment, emulatorOptions.signal, shell);
  });
}
