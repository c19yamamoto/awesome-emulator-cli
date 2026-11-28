import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { getNativePackageFormat, type NativePackageFormat } from "./emulator-backend.js";
import { createRetryableStop } from "./container-lifecycle.js";
import { getProcessStartMarker } from "./session-store.js";
import { throwIfAborted } from "./docker.js";

const PACKAGE_ROOT = "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS";
const SIGNING_KEY_URL = "https://downloads.aws.com/keys/gpg/current.asc";
const SIGNING_FINGERPRINT = "98BCF336A3BE53B734E967C52E5BF49BD940F624";
const NATIVE_CACHE_DIRECTORY_NAME = "awesome-emulator-cli";
const HEALTH_CHECK_INTERVAL_MS = 250;
const PROCESS_STOP_TIMEOUT_MS = 10_000;

export type NativeEmulatorSession = {
  processId: number;
  processStartMarker: string;
  port: number;
  runtimeHome: string;
  stop: () => Promise<void>;
};

export type NativeEmulatorStartupProcess = {
  processId: number;
  processStartMarker: string;
  port: number;
  runtimeHome: string;
};

type NativeStartOptions = {
  version: string;
  port: number;
  telemetry: "on" | "off";
  startupTimeoutMs: number;
  stateDirectory: string;
  signal?: AbortSignal;
  persistent?: boolean;
  onSpawn?: (process: NativeEmulatorStartupProcess) => Promise<void>;
};

type CachedPackageManifest = {
  version: string;
  architecture: string;
  fingerprint: string;
  executable: string;
};

type ProcessResult = { code: number | null; stdout: string; stderr: string };

function packageArchitecture(architecture = process.arch): { deb: string; rpm: string } {
  if (architecture === "x64") return { deb: "amd64", rpm: "x86_64" };
  if (architecture === "arm64") return { deb: "arm64", rpm: "aarch64" };
  throw new Error("AWS Emulator is not available for this architecture: " + architecture + ".");
}

function getPackageCacheDirectory(): string {
  const configuredCache = process.env.AWS_EMULATOR_CACHE_DIR;
  if (configuredCache !== undefined && configuredCache.trim().length === 0) {
    throw new Error("AWS Emulator cache directory must not be empty.");
  }
  if (configuredCache) return path.resolve(configuredCache);
  const cacheHome = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.resolve(cacheHome, NATIVE_CACHE_DIRECTORY_NAME);
}

function runCapture(command: string, args: string[], cwd: string | undefined, signal?: AbortSignal): Promise<ProcessResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      const result = current + chunk.toString("utf8");
      return result.length > 1_000_000 ? result.slice(-1_000_000) : result;
    };
    const onAbort = () => child.kill("SIGTERM");
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout, stderr });
    });
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

async function requireSuccessfulCommand(command: string, args: string[], cwd: string | undefined, signal?: AbortSignal): Promise<ProcessResult> {
  const result = await runCapture(command, args, cwd, signal);
  throwIfAborted(signal);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(command + " " + args.join(" ") + " failed" + (detail ? ": " + detail : "."));
  }
  return result;
}

async function downloadFile(url: string, filename: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error("Could not download AWS Emulator package asset (" + response.status + "): " + url);
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(filename, { flags: "wx", mode: 0o600 }),
    { signal },
  );
}

async function verifyPackage(packageFile: string, signatureFile: string, keyFile: string, gnupgHome: string, signal?: AbortSignal): Promise<void> {
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
  await requireSuccessfulCommand("gpg", ["--batch", "--homedir", gnupgHome, "--import", keyFile], undefined, signal);
  const fingerprintOutput = await requireSuccessfulCommand(
    "gpg",
    ["--batch", "--homedir", gnupgHome, "--with-colons", "--fingerprint"],
    undefined,
    signal,
  );
  const fingerprints = fingerprintOutput.stdout
    .split("\n")
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]?.toUpperCase());
  if (!fingerprints.includes(SIGNING_FINGERPRINT)) {
    throw new Error("AWS Emulator signing key fingerprint did not match the trusted AWS publishing key.");
  }
  const verification = await requireSuccessfulCommand(
    "gpg",
    ["--batch", "--homedir", gnupgHome, "--status-fd", "1", "--verify", signatureFile, packageFile],
    undefined,
    signal,
  );
  const verifiedSignatures = verification.stdout
    .split("\n")
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
    .map((line) => line.split(/\s+/).slice(2).map((fingerprint) => fingerprint.toUpperCase()));
  if (!verifiedSignatures.some((fingerprints) => fingerprints.includes(SIGNING_FINGERPRINT))) {
    throw new Error("AWS Emulator package signature was not made by the trusted AWS publishing key.");
  }
}

