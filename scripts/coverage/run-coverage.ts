import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { coverageThresholds, ignoredTestPaths } from "../../ignore-test-path.js";

type CounterSummary = { covered: number; total: number };
type SourceCoverage = { statements: CounterSummary; branches: CounterSummary };
type IstanbulFileCoverage = {
  path: string;
  s: Record<string, number>;
  statementMap: Record<string, { start: { line: number } }>;
  b: Record<string, number[]>;
};
type DecisionRuntimeData = {
  conditions: Array<{ true: number; false: number }>;
  combinations: Record<string, number>;
};
type ConditionData = Record<string, Record<string, DecisionRuntimeData>>;
type ReportStatus = { metricsPass: boolean; filesPass: boolean; testsPass: boolean };

const root = process.cwd();
const coverageDirectory = path.join(root, "coverage");
const conditionDirectory = path.join(coverageDirectory, "conditions");
const c8Executable = path.join(root, "node_modules", "c8", "bin", "c8.js");

function assertExclusionsAreJustified(): void {
  const paths = new Set<string>();
  for (const entry of ignoredTestPaths) {
    if (!entry || typeof entry.path !== "string" || !entry.path.startsWith("src/")) {
      throw new Error("Each coverage exclusion must name a repository-relative src/ path.");
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 12) {
      throw new Error(`Coverage exclusion ${entry.path} must have a specific reason of at least 12 characters.`);
    }
    if (paths.has(entry.path)) throw new Error(`Duplicate coverage exclusion: ${entry.path}`);
    paths.add(entry.path);
  }
}

function percent(covered: number, total: number): number {
  return total === 0 ? 100 : (covered / total) * 100;
}

function isExcluded(sourcePath: string): boolean {
  return ignoredTestPaths.some(({ path: ignoredPath }) =>
    sourcePath === ignoredPath || sourcePath.startsWith(ignoredPath.endsWith("/") ? ignoredPath : `${ignoredPath}/`));
}

function exclusionRows(): string[] {
  return ignoredTestPaths.length === 0
    ? ["None."]
    : ignoredTestPaths.map(({ path: excludedPath, reason }) => `- \`${excludedPath}\`: ${reason}`);
}

function status(actual: number, threshold: number): string {
  return actual + Number.EPSILON >= threshold ? "✅ Pass" : "❌ Fail";
}

function metricRow(name: string, actual: number, threshold: number): string {
  return `| ${name} | ${actual.toFixed(2)}% | ${threshold}% | ${status(actual, threshold)} |`;
}

function mergeConditionData(files: ConditionData[]): ConditionData {
  const merged: ConditionData = {};
  for (const file of files) {
    for (const [sourcePath, decisions] of Object.entries(file)) {
      const fileDecisions = merged[sourcePath] ??= {};
      for (const [id, incoming] of Object.entries(decisions)) {
        const existing = fileDecisions[id] ??= {
          conditions: incoming.conditions.map(() => ({ true: 0, false: 0 })),
          combinations: {},
        };
        incoming.conditions.forEach((outcome, index) => {
          existing.conditions[index].true += outcome.true;
          existing.conditions[index].false += outcome.false;
        });
        for (const [combination, count] of Object.entries(incoming.combinations)) {
          existing.combinations[combination] = (existing.combinations[combination] ?? 0) + count;
        }
      }
    }
  }
  return merged;
}

async function readConditionFiles(): Promise<ConditionData[]> {
  const names = await readdir(conditionDirectory).catch(() => []);
  const files: ConditionData[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    files.push(JSON.parse(await readFile(path.join(conditionDirectory, name), "utf8")) as ConditionData);
  }
  return files;
}

