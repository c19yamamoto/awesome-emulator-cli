import { readFileSync } from "node:fs";

const checks = JSON.parse(readFileSync(0, "utf8"));
const operatingSystems = ["ubuntu-latest", "macos-latest", "windows-latest"];
const nodeVersions = ["22", "24", "26"];
const expectedChecks = [
  ["CI", "integration"],
  ...operatingSystems.flatMap((operatingSystem) => nodeVersions.map((version) => [
    "CI",
    `test (${operatingSystem}, ${version})`,
  ])),
  ["PR title", "lint"],
  ["SDK smoke", "sdk-smoke"],
];
const failedStates = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "STALE",
  "TIMED_OUT",
]);
const pendingStates = new Set(["IN_PROGRESS", "PENDING", "QUEUED"]);

if (checks.some(({ state }) => failedStates.has(state))) {
  process.stdout.write("failed\n");
  process.exit(0);
}

const expectedChecksPassed = expectedChecks.every(([workflow, name]) => checks.some((check) => (
  check.workflow === workflow && check.name === name && check.state === "SUCCESS"
)));
const checksStillRunning = checks.some(({ state }) => pendingStates.has(state));

process.stdout.write(`${expectedChecksPassed && !checksStillRunning ? "ready" : "waiting"}\n`);
