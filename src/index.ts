import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { createRetryableStop, startContainer, stopContainer, withEmulator } from "./container-lifecycle.js";
import { formatPortBinding, getPublishedPort, reserveContainerPort } from "./container-ports.js";
import { docker, isMissingDockerResource, throwIfAborted } from "./docker.js";
import {
  createChildEnvironment,
  createEmulatorConnectionSettings,
  EMULATOR_STATE_FILES,
  normalizeEmulatorSdks,
  resolveAwsRegion,
  type ChildEnvironmentOptions,
  type EmulatorEnvironment,
  type EmulatorSdk,
} from "./emulator-environment.js";
import { readEmulatorCredentialEnvironment } from "./emulator-credentials.js";
import { ensureEmulatorImage, getArchitecture, type EmulatorArchitecture } from "./emulator-image.js";
import { isSessionOwnerRunning, readSession, removeSession, reserveSession, validateSessionName, writeRunningSession, writeStartingNativeSession, type NativeRunningSessionRecord, type RunningSessionRecord } from "./session-store.js";
import { resolveEmulatorBackend } from "./emulator-backend.js";
import { ensureNativeEmulator, isNativeProcessRunning, removeNativeRuntimeHome, startNativeEmulator, stopNativeProcess, type NativeEmulatorStartupProcess } from "./native-emulator.js";
import {
  resolveEmulatorOptions,
  resolveEmulatorStateDirectory,
  resolveEmulatorCredentialsMode,
  resolveEmulatorVersion,
  type PrepareEmulatorOptions,
  type EmulatorCredentialsMode,
  type RunWithEmulatorOptions,
  type StartEmulatorOptions,
} from "./emulator-options.js";
import { runCommand } from "./process.js";

export type { PrepareEmulatorOptions, RunWithEmulatorOptions, StartEmulatorOptions } from "./emulator-options.js";
export type { EmulatorCredentialsMode } from "./emulator-options.js";
export type { EmulatorBackend } from "./emulator-options.js";
export type { EmulatorEnvironment, EmulatorSdk } from "./emulator-environment.js";

type EmulatorSessionBase = {
  version: string;
  port: number;
  endpointUrl: string;
  healthCheckUrl: string;
  configFile: string;
  credentialsFile: string;
  caFile: string;
  environment: EmulatorEnvironment;
  stop: () => Promise<void>;
};

export type EmulatorSession = EmulatorSessionBase & (
  | { backend: "docker"; containerId: string; processId?: never }
  | { backend: "native"; processId: number; containerId?: never }
);

type StartedEmulatorSession = EmulatorSession & {
  containerPort: number;
  processStartMarker?: string;
  runtimeHome?: string;
};

export type PersistentEmulatorSession = Omit<EmulatorSession, "containerId" | "processId" | "stop"> & { name: string };
export type EmulatorSessionExecOptions = Pick<RunWithEmulatorOptions, "shell" | "sdks" | "region" | "signal" | "stateDirectory" | "credentials">;
export type EmulatorSessionInitCommand = {
  command: string;
  args?: string[];
  shell?: boolean;
  sdks?: EmulatorSdk[];
  region?: string;
  credentials?: EmulatorCredentialsMode;
};
export type UpEmulatorSessionOptions = StartEmulatorOptions & { init?: EmulatorSessionInitCommand };

async function createCommandEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  emulatorEnvironment: EmulatorEnvironment,
  options: ChildEnvironmentOptions & { credentials?: EmulatorCredentialsMode } = {},
): Promise<NodeJS.ProcessEnv> {
  const { credentials, ...environmentOptions } = options;
  const credentialsMode = resolveEmulatorCredentialsMode(credentials);
  const childEnvironment = createChildEnvironment(parentEnvironment, emulatorEnvironment, environmentOptions);
  if (credentialsMode === "environment") {
    Object.assign(childEnvironment, await readEmulatorCredentialEnvironment(emulatorEnvironment.AWS_SHARED_CREDENTIALS_FILE));
  }
  return childEnvironment;
}

