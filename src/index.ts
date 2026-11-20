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
  resolveAwsRegion,
  type EmulatorEnvironment,
  type EmulatorSdk,
} from "./emulator-environment.js";
import { ensureEmulatorImage, getArchitecture, type EmulatorArchitecture } from "./emulator-image.js";
import { isSessionOwnerRunning, readSession, removeSession, reserveSession, validateSessionName, writeRunningSession, type RunningSessionRecord } from "./session-store.js";
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

export type PersistentEmulatorSession = Omit<EmulatorSession, "containerId" | "stop"> & { name: string };
export type EmulatorSessionExecOptions = Pick<RunWithEmulatorOptions, "shell" | "sdks" | "region" | "signal">;
export type EmulatorSessionInitCommand = {
  command: string;
  args?: string[];
  shell?: boolean;
  sdks?: EmulatorSdk[];
  region?: string;
};
export type UpEmulatorSessionOptions = StartEmulatorOptions & { init?: EmulatorSessionInitCommand };

const MANAGED_CONTAINER_LABEL = "io.github.c19yamamoto.awesome-emulator-cli.managed";
const SESSION_CONTAINER_LABEL = "io.github.c19yamamoto.awesome-emulator-cli.session";

function emulatorStateDirectory(): string {
  return path.join(os.homedir(), ".aws", "emulator");
}

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
  labels: Record<string, string>;
  memory: string;
  port: number;
  stateDirectory: string;
  telemetry: "on" | "off";
};

