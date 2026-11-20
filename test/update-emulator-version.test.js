import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updateEmulatorVersion } from "../scripts/update-emulator-version.js";

async function createFixture({ currentVersion = "1.2.3", packageVersion = "0.1.2" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aws-emulator-version-test-"));
  const optionsFile = join(directory, "emulator-options.ts");
  const packageFile = join(directory, "package.json");
  const outputFile = join(directory, "github-output");
  await writeFile(optionsFile, `export const DEFAULT_VERSION = "${currentVersion}";\n`);
  await writeFile(packageFile, JSON.stringify({ version: packageVersion }));
  return { directory, optionsFile, packageFile, outputFile };
}

function mockResponse(tagName, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { tag_name: tagName };
    },
  };
}

test("updates the default version and outputs the next minor wrapper version", async () => {
  const fixture = await createFixture({ currentVersion: "1.2.3", packageVersion: "0.4.2" });
  let request;

  try {
    const result = await updateEmulatorVersion({
      fetchImpl: async (...args) => {
        request = args;
        return mockResponse("v1.3.0");
      },
      ...fixture,
      token: "test-token",
      log() {},
    });

    assert.deepEqual(result, { updated: true, version: "1.3.0", releaseAs: "0.5.0" });
    assert.equal(await readFile(fixture.optionsFile, "utf8"), 'export const DEFAULT_VERSION = "1.3.0";\n');
    assert.equal(await readFile(fixture.outputFile, "utf8"), "updated=true\nversion=1.3.0\nrelease_as=0.5.0\n");
    assert.equal(request[1].headers.Authorization, "Bearer test-token");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("does not downgrade the default version", async () => {
  const fixture = await createFixture({ currentVersion: "1.3.0" });

  try {
    const result = await updateEmulatorVersion({
      fetchImpl: async () => mockResponse("1.2.9"),
      ...fixture,
      log() {},
    });

    assert.equal(result.updated, false);
    assert.equal(await readFile(fixture.optionsFile, "utf8"), 'export const DEFAULT_VERSION = "1.3.0";\n');
    assert.equal(await readFile(fixture.outputFile, "utf8"), "updated=false\nversion=1.2.9\nrelease_as=0.2.0\n");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects an upstream release tag that is not a stable semantic version", async () => {
  const fixture = await createFixture();

  try {
    await assert.rejects(
      updateEmulatorVersion({ fetchImpl: async () => mockResponse("v1.3.0-rc.1"), ...fixture, log() {} }),
      /Unexpected AWS Emulator release tag/,
    );
    assert.equal(await readFile(fixture.optionsFile, "utf8"), 'export const DEFAULT_VERSION = "1.2.3";\n');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reports a failed GitHub releases API response", async () => {
  const fixture = await createFixture();

  try {
    await assert.rejects(
      updateEmulatorVersion({ fetchImpl: async () => mockResponse("", 503), ...fixture, log() {} }),
      /GitHub releases API returned 503/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reports when the default version declaration is missing", async () => {
  const fixture = await createFixture();
  await writeFile(fixture.optionsFile, "export const OTHER_VERSION = \"1.2.3\";\n");

  try {
    await assert.rejects(
      updateEmulatorVersion({ fetchImpl: async () => mockResponse("1.3.0"), ...fixture, log() {} }),
      /Could not find DEFAULT_VERSION/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
