import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RELEASES_URL = "https://api.github.com/repos/aws/aws-emulator/releases/latest";
const OPTIONS_FILE = new URL("../src/emulator-options.ts", import.meta.url);

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export async function updateEmulatorVersion({
  fetchImpl = fetch,
  optionsFile = OPTIONS_FILE,
  outputFile = process.env.GITHUB_OUTPUT,
  token = process.env.GITHUB_TOKEN,
  log = console.log,
} = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImpl(RELEASES_URL, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GitHub releases API returned ${response.status}.`);

  const release = await response.json();
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "");
  if (!match) throw new Error(`Unexpected AWS Emulator release tag: ${release.tag_name}.`);
  const upstreamVersion = match[1];

  const source = await readFile(optionsFile, "utf8");
  const defaultVersion = /^export const DEFAULT_VERSION = "(\d+\.\d+\.\d+)";$/m;
  const currentMatch = defaultVersion.exec(source);
  if (!currentMatch) throw new Error("Could not find DEFAULT_VERSION in src/emulator-options.ts.");

  const currentVersion = currentMatch[1];
  const updated = compareVersions(upstreamVersion, currentVersion) > 0;
  if (updated) {
    await writeFile(optionsFile, source.replace(defaultVersion, `export const DEFAULT_VERSION = "${upstreamVersion}";`));
    log(`Updated the default AWS Emulator version from ${currentVersion} to ${upstreamVersion}.`);
  } else {
    log(`The default AWS Emulator version ${currentVersion} is current.`);
  }

  if (outputFile) {
    await appendFile(outputFile, `updated=${updated}\nversion=${upstreamVersion}\n`);
  }

  return { updated, version: upstreamVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  updateEmulatorVersion().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