async function extractPackage(packageFile: string, format: NativePackageFormat, destination: string, signal?: AbortSignal): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (format === "deb") {
    await requireSuccessfulCommand("dpkg-deb", ["--extract", packageFile, destination], undefined, signal);
    return;
  }

  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const converter = spawn("rpm2cpio", [packageFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const extractor = spawn("cpio", ["-idm", "--no-absolute-filenames", "--no-preserve-owner"], {
      cwd: destination,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let converterError = "";
    let extractorError = "";
    let settled = false;
    converter.stderr?.on("data", (chunk: Buffer) => { converterError += chunk.toString("utf8"); });
    extractor.stderr?.on("data", (chunk: Buffer) => { extractorError += chunk.toString("utf8"); });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      converter.kill("SIGTERM");
      extractor.kill("SIGTERM");
      reject(error);
    };
    const onAbort = () => fail(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    converter.once("error", fail);
    extractor.once("error", fail);
    converter.stdout?.pipe(extractor.stdin!);
    converter.once("close", (converterCode) => {
      extractor.stdin?.end();
      extractor.once("close", (extractorCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal?.aborted) {
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        } else if (converterCode !== 0 || extractorCode !== 0) {
          const detail = extractorError.trim() || converterError.trim();
          reject(new Error("Could not extract the AWS Emulator RPM package" + (detail ? ": " + detail : ".")));
        } else {
          resolve();
        }
      });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function locateExecutable(root: string): Promise<string> {
  const candidates = [
    path.join(root, "opt", "aws-emulator", "bin", "aws-emulator"),
    path.join(root, "usr", "bin", "aws-emulator"),
  ];
  const resolvedRoot = await realpath(root);
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      if (executable !== resolvedRoot && !executable.startsWith(resolvedRoot + path.sep)) continue;
      const metadata = await stat(executable);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return executable;
    } catch {
      // Try another command path from the extracted package.
    }
  }
  throw new Error("The verified AWS Emulator package did not contain a runnable aws-emulator command.");
}

async function readCachedExecutable(cacheDirectory: string, version: string, architecture: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(cacheDirectory, "cache.json"), "utf8")) as CachedPackageManifest;
    if (manifest.version !== version || manifest.architecture !== architecture || manifest.fingerprint !== SIGNING_FINGERPRINT) return undefined;
    if (path.isAbsolute(manifest.executable) || manifest.executable.split(path.sep).includes("..")) return undefined;
    const executable = await realpath(path.join(cacheDirectory, "root", manifest.executable));
    const root = await realpath(path.join(cacheDirectory, "root"));
    if (executable !== root && !executable.startsWith(root + path.sep)) return undefined;
    const metadata = await stat(executable);
    return metadata.isFile() && (metadata.mode & 0o111) !== 0 ? executable : undefined;
  } catch {
    return undefined;
  }
}

function isPidActive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function acquireCacheLock(filename: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      await writeFile(filename, JSON.stringify({ pid: process.pid, token }) + "\n", { flag: "wx", mode: 0o600 });
      return async () => {
        try {
          const lock = JSON.parse(await readFile(filename, "utf8")) as { token?: string };
          if (lock.token === token) await rm(filename, { force: true });
        } catch {
          // A stale-lock cleanup may already have removed the file.
        }
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }

    try {
      const contents = JSON.parse(await readFile(filename, "utf8")) as { pid?: number };
      const metadata = await stat(filename);
      if (!isPidActive(Number(contents.pid)) || Date.now() - metadata.mtimeMs > 60 * 60_000) {
        await rm(filename, { force: true });
        continue;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      const metadata = await stat(filename).catch(() => undefined);
      if (metadata && Date.now() - metadata.mtimeMs > 30_000) {
        await rm(filename, { force: true });
        continue;
      }
    }
    await delay(250, undefined, { signal });
  }
  throw new Error("Timed out waiting for another process to prepare the AWS Emulator package cache.");
}

