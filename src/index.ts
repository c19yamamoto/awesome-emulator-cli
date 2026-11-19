import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRetryableStop, startContainer, stopContainer, withEmulator } from "./container-lifecycle.js";
import { docker, throwIfAborted } from "./docker.js";
import { runCommand } from "./process.js";

export type StartEmulatorOptions = {
  version?: string;
  port?: number | string;
  telemetry?: string;
  memory?: string;
  startupTimeoutMs?: number;
  signal?: AbortSignal;
};

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

export type EmulatorEnvironment = {
  AWS_ENDPOINT_URL: string;
  AWS_SHARED_CREDENTIALS_FILE: string;
  AWS_CONFIG_FILE: string;
  AWS_CA_BUNDLE: string;
  AWS_EC2_METADATA_DISABLED: "true";
  AWS_REGION: string;
  AWS_DEFAULT_REGION: string;
  NODE_EXTRA_CA_CERTS: string;
};

type Architecture = { docker: "amd64" | "arm64"; rpm: "x86_64" | "aarch64" };

const DEFAULT_VERSION = "1.0.522";
const DEFAULT_PORT = 9297;
const DEFAULT_MEMORY = "2g";
const PACKAGE_ROOT = "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS";
const PACKAGE_SIGNING_KEY = "https://downloads.aws.com/keys/gpg/current.asc";
const PACKAGE_SIGNING_FINGERPRINT = "98BCF336A3BE53B734E967C52E5BF49BD940F624";
const CONTAINER_PORT = 9297;

function normalizeVersion(value: string | undefined): string {
  const version = value ?? process.env.AWS_EMULATOR_VERSION ?? DEFAULT_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
    throw new Error(`Invalid AWS Emulator version: ${version}. Use a version such as 1.0.522.`);
  }
  return String(version);
}

