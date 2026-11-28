import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmulatorDockerfile, createEmulatorImageTag } from "../dist/emulator-image.js";

test("keys cached emulator images by the build definition and arguments", () => {
  const version = "1.0.522";
  const architecture = { docker: "amd64", rpm: "x86_64" };
  const dockerfile = createEmulatorDockerfile();
  const tag = createEmulatorImageTag(version, architecture, dockerfile);

  assert.match(tag, /^awesome-emulator-cli:1\.0\.522-amd64-[a-f0-9]{64}$/);
  assert.equal(createEmulatorImageTag(version, architecture, dockerfile), tag);
  assert.notEqual(createEmulatorImageTag(version, architecture, `${dockerfile}\n`), tag);
  assert.notEqual(createEmulatorImageTag("1.0.523", architecture, dockerfile), tag);
  assert.notEqual(createEmulatorImageTag(version, { docker: "arm64", rpm: "aarch64" }, dockerfile), tag);
});

test("restricts RPM signature verification to the pinned publisher key", () => {
  const dockerfile = createEmulatorDockerfile();
  const verifyWithPinnedKey = "gpgv --keyring /tmp/aws-publishing.gpg /tmp/aws-emulator.rpm.sig /tmp/aws-emulator.rpm";

  assert.ok(dockerfile.includes('gpg --batch --with-colons --fingerprint "98BCF336A3BE53B734E967C52E5BF49BD940F624"'));
  assert.ok(dockerfile.includes('test "$fingerprint" = "98BCF336A3BE53B734E967C52E5BF49BD940F624"'));
  assert.ok(dockerfile.includes('gpg --batch --export "$fingerprint" > /tmp/aws-publishing.gpg'));
  assert.ok(dockerfile.includes(verifyWithPinnedKey));
  assert.ok(dockerfile.indexOf(verifyWithPinnedKey) < dockerfile.indexOf("rpm -i /tmp/aws-emulator.rpm"));
  assert.doesNotMatch(dockerfile, /\bgpg\s+(?:--batch\s+)?--verify\b/);
});

function run(command, args, env) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

function isAvailable(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function canGenerateGpgKey() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "gpg-agent-check-"));
  const env = { ...process.env, GNUPGHOME: gpgPath(tempDir), LC_ALL: "C" };
  try {
    const result = spawnSync("gpg", [
      "--batch", "--pinentry-mode", "loopback", "--passphrase", "",
      "--quick-generate-key", "GPG agent availability check <check@example.invalid>", "ed25519", "sign", "0",
    ], { encoding: "utf8", env });
    return !result.error && result.status === 0;
  } finally {
    spawnSync("gpgconf", ["--homedir", gpgPath(tempDir), "--kill", "gpg-agent"], { stdio: "ignore" });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function gpgPath(filePath) {
  if (process.platform !== "win32") return filePath;
  const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  assert.ok(windowsPath, `Expected a drive-qualified Windows path, got ${filePath}`);
  return `/${windowsPath[1].toLowerCase()}/${windowsPath[2].replaceAll("\\", "/")}`;
}

function getFingerprint(uid, env) {
  const output = run("gpg", ["--batch", "--with-colons", "--fingerprint", uid], env);
  const fingerprint = output
    .split(/\r?\n/)
    .map((line) => line.split(":"))
    .find(([recordType]) => recordType === "fpr")?.[9];
  assert.ok(fingerprint, `No fingerprint found for ${uid}`);
  return fingerprint;
}

test("rejects an RPM signature made by an unrelated key in the downloaded bundle", {
  skip: !isAvailable("gpg") || !isAvailable("gpgv")
    ? "requires gpg and gpgv"
    : canGenerateGpgKey() ? false : "requires a working gpg-agent for ephemeral test keys",
}, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gpg-"));
  const gnupgHome = gpgPath(tempDir);
  const env = { ...process.env, GNUPGHOME: gnupgHome, LC_ALL: "C" };

  try {
    const publisherUid = "Pinned publisher test <publisher@example.invalid>";
    const attackerUid = "Unrelated bundle key <attacker@example.invalid>";
    for (const uid of [publisherUid, attackerUid]) {
      run("gpg", [
        "--batch", "--pinentry-mode", "loopback", "--passphrase", "",
        "--quick-generate-key", uid, "ed25519", "sign", "0",
      ], env);
    }

    const publisherFingerprint = getFingerprint(publisherUid, env);
    const attackerFingerprint = getFingerprint(attackerUid, env);
    const publisherKeyring = path.join(tempDir, "publisher.gpg");
    const rpmPath = path.join(tempDir, "test.rpm");
    const publisherSignature = path.join(tempDir, "publisher.sig");
    const attackerSignature = path.join(tempDir, "attacker.sig");
    await writeFile(rpmPath, "disposable test RPM payload\n");

    run("gpg", ["--batch", "--output", gpgPath(publisherKeyring), "--export", publisherFingerprint], env);
    run("gpg", [
      "--batch", "--yes", "--local-user", publisherFingerprint,
      "--output", gpgPath(publisherSignature), "--detach-sign", gpgPath(rpmPath),
    ], env);
    run("gpg", [
      "--batch", "--yes", "--local-user", attackerFingerprint,
      "--output", gpgPath(attackerSignature), "--detach-sign", gpgPath(rpmPath),
    ], env);

    run("gpgv", ["--keyring", gpgPath(publisherKeyring), gpgPath(publisherSignature), gpgPath(rpmPath)], env);
    const attackerVerification = spawnSync(
      "gpgv",
      ["--keyring", gpgPath(publisherKeyring), gpgPath(attackerSignature), gpgPath(rpmPath)],
      { encoding: "utf8", env },
    );
    assert.equal(attackerVerification.error, undefined, attackerVerification.error?.message);
    assert.notEqual(attackerVerification.status, 0, "gpgv accepted a signature from the unrelated key");
  } finally {
    spawnSync("gpgconf", ["--homedir", gnupgHome, "--kill", "gpg-agent"], { stdio: "ignore" });
    await rm(tempDir, { recursive: true, force: true });
  }
});
