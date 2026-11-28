import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { docker, type DockerRunner } from "./docker.js";

const FIRST_EPHEMERAL_PORT = 49_152;
const PORT_LIMIT = 65_536;

export function formatPortBinding(requestedHostPort: number, containerPort: number): string {
  return requestedHostPort === 0
    ? `127.0.0.1::${containerPort}`
    : `127.0.0.1:${requestedHostPort}:${containerPort}`;
}

export function parsePublishedPort(value: string, containerPort: number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Docker did not report a valid host port for container port ${containerPort}/tcp.`);
  }
  return port;
}

export async function getPublishedPort(
  containerId: string,
  containerPort: number,
  signal?: AbortSignal,
  runDocker: DockerRunner = docker,
): Promise<number> {
  const publishedPort = await runDocker([
    "inspect",
    "--format",
    `{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort}}`,
    containerId,
  ], { capture: true, signal });
  return parsePublishedPort(publishedPort, containerPort);
}

export async function reserveContainerPort(stateDirectory: string): Promise<number> {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const port = randomInt(FIRST_EPHEMERAL_PORT, PORT_LIMIT);
    try {
      await mkdir(path.join(stateDirectory, String(port)), { mode: 0o700 });
      return port;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not reserve a unique AWS Emulator container port in the state directory.");
}