const MANAGED_CONTAINER_LABEL = "io.github.c19yamamoto.awesome-emulator-cli.managed";
const SESSION_CONTAINER_LABEL = "io.github.c19yamamoto.awesome-emulator-cli.session";
const HEALTH_CHECK_INTERVAL_MS = 250;
const CONTAINER_STATUS_CHECK_INTERVAL_MS = 1000;

/** Download and verify the selected runtime without starting an emulator. */
export async function prepareEmulatorImage(options: PrepareEmulatorOptions = {}): Promise<string> {
  throwIfAborted(options.signal);
  const version = resolveEmulatorVersion(options.version);
  const backend = resolveEmulatorBackend(options.backend);
  if (backend === "native") {
    return ensureNativeEmulator(version, options.signal);
  }
  return ensureEmulatorImage(version, getArchitecture(), options.signal);
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
  requestedPort: number;
  containerPort: number;
  stateDirectory: string;
  telemetry: "on" | "off";
};

function createContainerRunArguments({
  architecture,
  containerName,
  image,
  labels,
  memory,
  requestedPort,
  containerPort,
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
    "--publish", formatPortBinding(requestedPort, containerPort),
    "--mount", `type=bind,source=${stateDirectory},target=/home/emulator/.aws/emulator`,
    "--env", "HOME=/home/emulator",
    "--name", containerName,
    image,
    "-p", String(containerPort),
    "-t", telemetry,
  ];
}

async function isContainerRunning(containerId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const running = await docker(["inspect", "--format", "{{.State.Running}}", containerId], { capture: true, signal });
    return running === "true";
  } catch (error) {
    if (isMissingDockerResource(error, "container")) return false;
    throw error;
  }
}

