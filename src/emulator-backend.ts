import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { EMULATOR_BACKENDS, type EmulatorBackend, type ResolvedEmulatorBackend } from "./emulator-options.js";

export type NativePackageFormat = "deb" | "rpm";

type BackendHost = {
  platform: NodeJS.Platform;
  architecture: string;
  glibcVersion?: string;
  path?: string;
};

function findExecutable(name: string, pathValue = process.env.PATH ?? ""): string | undefined {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Keep checking the remaining PATH entries.
    }
  }
  return undefined;
}

export function getNativePackageFormat(pathValue = process.env.PATH ?? ""): NativePackageFormat | undefined {
  if (findExecutable("dpkg-deb", pathValue)) return "deb";
  if (findExecutable("rpm2cpio", pathValue) && findExecutable("cpio", pathValue)) return "rpm";
  return undefined;
}

export function getRuntimeGlibcVersion(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function nativeBackendUnavailableReasons(host: BackendHost = {
  platform: process.platform,
  architecture: process.arch,
  glibcVersion: getRuntimeGlibcVersion(),
}): string[] {
  if (host.platform !== "linux") return ["native execution is supported only on Linux"];
  if (host.architecture !== "x64" && host.architecture !== "arm64") {
    return ["unsupported CPU architecture: " + host.architecture];
  }
  const reasons: string[] = [];
  if (!host.glibcVersion || compareVersions(host.glibcVersion, "2.17") < 0) {
    reasons.push("AWS Emulator requires glibc 2.17 or later");
  }
  if (!findExecutable("gpg", host.path)) reasons.push("GnuPG (gpg) is required to verify the AWS package");
  if (!getNativePackageFormat(host.path)) {
    reasons.push("install dpkg-deb, or install both rpm2cpio and cpio, to extract the AWS package without root");
  }
  return reasons;
}

export function resolveEmulatorBackend(value: EmulatorBackend | undefined): ResolvedEmulatorBackend {
  const backend = value ?? "docker";
  if (!(EMULATOR_BACKENDS as readonly string[]).includes(backend)) {
    throw new Error("Backend must be " + EMULATOR_BACKENDS.join(", ") + ".");
  }
  if (backend === "docker") return "docker";
  const reasons = nativeBackendUnavailableReasons();
  if (backend === "auto") return reasons.length === 0 ? "native" : "docker";
  if (reasons.length > 0) {
    throw new Error("Native AWS Emulator is unavailable: " + reasons.join("; ") + ".");
  }
  return "native";
}
