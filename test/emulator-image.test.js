import assert from "node:assert/strict";
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