function createContainerRunArguments({
  architecture,
  containerName,
  image,
  labels,
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
  const dockerLabels = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);

  return [
    "run", "--detach",
    "--platform", `linux/${architecture.docker}`,
    ...hostUser,
    ...dockerLabels,
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
async function startEmulatorWithIdentity(
  options: StartEmulatorOptions,
  containerName: string,
  labels: Record<string, string>,
): Promise<EmulatorSession> {
  throwIfAborted(options.signal);
  const { version, requestedPort, telemetry, memory, startupTimeoutMs } = resolveEmulatorOptions(options);
  const port = requestedPort === 0 ? await getAvailablePort() : requestedPort;
  throwIfAborted(options.signal);
  const architecture = getArchitecture();
  const stateDirectory = emulatorStateDirectory();
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

  const image = await ensureEmulatorImage(version, architecture, options.signal);
  throwIfAborted(options.signal);
  const runArguments = createContainerRunArguments({
    architecture,
    containerName,
    image,
    labels,
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

export async function startEmulator(options: StartEmulatorOptions = {}): Promise<EmulatorSession> {
  const containerName = `awesome-emulator-cli-${process.pid}-${randomBytes(4).toString("hex")}`;
  return startEmulatorWithIdentity(options, containerName, { [MANAGED_CONTAINER_LABEL]: "true" });
}

export async function upEmulatorSession(
  name: string,
  options: UpEmulatorSessionOptions = {},
): Promise<PersistentEmulatorSession> {
  validateSessionName(name);
  const { init, ...emulatorOptions } = options;
  const initOptions = init
    ? { sdks: normalizeEmulatorSdks(init.sdks), region: resolveAwsRegion(init.region) }
    : undefined;
  if (init && !init.command) throw new Error("An initialization command is required.");
  const stateDirectory = emulatorStateDirectory();
  const containerName = `awesome-emulator-cli-session-${randomBytes(4).toString("hex")}-${name}`;
  await reserveSession(stateDirectory, name, containerName);

  let emulator: EmulatorSession | undefined;
  try {
    emulator = await startEmulatorWithIdentity(emulatorOptions, containerName, {
      [MANAGED_CONTAINER_LABEL]: "true",
      [SESSION_CONTAINER_LABEL]: name,
    });
    if (init && initOptions) {
      const childEnvironment = createChildEnvironment(process.env, emulator.environment, initOptions);
      const exitCode = await runCommand(init.command, init.args ?? [], childEnvironment, options.signal, init.shell ?? false);
      if (exitCode !== 0) {
        throw new Error(`Emulator session "${name}" initialization command failed with exit code ${exitCode}.`);
      }
    }
    const record: RunningSessionRecord = {
      schemaVersion: 1,
      name,
      state: "running",
      containerName,
      containerId: emulator.containerId,
      version: emulator.version,
      port: emulator.port,
    };
    await writeRunningSession(stateDirectory, record);
    throwIfAborted(options.signal);
    const { containerId: _containerId, stop: _stop, ...publicSession } = emulator;
    return { name, ...publicSession };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (emulator) {
      try {
        await emulator.stop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!(error instanceof AggregateError) && cleanupErrors.length === 0) {
      try {
        await removeSession(stateDirectory, name);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `Failed to start emulator session "${name}" and clean up its state.`);
    }
    throw error;
  }
}

type InspectedSessionContainer = { containerId: string; running: boolean };

async function inspectSessionContainer(name: string, containerName: string): Promise<InspectedSessionContainer | undefined> {
  let details: string;
  try {
    details = await docker([
      "inspect",
      "--format",
      `{{.Id}}|{{.State.Running}}|{{index .Config.Labels "${MANAGED_CONTAINER_LABEL}"}}|{{index .Config.Labels "${SESSION_CONTAINER_LABEL}"}}`,
      containerName,
    ], { capture: true });
  } catch (error) {
    if (error instanceof Error && /no such (?:container|object)/i.test(error.message)) return undefined;
    throw error;
  }

  const [containerId, running, managed, sessionName] = details.split("|");
  if (managed !== "true" || sessionName !== name) {
    throw new Error(`Docker container "${containerName}" is not owned by emulator session "${name}".`);
  }
  if (!containerId || !/^[a-f0-9]{12,64}$/i.test(containerId)) {
    throw new Error(`Docker returned invalid session details for "${name}".`);
  }
  return { containerId, running: running === "true" };
}

export async function execEmulatorSession(
  name: string,
  command: string,
  args: string[] = [],
  options: EmulatorSessionExecOptions = {},
): Promise<number> {
  if (!command) throw new Error("A command is required.");
  validateSessionName(name);
  const { signal, shell = false, sdks: requestedSdks = [], region } = options;
  const childRegion = resolveAwsRegion(region);
  const sdks = normalizeEmulatorSdks(requestedSdks);
  const stateDirectory = emulatorStateDirectory();
  const session = await readSession(stateDirectory, name);
  if (session.state !== "running") {
    throw new Error(`Emulator session "${name}" is still starting. Wait for "awesome-emulator up" to finish before running commands.`);
  }
  const container = await inspectSessionContainer(name, session.containerName);
  if (!container) {
    throw new Error(`Emulator session "${name}" is stale. Run "awesome-emulator down --session ${name}" to remove it.`);
  }
  if (container.containerId !== session.containerId) {
    throw new Error(`Emulator session "${name}" no longer matches its Docker container. Run "awesome-emulator down --session ${name}" to remove it.`);
  }
  if (!container.running) {
    throw new Error(`Emulator session "${name}" is not running. Run "awesome-emulator down --session ${name}" to remove it.`);
  }

  const emulator = createEmulatorConnectionSettings(session.port, stateDirectory);
  const childEnvironment = createChildEnvironment(process.env, emulator.environment, { sdks, region: childRegion });
  return runCommand(command, args, childEnvironment, signal, shell);
}

export async function downEmulatorSession(name: string): Promise<void> {
  validateSessionName(name);
  const stateDirectory = emulatorStateDirectory();
  const session = await readSession(stateDirectory, name);
  if (session.state === "starting" && isSessionOwnerRunning(session)) {
    throw new Error(`Emulator session "${name}" is still starting. Retry after "awesome-emulator up" finishes.`);
  }

  const container = await inspectSessionContainer(name, session.containerName);
  if (container) await stopContainer(container.containerId);
  await removeSession(stateDirectory, name);
}

/**
 * Run a child process with AWS Emulator settings and stop the emulator afterward.
 */
export async function runWithEmulator(command: string, args: string[] = [], options: RunWithEmulatorOptions = {}): Promise<number> {
  if (!command) throw new Error("A command is required.");
  const { shell = false, sdks: requestedSdks = [], region, ...emulatorOptions } = options;
  const childRegion = resolveAwsRegion(region);
  const sdks = normalizeEmulatorSdks(requestedSdks);
  return withEmulator(() => startEmulator(emulatorOptions), async (emulator) => {
    const childEnvironment = createChildEnvironment(process.env, emulator.environment, { sdks, region: childRegion });
    return runCommand(command, args, childEnvironment, emulatorOptions.signal, shell);
  });
}
