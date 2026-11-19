import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmulatorDockerfile } from "../dist/emulator-image.js";

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

function gpgHomePath(tempDir) {
  if (process.platform !== "win32") return tempDir;
  const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(tempDir);
  assert.ok(windowsPath, `Expected a drive-qualified Windows temp path, got ${tempDir}`);
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
  skip: !isAvailable("gpg") || !isAvailable("gpgv") ? "requires gpg and gpgv" : false,
}, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gpg-"));
  const gnupgHome = gpgHomePath(tempDir);
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

    run("gpg", ["--batch", "--output", publisherKeyring, "--export", publisherFingerprint], env);
    run("gpg", [
      "--batch", "--yes", "--local-user", publisherFingerprint,
      "--output", publisherSignature, "--detach-sign", rpmPath,
    ], env);
    run("gpg", [
      "--batch", "--yes", "--local-user", attackerFingerprint,
      "--output", attackerSignature, "--detach-sign", rpmPath,
    ], env);

    run("gpgv", ["--keyring", publisherKeyring, publisherSignature, rpmPath], env);
    const attackerVerification = spawnSync(
      "gpgv",
      ["--keyring", publisherKeyring, attackerSignature, rpmPath],
      { encoding: "utf8", env },
    );
    assert.equal(attackerVerification.error, undefined, attackerVerification.error?.message);
    assert.notEqual(attackerVerification.status, 0, "gpgv accepted a signature from the unrelated key");
  } finally {
    spawnSync("gpgconf", ["--homedir", gnupgHome, "--kill", "gpg-agent"], { stdio: "ignore" });
    await rm(tempDir, { recursive: true, force: true });
  }
});