function calculateConditionMetrics(metadata: Record<string, Record<string, { conditionCount: number; possibleCombinations: string[] }>>, runtimeData: ConditionData) {
  let c2Covered = 0;
  let c2Total = 0;
  let mccCovered = 0;
  let mccTotal = 0;
  const uncoveredConditions: Array<{ sourcePath: string; decision: string; condition: number; true: number; false: number }> = [];
  const missedCombinations: Array<{ sourcePath: string; decision: string; combination: string }> = [];

  for (const [sourcePath, decisions] of Object.entries(metadata)) {
    if (isExcluded(sourcePath)) continue;
    for (const [id, { conditionCount, possibleCombinations }] of Object.entries(decisions)) {
      const observed = runtimeData[sourcePath]?.[id];
      const counts = observed?.conditions ?? Array.from({ length: conditionCount }, () => ({ true: 0, false: 0 }));
      const combinations = observed?.combinations ?? {};
      c2Total += conditionCount;
      counts.forEach((count, index) => {
        if (count.true > 0 && count.false > 0) c2Covered += 1;
        else uncoveredConditions.push({ sourcePath, decision: id, condition: index + 1, true: count.true, false: count.false });
      });

      mccTotal += possibleCombinations.length;
      for (const combination of possibleCombinations) {
        if (combinations[combination] > 0) mccCovered += 1;
        else missedCombinations.push({ sourcePath, decision: id, combination });
      }
    }
  }

  return {
    C2: { covered: c2Covered, total: c2Total, actual: percent(c2Covered, c2Total) },
    MCC: { covered: mccCovered, total: mccTotal, actual: percent(mccCovered, mccTotal) },
    uncoveredConditions,
    missedCombinations,
  };
}

function parseIstanbulCoverage(
  coverage: Record<string, IstanbulFileCoverage>,
  generatedStatementLines: Record<string, number[]>,
): Record<string, SourceCoverage> {
  const files: Record<string, SourceCoverage> = {};
  for (const [filename, fileCoverage] of Object.entries(coverage)) {
    const relative = path.relative(root, filename).split(path.sep).join("/");
    if (!relative.startsWith("dist/") || !relative.endsWith(".js")) continue;
    const sourcePath = `src/${relative.slice("dist/".length).replace(/\.js$/, ".ts")}`;
    if (isExcluded(sourcePath)) continue;
    const generatedLines = new Set(generatedStatementLines[sourcePath] ?? []);
    const statementEntries = Object.entries(fileCoverage.s).filter(([id]) => !generatedLines.has(fileCoverage.statementMap[id]?.start.line));
    const statements = {
      covered: statementEntries.filter(([, count]) => count > 0).length,
      total: statementEntries.length,
    };
    const branchCounters = Object.values(fileCoverage.b ?? {}).flat();
    files[sourcePath] = {
      statements,
      branches: { covered: branchCounters.filter((count) => count > 0).length, total: branchCounters.length },
    };
  }
  return files;
}

async function sourceFiles(directory = path.join(root, "src")): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(filename));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const sourcePath = path.relative(root, filename).split(path.sep).join("/");
      if (!isExcluded(sourcePath)) files.push(sourcePath);
    }
  }
  return files.sort();
}

function sumFiles(files: Record<string, SourceCoverage>, key: "statements" | "branches"): CounterSummary {
  return Object.values(files).reduce((sum, file) => ({
    covered: sum.covered + file[key].covered,
    total: sum.total + file[key].total,
  }), { covered: 0, total: 0 });
}