async function waitUntilHealthy(
  containerId: string,
  hostPort: number,
  containerPort: number,
  stateDirectory: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const caFile = path.join(stateDirectory, String(containerPort), EMULATOR_STATE_FILES.caCertificate);
  let nextContainerCheck = 0;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const ca = await readFile(caFile);
      if (await requestHealth(hostPort, ca, signal)) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // The container creates its certificate before the health route is ready.
    }
    throwIfAborted(signal);

    if (Date.now() >= nextContainerCheck) {
      const running = await isContainerRunning(containerId, signal);
      if (!running) {
        const logs = await docker(["logs", "--tail", "100", containerId], { capture: true }).catch(() => "");
        throw new Error(`AWS Emulator container exited before becoming healthy.${logs ? `\n${logs}` : ""}`);
      }
      nextContainerCheck = Date.now() + CONTAINER_STATUS_CHECK_INTERVAL_MS;
    }
    await delay(Math.min(HEALTH_CHECK_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throwIfAborted(signal);
  const logs = await docker(["logs", "--tail", "100", containerId], { capture: true }).catch(() => "");
  throw new Error(`AWS Emulator did not become healthy within ${timeoutMs} ms.${logs ? `\n${logs}` : ""}`);
}

/**
 * Start AWS Emulator in a local Docker container.
 *
 * The returned object includes SDK environment variables and an idempotent
 * stop() function. Port 0 asks Docker to choose an available host port.
 */
async function startEmulatorWithIdentity(
  options: StartEmulatorOptions,
  containerName: string,
  labels: Record<string, string>,
  stateDirectory = resolveEmulatorStateDirectory(options.stateDirectory),
  persistent = false,
  onNativeSpawn?: (process: NativeEmulatorStartupProcess) => Promise<void>,
): Promise<StartedEmulatorSession> {
  throwIfAborted(options.signal);
  const { version, requestedPort, telemetry, memory, startupTimeoutMs } = resolveEmulatorOptions(options);
  let backend = resolveEmulatorBackend(options.backend);
  if (backend === "native" && options.memory !== undefined) {
    if (options.backend === "auto") backend = "docker";
    else {
      throw new Error("--memory is available only with the Docker backend.");
    }
  }
  if (backend === "native") {
    const native = await startNativeEmulator({
      version,
      port: requestedPort,
      telemetry,
      startupTimeoutMs,
      stateDirectory,
      signal: options.signal,
      persistent,
      onSpawn: onNativeSpawn,
    }, stateDirectory);
    return {
      version,
      backend: "native",
      port: native.port,
      containerPort: native.port,
      ...createEmulatorConnectionSettings(native.port, stateDirectory),
      processId: native.processId,
      processStartMarker: native.processStartMarker,
      runtimeHome: native.runtimeHome,
      stop: native.stop,
    };
  }

  let port = requestedPort;
  throwIfAborted(options.signal);
  const architecture = getArchitecture();
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

  const image = await ensureEmulatorImage(version, architecture, options.signal);
  throwIfAborted(options.signal);
  const containerPort = requestedPort === 0 ? await reserveContainerPort(stateDirectory) : requestedPort;
  const runArguments = createContainerRunArguments({
    architecture,
    containerName,
    image,
    labels,
    memory,
    requestedPort,
    containerPort,
    stateDirectory,
    telemetry,
  });
  const runningContainerId = await startContainer(containerName, runArguments, options.signal, async (id, signal) => {
    if (requestedPort === 0) port = await getPublishedPort(id, containerPort, signal);
    await waitUntilHealthy(id, port, containerPort, stateDirectory, startupTimeoutMs, signal);
  });
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
  const connectionSettings = createEmulatorConnectionSettings(port, stateDirectory, containerPort);

  return {
    version,
    backend: "docker",
    port,
    containerPort,
    ...connectionSettings,
    containerId: runningContainerId,
    stop,
  };
}

export async function startEmulator(options: StartEmulatorOptions = {}): Promise<EmulatorSession> {
  const containerName = `awesome-emulator-cli-${process.pid}-${randomBytes(4).toString("hex")}`;
  const {
    containerPort: _containerPort,
    processStartMarker: _processStartMarker,
    runtimeHome: _runtimeHome,
    ...session
  } = await startEmulatorWithIdentity(options, containerName, { [MANAGED_CONTAINER_LABEL]: "true" });
  return session;
}

export async function upEmulatorSession(
  name: string,
  options: UpEmulatorSessionOptions = {},
): Promise<PersistentEmulatorSession> {
  validateSessionName(name);
  const { init, ...emulatorOptions } = options;
  const initOptions = init
    ? {
      sdks: normalizeEmulatorSdks(init.sdks),
      region: resolveAwsRegion(init.region),
      credentials: resolveEmulatorCredentialsMode(init.credentials),
    }
    : undefined;
  if (init && !init.command) throw new Error("An initialization command is required.");
  const stateDirectory = resolveEmulatorStateDirectory(emulatorOptions.stateDirectory);
  let backend = resolveEmulatorBackend(emulatorOptions.backend);
  if (backend === "native" && emulatorOptions.memory !== undefined) {
    if (emulatorOptions.backend === "auto") backend = "docker";
    else throw new Error("--memory is available only with the Docker backend.");
  }
  const containerName = `awesome-emulator-cli-session-${randomBytes(4).toString("hex")}-${name}`;
  await reserveSession(stateDirectory, name, containerName);

  let emulator: StartedEmulatorSession | undefined;
  try {
    emulator = await startEmulatorWithIdentity({ ...emulatorOptions, backend }, containerName, {
      [MANAGED_CONTAINER_LABEL]: "true",
      [SESSION_CONTAINER_LABEL]: name,
    }, stateDirectory, true, backend === "native"
      ? (nativeProcess) => writeStartingNativeSession(
        stateDirectory,
        name,
        nativeProcess.processId,
        nativeProcess.processStartMarker,
        nativeProcess.runtimeHome,
      )
      : undefined);
    if (init && initOptions) {
      const childEnvironment = await createCommandEnvironment(process.env, emulator.environment, initOptions);
      const exitCode = await runCommand(init.command, init.args ?? [], childEnvironment, options.signal, init.shell ?? false, "stderr");
      if (exitCode !== 0) {
        throwIfAborted(options.signal);
        throw new Error(`Emulator session "${name}" initialization command failed with exit code ${exitCode}.`);
      }
    }
    const record: RunningSessionRecord | NativeRunningSessionRecord = emulator.backend === "native"
      ? {
        schemaVersion: 3,
        backend: "native",
        name,
        state: "running",
        containerName,
        processId: emulator.processId,
        processStartMarker: emulator.processStartMarker!,
        runtimeHome: emulator.runtimeHome!,
        version: emulator.version,
        port: emulator.port,
      }
      : {
        schemaVersion: 2,
        name,
        state: "running",
        containerName,
        containerId: emulator.containerId,
        version: emulator.version,
        port: emulator.port,
        containerPort: emulator.containerPort,
      };
    await writeRunningSession(stateDirectory, record);
    throwIfAborted(options.signal);
    const {
      containerId: _containerId,
      processId: _processId,
      processStartMarker: _processStartMarker,
      runtimeHome: _runtimeHome,
      containerPort: _containerPort,
      stop: _stop,
      ...publicSession
    } = emulator;
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
    if (isMissingDockerResource(error, "container")) return undefined;
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
  const { signal, shell = false, sdks: requestedSdks = [], region, stateDirectory: requestedStateDirectory } = options;
  const credentials = resolveEmulatorCredentialsMode(options.credentials);
  const childRegion = resolveAwsRegion(region);
  const sdks = normalizeEmulatorSdks(requestedSdks);
  const stateDirectory = resolveEmulatorStateDirectory(requestedStateDirectory);
  const session = await readSession(stateDirectory, name);
  if (session.state !== "running") {
    throw new Error(`Emulator session "${name}" is still starting. Wait for "awesome-emulator up" to finish before running commands.`);
  }
  if (session.schemaVersion === 3 && session.backend === "native") {
    if (!isNativeProcessRunning(session.processId, session.processStartMarker)) {
      throw new Error(`Emulator session "${name}" is stale. Run "awesome-emulator down --session ${name}" to remove it.`);
    }
  } else {
    if (!("containerId" in session)) {
      throw new Error(`Emulator session "${name}" has invalid Docker metadata. Run "awesome-emulator down --session ${name}" to remove it.`);
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
  }

  const emulator = createEmulatorConnectionSettings(session.port, stateDirectory, session.schemaVersion === 2 ? session.containerPort : session.port);
  const childEnvironment = await createCommandEnvironment(process.env, emulator.environment, {
    sdks,
    region: childRegion,
    credentials,
  });
  return runCommand(command, args, childEnvironment, signal, shell);
}

export async function downEmulatorSession(
  name: string,
  options: Pick<StartEmulatorOptions, "stateDirectory"> = {},
): Promise<void> {
  validateSessionName(name);
  const stateDirectory = resolveEmulatorStateDirectory(options.stateDirectory);
  const session = await readSession(stateDirectory, name);
  if (session.state === "starting" && isSessionOwnerRunning(session)) {
    throw new Error(`Emulator session "${name}" is still starting. Retry after "awesome-emulator up" finishes.`);
  }

  if (session.state === "starting" && session.schemaVersion === 2 && session.backend === "native") {
    await stopNativeProcess(session.processId, session.processStartMarker);
    await removeNativeRuntimeHome(stateDirectory, session.runtimeHome);
  } else if (session.state === "running" && session.schemaVersion === 3 && session.backend === "native") {
    await stopNativeProcess(session.processId, session.processStartMarker);
    await removeNativeRuntimeHome(stateDirectory, session.runtimeHome);
  } else {
    const container = await inspectSessionContainer(name, session.containerName);
    if (container) await stopContainer(container.containerId);
  }
  await removeSession(stateDirectory, name);
}

/**
 * Run a child process with AWS Emulator settings and stop the emulator afterward.
 */
export async function runWithEmulator(command: string, args: string[] = [], options: RunWithEmulatorOptions = {}): Promise<number> {
  if (!command) throw new Error("A command is required.");
  const { shell = false, sdks: requestedSdks = [], region, ...emulatorOptions } = options;
  const credentials = resolveEmulatorCredentialsMode(options.credentials);
  const childRegion = resolveAwsRegion(region);
  const sdks = normalizeEmulatorSdks(requestedSdks);
  return withEmulator(() => startEmulator(emulatorOptions), async (emulator) => {
    const childEnvironment = await createCommandEnvironment(process.env, emulator.environment, {
      sdks,
      region: childRegion,
      credentials,
    });
    return runCommand(command, args, childEnvironment, emulatorOptions.signal, shell);
  });
}
