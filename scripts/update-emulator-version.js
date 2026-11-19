import { appendFile, readFile, writeFile } from "node:fs/promises";

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

async function main() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(RELEASES_URL, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GitHub releases API returned ${response.status}.`);

  const release = await response.json();
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "");
  if (!match) throw new Error(`Unexpected AWS Emulator release tag: ${release.tag_name}.`);
  const upstreamVersion = match[1];

  const source = await readFile(OPTIONS_FILE, "utf8");
  const defaultVersion = /^export const DEFAULT_VERSION = "(\d+\.\d+\.\d+)";$/m;
  const currentMatch = defaultVersion.exec(source);
  if (!currentMatch) throw new Error("Could not find DEFAULT_VERSION in src/emulator-options.ts.");

  const currentVersion = currentMatch[1];
  const updated = compareVersions(upstreamVersion, currentVersion) > 0;
  if (updated) {
    await writeFile(OPTIONS_FILE, source.replace(defaultVersion, `export const DEFAULT_VERSION = "${upstreamVersion}";`));
    console.log(`Updated the default AWS Emulator version from ${currentVersion} to ${upstreamVersion}.`);
  } else {
    console.log(`The default AWS Emulator version ${currentVersion} is current.`);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `updated=${updated}\nversion=${upstreamVersion}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
