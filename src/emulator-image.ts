import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { docker, isMissingDockerResource, throwIfAborted, type DockerRunner } from "./docker.js";

export type EmulatorArchitecture = { docker: "amd64" | "arm64"; rpm: "x86_64" | "aarch64" };

const PACKAGE_ROOT = "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS";
const PACKAGE_SIGNING_KEY = "https://downloads.aws.com/keys/gpg/current.asc";
const PACKAGE_SIGNING_FINGERPRINT = "98BCF336A3BE53B734E967C52E5BF49BD940F624";
export const EMULATOR_CONTAINER_PORT = 9297;

export function getArchitecture(architecture = process.arch): EmulatorArchitecture {
  if (architecture === "x64") return { docker: "amd64", rpm: "x86_64" };
  if (architecture === "arm64") return { docker: "arm64", rpm: "aarch64" };
  throw new Error(`AWS Emulator is not available for this architecture: ${architecture}.`);
}

export function createEmulatorDockerfile(): string {
  return `FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
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
    fingerprint="$(gpg --batch --with-colons --fingerprint "${PACKAGE_SIGNING_FINGERPRINT}" | awk -F: '$1 == "fpr" { print $10; exit }')"; \\
    test "$fingerprint" = "${PACKAGE_SIGNING_FINGERPRINT}"; \\
    gpg --batch --export "$fingerprint" > /tmp/aws-publishing.gpg; \\
    gpgv --keyring /tmp/aws-publishing.gpg /tmp/aws-emulator.rpm.sig /tmp/aws-emulator.rpm; \\
    dnf remove -y gnupg2-smime; \\
    dnf swap -y gnupg2-full gnupg2-minimal; \\
    rpm -i /tmp/aws-emulator.rpm; \\
    mkdir -p /home/emulator/.aws/emulator; \\
    chown -R 1000:1000 /home/emulator; \\
    rm -rf "$GNUPGHOME" /tmp/aws-emulator.rpm /tmp/aws-emulator.rpm.sig /tmp/aws-publishing.asc /tmp/aws-publishing.gpg; \\
    dnf clean all
USER 1000:1000
ENV HOME=/home/emulator
EXPOSE ${EMULATOR_CONTAINER_PORT}
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
`;
}

export function createEmulatorImageTag(
  version: string,
  architecture: EmulatorArchitecture,
  dockerfile: string,
): string {
  const buildDefinitionHash = createHash("sha256")
    .update(JSON.stringify({
      dockerfile,
      version,
      dockerArchitecture: architecture.docker,
      rpmArchitecture: architecture.rpm,
    }))
    .digest("hex");

  return `awesome-emulator-cli:${version}-${architecture.docker}-${buildDefinitionHash}`;
}

export async function ensureEmulatorImage(
  version: string,
  architecture: EmulatorArchitecture,
  signal?: AbortSignal,
  runDocker: DockerRunner = docker,
): Promise<string> {
  throwIfAborted(signal);
  const dockerfile = createEmulatorDockerfile();
  const image = createEmulatorImageTag(version, architecture, dockerfile);
  try {
    await runDocker(["image", "inspect", image], { capture: true, signal });
    throwIfAborted(signal);
    return image;
  } catch (error) {
    throwIfAborted(signal);
    if (!isMissingDockerResource(error, "image")) throw error;
    // Build the official Linux package into a local image on first use.
  }

  const context = await mkdtemp(path.join(os.tmpdir(), "awesome-emulator-cli-"));

  try {
    throwIfAborted(signal);
    await writeFile(path.join(context, "Dockerfile"), dockerfile, "utf8");
    await runDocker([
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