export async function ensureNativeEmulator(version: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const architecture = packageArchitecture();
  const format = getNativePackageFormat();
  if (!format) {
    throw new Error("Native AWS Emulator needs dpkg-deb, or both rpm2cpio and cpio, to extract the verified package without root.");
  }
  const packageArch = format === "deb" ? architecture.deb : architecture.rpm;
  const packageFilename = format === "deb"
    ? "aws-emulator_" + version + "-1_" + packageArch + ".deb"
    : "aws-emulator-" + version + "-1-" + packageArch + ".rpm";
  const cacheParent = path.join(getPackageCacheDirectory(), "packages", version);
  const cacheDirectory = path.join(cacheParent, format + "-" + packageArch);
  const cached = await readCachedExecutable(cacheDirectory, version, packageArch);
  if (cached) return cached;

  await mkdir(cacheParent, { recursive: true, mode: 0o700 });
  await chmod(cacheParent, 0o700);
  const releaseLock = await acquireCacheLock(cacheDirectory + ".lock", signal);
  try {
    const cacheAfterLock = await readCachedExecutable(cacheDirectory, version, packageArch);
    if (cacheAfterLock) return cacheAfterLock;
    const stagingPrefix = "." + format + "-" + packageArch + "-";
    for (const entry of await readdir(cacheParent)) {
      if (entry.startsWith(stagingPrefix)) {
        await rm(path.join(cacheParent, entry), { recursive: true, force: true });
      }
    }
    await rm(cacheDirectory, { recursive: true, force: true });
    const staging = await mkdtemp(path.join(cacheParent, "." + format + "-" + packageArch + "-"));
    const packageFile = path.join(staging, packageFilename);
    const signatureFile = packageFile + ".sig";
    const keyFile = path.join(staging, "aws-publishing.asc");
    const gnupgHome = path.join(staging, "gnupg");
    const root = path.join(staging, "root");
    try {
      const packageUrl = PACKAGE_ROOT + "/" + packageFilename;
      await downloadFile(SIGNING_KEY_URL, keyFile, signal);
      await downloadFile(packageUrl, packageFile, signal);
      await downloadFile(packageUrl + ".sig", signatureFile, signal);
      await verifyPackage(packageFile, signatureFile, keyFile, gnupgHome, signal);
      await extractPackage(packageFile, format, root, signal);
      const executable = await locateExecutable(root);
      const relativeExecutable = path.relative(root, executable);
      const manifest: CachedPackageManifest = {
        version,
        architecture: packageArch,
        fingerprint: SIGNING_FINGERPRINT,
        executable: relativeExecutable,
      };
      await writeFile(path.join(staging, "cache.json"), JSON.stringify(manifest) + "\n", { mode: 0o600 });
      await rm(gnupgHome, { recursive: true, force: true });
      await rm(packageFile, { force: true });
      await rm(signatureFile, { force: true });
      await rm(keyFile, { force: true });
      await rename(staging, cacheDirectory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const executable = await readCachedExecutable(cacheDirectory, version, packageArch);
    if (!executable) throw new Error("The AWS Emulator package cache was created but its command could not be verified.");
    return executable;
  } finally {
    await releaseLock();
  }
}

async function reserveNativePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not allocate a local AWS Emulator port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function createRuntimeHome(stateDirectory: string): Promise<string> {
  const runtimeParent = path.join(stateDirectory, ".awesome-emulator-cli-native");
  await mkdir(runtimeParent, { recursive: true, mode: 0o700 });
  const runtimeHome = await mkdtemp(path.join(runtimeParent, "home-"));
  try {
    const awsDirectory = path.join(runtimeHome, ".aws");
    await mkdir(awsDirectory, { mode: 0o700 });
    await symlink(stateDirectory, path.join(awsDirectory, "emulator"), "dir");
    return runtimeHome;
  } catch (error) {
    await rm(runtimeHome, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function removeNativeRuntimeHome(stateDirectory: string, runtimeHome: string): Promise<void> {
  const runtimeHomeRoot = path.resolve(stateDirectory, ".awesome-emulator-cli-native") + path.sep;
  const resolvedRuntimeHome = path.resolve(runtimeHome);
  if (!resolvedRuntimeHome.startsWith(runtimeHomeRoot)) {
    throw new Error("Refusing to remove a native runtime directory outside the emulator state directory.");
  }
  await rm(resolvedRuntimeHome, { recursive: true, force: true });
  await rmdir(path.dirname(resolvedRuntimeHome)).catch(() => {});
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

async function waitUntilHealthy(
  child: ChildProcess,
  port: number,
  stateDirectory: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const caFile = path.join(stateDirectory, String(port), "ca.pem");
  let exitDetails: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.once("exit", (code, processSignal) => { exitDetails = { code, signal: processSignal }; });
  child.once("error", (error) => { spawnError = error; });
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (spawnError) throw new Error("Could not start AWS Emulator: " + spawnError.message);
    if (exitDetails) {
      throw new Error("AWS Emulator process exited before becoming healthy (code " + exitDetails.code + ", signal " + exitDetails.signal + ").");
    }
    try {
      const ca = await readFile(caFile);
      if (await requestHealth(port, ca, signal)) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    throwIfAborted(signal);
    await delay(Math.min(HEALTH_CHECK_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throwIfAborted(signal);
  if (exitDetails) {
    throw new Error("AWS Emulator process exited before becoming healthy (code " + exitDetails.code + ", signal " + exitDetails.signal + ").");
  }
  throw new Error("AWS Emulator did not become healthy within " + timeoutMs + " ms.");
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, PROCESS_STOP_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 2_000))) {
    throw new Error("AWS Emulator process did not stop after SIGTERM and SIGKILL.");
  }
}

export async function startNativeEmulator(
  options: NativeStartOptions,
  stateDirectory: string,
): Promise<NativeEmulatorSession> {
  throwIfAborted(options.signal);
  const executable = await ensureNativeEmulator(options.version, options.signal);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const runtimeHome = await createRuntimeHome(stateDirectory);
  let child: ChildProcess | undefined;
  try {
    const port = options.port === 0 ? await reserveNativePort() : options.port;
    throwIfAborted(options.signal);
    const safeEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: runtimeHome,
    };
    if (process.env.TMPDIR) safeEnvironment.TMPDIR = process.env.TMPDIR;
    child = spawn(executable, ["-p", String(port), "-t", options.telemetry], {
      cwd: runtimeHome,
      env: safeEnvironment,
      detached: options.persistent ?? false,
      stdio: "ignore",
      windowsHide: true,
    });
    if (options.persistent) child.unref();
    const processStartMarker = child.pid ? getProcessStartMarker(child.pid) : undefined;
    if (!child.pid || !processStartMarker) {
      throw new Error("Could not identify the AWS Emulator process for safe cleanup.");
    }
    await options.onSpawn?.({ processId: child.pid, processStartMarker, port, runtimeHome });
    await waitUntilHealthy(child, port, stateDirectory, options.startupTimeoutMs, options.signal);
    throwIfAborted(options.signal);
    const stop = createRetryableStop(async () => {
      await stopChild(child!);
      await removeNativeRuntimeHome(stateDirectory, runtimeHome);
    });
    return {
      processId: child.pid,
      processStartMarker,
      port,
      runtimeHome,
      stop,
    };
  } catch (startupError) {
    if (child) {
      try {
        await stopChild(child);
      } catch (cleanupError) {
        await removeNativeRuntimeHome(stateDirectory, runtimeHome).catch(() => {});
        throw new AggregateError([startupError, cleanupError], "AWS Emulator startup failed and native process cleanup also failed.");
      }
    }
    await removeNativeRuntimeHome(stateDirectory, runtimeHome).catch(() => {});
    throw startupError;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

export function isNativeProcessRunning(pid: number, expectedStartMarker: string): boolean {
  if (!isProcessRunning(pid)) return false;
  const actualStartMarker = getProcessStartMarker(pid);
  if (!actualStartMarker) {
    throw new Error("Could not verify the AWS Emulator process. Ensure ps is available, then retry.");
  }
  return actualStartMarker === expectedStartMarker;
}

export async function stopNativeProcess(pid: number, expectedStartMarker: string): Promise<void> {
  if (!isProcessRunning(pid)) return;
  const initialMarker = getProcessStartMarker(pid);
  if (!initialMarker) throw new Error("Could not verify the AWS Emulator process before stopping it.");
  if (initialMarker !== expectedStartMarker) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(100);
    if (!isProcessRunning(pid)) return;
    const currentMarker = getProcessStartMarker(pid);
    if (currentMarker !== expectedStartMarker) return;
  }
  if (!isProcessRunning(pid) || getProcessStartMarker(pid) !== expectedStartMarker) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && isProcessRunning(pid) && getProcessStartMarker(pid) === expectedStartMarker) {
    await delay(50);
  }
  if (isProcessRunning(pid) && getProcessStartMarker(pid) === expectedStartMarker) {
    throw new Error("AWS Emulator process " + pid + " did not stop after SIGTERM and SIGKILL.");
  }
}
