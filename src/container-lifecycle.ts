import { docker, isMissingDockerResource, throwIfAborted, type DockerRunner } from "./docker.js";

export async function stopContainer(containerId: string, runDocker: DockerRunner = docker): Promise<void> {
  let stopError: unknown;
  try {
    await runDocker(["stop", "--time", "10", containerId], { capture: true });
  } catch (error) {
    if (isMissingDockerResource(error, "container")) return;
    stopError = error;
  }

  try {
    await runDocker(["rm", "--force", containerId], { capture: true });
  } catch (error) {
    if (isMissingDockerResource(error, "container")) return;
    const failures = stopError ? [stopError, error] : [error];
    throw new AggregateError(failures, `Failed to stop or remove Docker container ${containerId}.`);
  }
}

export function createRetryableStop(stop: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(stop).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

export async function startContainer(
  containerName: string,
  args: string[],
  signal: AbortSignal | undefined,
  waitUntilHealthy: (containerId: string, signal?: AbortSignal) => Promise<void>,
  runDocker: DockerRunner = docker,
): Promise<string> {
  throwIfAborted(signal);
  let cleanupTarget = containerName;
  try {
    const containerId = await runDocker(args, { capture: true, signal });
    if (!containerId) throw new Error("Docker did not return a container ID.");
    cleanupTarget = containerId;
    throwIfAborted(signal);
    await waitUntilHealthy(containerId, signal);
    throwIfAborted(signal);
    return containerId;
  } catch (startupError) {
    try {
      await stopContainer(cleanupTarget, runDocker);
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        `AWS Emulator startup failed (${startupError instanceof Error ? startupError.message : String(startupError)}) and Docker container cleanup also failed (${cleanupTarget}).`,
      );
    }
    throw startupError;
  }
}

export async function withEmulator<T extends { stop: () => Promise<void> }, R>(
  start: () => Promise<T>,
  run: (session: T) => Promise<R>,
): Promise<R> {
  const session = await start();
  try {
    return await run(session);
  } finally {
    await session.stop();
  }
}
