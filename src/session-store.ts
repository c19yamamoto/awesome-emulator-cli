import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

const SESSION_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type StartingSessionRecord = {
  schemaVersion: 1;
  name: string;
  state: "starting";
  containerName: string;
  ownerPid: number;
  ownerStartMarker: string;
};

export type LegacyRunningSessionRecord = {
  schemaVersion: 1;
  name: string;
  state: "running";
  containerName: string;
  containerId: string;
  version: string;
  port: number;
};

export type RunningSessionRecord = {
  schemaVersion: 2;
  name: string;
  state: "running";
  containerName: string;
  containerId: string;
  version: string;
  /** Host port exposed to the caller. */
  port: number;
  /** Port used by AWS Emulator inside the container and state directory. */
  containerPort: number;
};

export type SessionRecord = StartingSessionRecord | LegacyRunningSessionRecord | RunningSessionRecord;

export function validateSessionName(name: string): string {
  if (!SESSION_NAME_PATTERN.test(name)) {
    throw new Error("Invalid session name. Use 1-63 lowercase letters, numbers, or hyphens; start and end with a letter or number.");
  }
  return name;
}

function getProcessStartMarker(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const isWindows = process.platform === "win32";
  const command = isWindows ? "powershell.exe" : "ps";
  const args = isWindows
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$process = [System.Diagnostics.Process]::GetProcessById(${pid}); $process.StartTime.ToUniversalTime().ToString('o')`]
    : ["-o", "lstart=", "-p", String(pid)];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    timeout: isWindows ? 15_000 : 2_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export function isSessionOwnerRunning(
  record: StartingSessionRecord,
  readStartMarker: (pid: number) => string | undefined = getProcessStartMarker,
  checkRunning: (pid: number) => boolean = isProcessRunning,
): boolean {
  const currentStartMarker = readStartMarker(record.ownerPid);
  if (currentStartMarker) return record.ownerStartMarker === currentStartMarker;
  if (checkRunning(record.ownerPid)) {
    throw new Error(`Could not verify the owner process for emulator session "${record.name}". Ensure ${process.platform === "win32" ? "Windows PowerShell" : "ps"} is available, then retry.`);
  }
  return false;
}

function sessionPath(stateDirectory: string, name: string): string {
  return path.join(stateDirectory, "sessions", `${validateSessionName(name)}.json`);
}

export async function reserveSession(
  stateDirectory: string,
  name: string,
  containerName: string,
  readStartMarker: (pid: number) => string | undefined = getProcessStartMarker,
): Promise<string> {
  const filename = sessionPath(stateDirectory, name);
  const ownerStartMarker = readStartMarker(process.pid);
  if (!ownerStartMarker) {
    throw new Error(`Could not identify the startup process. Ensure ${process.platform === "win32" ? "Windows PowerShell" : "ps"} is available to manage persistent sessions.`);
  }
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const record: StartingSessionRecord = {
    schemaVersion: 1,
    name,
    state: "starting",
    containerName,
    ownerPid: process.pid,
    ownerStartMarker,
  };
  try {
    await writeFile(filename, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Emulator session "${name}" already exists. Stop it with "awesome-emulator down --session ${name}" before reusing the name.`);
    }
    throw error;
  }
  return filename;
}

export async function writeRunningSession(stateDirectory: string, record: RunningSessionRecord): Promise<void> {
  validateSessionName(record.name);
  const filename = sessionPath(stateDirectory, record.name);
  const temporaryFilename = `${filename}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryFilename, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryFilename, filename);
  } finally {
    await unlink(temporaryFilename).catch(() => {});
  }
}

export async function readSession(stateDirectory: string, name: string): Promise<SessionRecord> {
  const filename = sessionPath(stateDirectory, name);
  let contents: string;
  try {
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Emulator session "${name}" was not found. Start it with "awesome-emulator up --session ${name}".`);
    }
    throw error;
  }

  let record: unknown;
  try {
    record = JSON.parse(contents);
  } catch {
    throw new Error(`Emulator session "${name}" has invalid metadata. Remove its session file before continuing.`);
  }
  if (!isSessionRecord(record, name)) {
    throw new Error(`Emulator session "${name}" has invalid metadata. Remove its session file before continuing.`);
  }
  return record;
}

export async function removeSession(stateDirectory: string, name: string): Promise<void> {
  try {
    await unlink(sessionPath(stateDirectory, name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function isSessionRecord(value: unknown, expectedName: string): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.name !== expectedName || typeof record.containerName !== "string") return false;
  if (!record.containerName.startsWith("awesome-emulator-cli-session-") || !record.containerName.endsWith(`-${record.name}`)) return false;
  if (record.state === "starting") {
    return record.schemaVersion === 1
      && Number.isSafeInteger(record.ownerPid)
      && Number(record.ownerPid) > 0
      && typeof record.ownerStartMarker === "string"
      && record.ownerStartMarker.length > 0;
  }
  if (record.state !== "running") return false;
  const validRunningRecord = typeof record.containerId === "string"
    && /^[a-f0-9]{12,64}$/i.test(record.containerId)
    && typeof record.version === "string"
    && Number.isInteger(record.port)
    && Number(record.port) > 0
    && Number(record.port) <= 65535;
  if (!validRunningRecord) return false;
  if (record.schemaVersion === 1) return true;
  return record.schemaVersion === 2
    && Number.isInteger(record.containerPort)
    && Number(record.containerPort) > 0
    && Number(record.containerPort) <= 65535;
}