function normalizePort(value: number | string | undefined): number {
  const port = Number(value ?? process.env.AWS_EMULATOR_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}. Use a number from 0 to 65535.`);
  }
  return port;
}

function normalizeTelemetry(value: string | undefined): "on" | "off" {
  const telemetry = String(value ?? process.env.EMULATOR_TELEMETRY ?? "on").toLowerCase();
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

function getArchitecture(): Architecture {
  if (process.arch === "x64") return { docker: "amd64", rpm: "x86_64" };
  if (process.arch === "arm64") return { docker: "arm64", rpm: "aarch64" };
  throw new Error(`AWS Emulator is not available for this architecture: ${process.arch}.`);
}

async function ensureImage(version: string, architecture: Architecture, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const image = `awesome-emulator-cli:${version}-${architecture.docker}`;
  try {
    await docker(["image", "inspect", image], { capture: true, signal });
    throwIfAborted(signal);
    return image;
  } catch {
    throwIfAborted(signal);
    // Build the official Linux package into a local image on first use.
  }

  const context = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-cli-"));
  const dockerfile = `FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG AWS_EMULATOR_VERSION
ARG AWS_EMULATOR_RPM_ARCH
RUN set -eu; \\
    export GNUPGHOME=/tmp/aws-emulator-gnupg; \\
    mkdir -m 0700 "$GNUPGHOME"; \\
    dnf swap -y gnupg2-minimal gnupg2-full; \\
    curl -fsSLo /tmp/aws-emulator.rpm ${PACKAGE_ROOT}/aws-emulator-\${AWS_EMULATOR_VERSION}-1-\${AWS_EMULATOR_RPM_ARCH}.rpm; \\
    curl -fsSLo /tmp/aws-emulator.rpm.sig ${PACKAGE_ROOT}/aws-emulator-\${AWS_EMULATOR_VERSION}-1-\${AWS_EMULATOR_RPM_ARCH}.rpm.sig; \\
    curl -fsSLo /tmp/aws-publishing.asc ${PACKAGE_SIGNING_KEY}; \\
    gpg --batch --import /tmp/aws-publishing.asc; \\
    fingerprint="$(gpg --batch --with-colons --fingerprint ssm-publishing@amazon.com | awk -F: '$1 == "fpr" { print $10; exit }')"; \\
    test "$fingerprint" = "${PACKAGE_SIGNING_FINGERPRINT}"; \\
    gpg --batch --verify /tmp/aws-emulator.rpm.sig /tmp/aws-emulator.rpm; \\
    dnf swap -y gnupg2-full gnupg2-minimal; \\
    rpm -i /tmp/aws-emulator.rpm; \\
    mkdir -p /home/emulator/.aws/emulator; \\
    chown -R 1000:1000 /home/emulator; \\
    rm -rf "$GNUPGHOME" /tmp/aws-emulator.rpm /tmp/aws-emulator.rpm.sig /tmp/aws-publishing.asc; \\
    dnf clean all
USER 1000:1000
ENV HOME=/home/emulator
EXPOSE ${CONTAINER_PORT}
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
`;

  try {
    throwIfAborted(signal);
    await writeFile(path.join(context, "Dockerfile"), dockerfile, "utf8");
    await docker([
      "build",
      "--platform", `linux/${architecture.docker}`,
      "--build-arg", `AWS_EMULATOR_VERSION=${version}`,
      "--build-arg", `AWS_EMULATOR_RPM_ARCH=${architecture.rpm}`,
      "--tag", image,
      context,
    ], { signal });
    throwIfAborted(signal);
    return image;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
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
  const version = normalizeVersion(options.version);
  const requestedPort = normalizePort(options.port);
  const port = requestedPort === 0 ? await getAvailablePort() : requestedPort;
  throwIfAborted(options.signal);
  const telemetry = normalizeTelemetry(options.telemetry);
  const memory = normalizeMemory(options.memory);
  const startupTimeoutMs = normalizeStartupTimeout(options.startupTimeoutMs);
  const architecture = getArchitecture();
  const stateDirectory = path.join(os.homedir(), ".aws", "emulator");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

  const image = await ensureImage(version, architecture, options.signal);
  throwIfAborted(options.signal);
  const containerName = `awesome-emulator-cli-${process.pid}-${randomBytes(4).toString("hex")}`;
  const hostUser = process.platform === "linux"
    && typeof process.getuid === "function"
    && typeof process.getgid === "function"
    ? ["--user", `${process.getuid()}:${process.getgid()}`]
    : [];
  const runningContainerId = await startContainer(containerName, [
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
    ], options.signal, (id, signal) => waitUntilHealthy(id, port, stateDirectory, startupTimeoutMs, signal));
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
  const endpointUrl = `https://127.0.0.1:${port}`;
  const portDirectory = path.join(stateDirectory, String(port));
  const environment: EmulatorEnvironment = {
    AWS_ENDPOINT_URL: endpointUrl,
    AWS_SHARED_CREDENTIALS_FILE: path.join(portDirectory, "emulator_credentials"),
    AWS_CONFIG_FILE: path.join(portDirectory, "config"),
    AWS_CA_BUNDLE: path.join(portDirectory, "ca.pem"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
    NODE_EXTRA_CA_CERTS: path.join(portDirectory, "ca.pem"),
  };

  return {
    version,
    port,
    endpointUrl,
    healthCheckUrl: `${endpointUrl}/__admin/health`,
    configFile: environment.AWS_CONFIG_FILE,
    credentialsFile: environment.AWS_SHARED_CREDENTIALS_FILE,
    caFile: environment.AWS_CA_BUNDLE,
    environment,
    containerId: runningContainerId,
    stop,
  };
}

/**
 * Run a child process with AWS Emulator settings and stop the emulator afterward.
 */
export async function runWithEmulator(command: string, args: string[] = [], options: StartEmulatorOptions = {}): Promise<number> {
  if (!command) throw new Error("A command is required.");
  return withEmulator(() => startEmulator(options), async (emulator) => {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env, ...emulator.environment };
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_DEFAULT_PROFILE",
      "AWS_ROLE_ARN",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
      "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
    ]) {
      delete childEnvironment[key];
    }
    for (const key of Object.keys(childEnvironment)) {
      if (key.startsWith("AWS_ENDPOINT_URL_")) delete childEnvironment[key];
    }
    return runCommand(command, args, childEnvironment, options.signal);
  });
}
