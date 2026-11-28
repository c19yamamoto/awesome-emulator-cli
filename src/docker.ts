import { spawn, type SpawnOptions } from "node:child_process";

export type DockerOptions = {
  capture?: boolean;
  signal?: AbortSignal;
};

export type DockerRunner = (args: string[], options?: DockerOptions) => Promise<string>;

export class DockerCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const detail = (stderr || stdout).trim();
    super(`docker ${args[0]} failed${signal ? ` (${signal})` : ` with exit code ${exitCode}`}${detail ? `:\n${detail}` : "."}`);
    this.name = "DockerCommandError";
  }
}

export function isMissingDockerResource(error: unknown, resource: "container" | "image"): boolean {
  const output = error instanceof DockerCommandError
    ? `${error.stderr}\n${error.stdout}`
    : error instanceof Error ? error.message : "";
  const pattern = resource === "container" ? /no such (?:container|object)/i : /no such (?:image|object)/i;
  return pattern.test(output);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const suffix = signal.reason ? ` (${String(signal.reason)})` : "";
  const error = new Error(`Operation aborted${suffix}.`);
  error.name = "AbortError";
  throw error;
}

export const docker: DockerRunner = (args, { capture = false, signal } = {}) => new Promise((resolve, reject) => {
  const options: SpawnOptions = {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  };
  if (signal) options.signal = signal;

  const child = spawn("docker", args, options);
  let stdout = "";
  let stderr = "";
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };

  if (capture && child.stdout && child.stderr) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
  }

  child.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      fail(new Error("Docker was not found. Install Docker Desktop or Docker Engine and make sure `docker` is on PATH."));
    } else {
      fail(error);
    }
  });
  child.once("close", (code: number | null, signalName: NodeJS.Signals | null) => {
    if (settled) return;
    if (code === 0) {
      settled = true;
      resolve(stdout.trim());
      return;
    }
    fail(new DockerCommandError(args, code, signalName, stdout, stderr));
  });
});