async function makeReport(testExitCode: number): Promise<ReportStatus> {
  const coveragePath = path.join(coverageDirectory, "coverage-final.json");
  const metadataPath = path.join(coverageDirectory, "condition-metadata.json");
  const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as Record<string, IstanbulFileCoverage>;
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, Record<string, { conditionCount: number; possibleCombinations: string[] }>>;
  const generatedStatementLines = JSON.parse(await readFile(path.join(coverageDirectory, "instrumented-statement-lines.json"), "utf8")) as Record<string, number[]>;
  const files = parseIstanbulCoverage(coverage, generatedStatementLines);
  for (const sourcePath of await sourceFiles()) {
    files[sourcePath] ??= { statements: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } };
  }

  const statements = sumFiles(files, "statements");
  const branches = sumFiles(files, "branches");
  const conditions = calculateConditionMetrics(metadata, mergeConditionData(await readConditionFiles()));
  const actual = {
    C0: percent(statements.covered, statements.total),
    C1: percent(branches.covered, branches.total),
    C2: conditions.C2.actual,
    MCC: conditions.MCC.actual,
  };
  const failingFiles = Object.entries(files)
    .map(([sourcePath, file]) => ({ sourcePath, actual: percent(file.branches.covered, file.branches.total) }))
    .filter(({ actual: branchCoverage }) => branchCoverage + Number.EPSILON < coverageThresholds.perFileC1)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  const metricsPass = Object.entries(actual).every(([metric, value]) => value + Number.EPSILON >= coverageThresholds[metric as keyof typeof actual]);
  const filesPass = failingFiles.length === 0;
  const testsPass = testExitCode === 0;
  const lines = [
    "## Coverage report",
    "",
    "| Metric | Actual coverage | Required threshold | Status |",
    "| --- | ---: | ---: | --- |",
    metricRow("C0 — Statement coverage", actual.C0, coverageThresholds.C0),
    metricRow("C1 — Branch coverage", actual.C1, coverageThresholds.C1),
    metricRow("C2 — Condition coverage", actual.C2, coverageThresholds.C2),
    metricRow("MCC — Multiple condition coverage", actual.MCC, coverageThresholds.MCC),
    "",
    `Tests: ${testsPass ? "✅ Pass" : `❌ Fail (exit ${testExitCode})`}`,
    `Per-file C1 minimum: ${coverageThresholds.perFileC1}% — ${filesPass ? "✅ Pass" : `❌ Fail (${failingFiles.length} file(s))`}`,
    "",
    "### Files below the per-file C1 minimum",
    "",
    ...(failingFiles.length === 0
      ? ["None."]
      : ["| Source file | Actual C1 |", "| --- | ---: |", ...failingFiles.map(({ sourcePath, actual: value }) => `| \`${sourcePath}\` | ${value.toFixed(2)}% |`)]),
    "",
    "### Coverage exclusions",
    "",
    ...exclusionRows(),
    "",
    "C2 counts each atomic condition only when the test run evaluates it as both true and false. MCC counts all truth vectors reachable under JavaScript's left-to-right `&&` and `||` short-circuit rules; `x` marks a condition skipped by the expression.",
  ];

  const report = `${lines.join("\n")}\n`;
  await writeFile(path.join(coverageDirectory, "report.md"), report);
  await writeFile(path.join(coverageDirectory, "summary.json"), `${JSON.stringify({ actual, thresholds: coverageThresholds, testsPass, metricsPass, filesPass, failingFiles, conditions }, null, 2)}\n`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) await appendFile(summaryFile, `${report}\n`);
  console.log(report);
  return { metricsPass, filesPass, testsPass };
}

assertExclusionsAreJustified();
await rm(coverageDirectory, { recursive: true, force: true });
await mkdir(conditionDirectory, { recursive: true });

const instrumentation = spawnSync(process.execPath, [path.join(root, ".coverage-tools", "scripts", "coverage", "instrument-conditions.js")], { cwd: root, stdio: "inherit" });
if (instrumentation.error || instrumentation.status !== 0) {
  const message = instrumentation.error?.message ?? `Instrumentation exited with status ${instrumentation.status ?? "unknown"}.`;
  const report = [
    "## Coverage report unavailable",
    "",
    "Coverage instrumentation failed before tests could run.",
    "",
    "```text",
    message,
    "```",
    "",
  ].join("\n");
  await writeFile(path.join(coverageDirectory, "report.md"), report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  console.error(report);
  process.exit(1);
}

const c8Arguments = [
  c8Executable,
  "--all",
  "--include", "dist/**/*.js",
  "--reporter=json",
  "--reporter=text-summary",
  "--reports-dir=coverage",
  "--clean=false",
];
for (const exclusion of ignoredTestPaths) {
  const sourcePattern = exclusion.path.endsWith("/") ? `${exclusion.path}**/*.ts` : exclusion.path;
  c8Arguments.push("--exclude", `dist/${sourcePattern.slice("src/".length).replace(/\.ts$/, ".js")}`);
}
c8Arguments.push(process.execPath, "--experimental-test-module-mocks", "--test");
const coverageRun = spawnSync(process.execPath, c8Arguments, {
  cwd: root,
  env: { ...process.env, CONDITION_COVERAGE_DIR: conditionDirectory },
  stdio: "inherit",
});
if (coverageRun.error) throw coverageRun.error;

let reportStatus: ReportStatus = { metricsPass: false, filesPass: false, testsPass: false };
try {
  reportStatus = await makeReport(coverageRun.status ?? 1);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const report = [
    "## Coverage report unavailable",
    "",
    "Coverage generation failed before a report could be produced.",
    "",
    "```text",
    message,
    "```",
    "",
  ].join("\n");
  await writeFile(path.join(coverageDirectory, "report.md"), report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  console.error(report);
  process.exitCode = 1;
}

if (!reportStatus.metricsPass || !reportStatus.filesPass || !reportStatus.testsPass) process.exitCode = 1;
