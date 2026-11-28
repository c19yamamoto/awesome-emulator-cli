import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import { ignoredTestPaths } from "../../ignore-test-path.js";
import { enumerateReachableCombinations, type BooleanConditionTree } from "./condition-logic.js";

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

const root = process.cwd();
const distDirectory = path.join(root, "dist");
const coverageDirectory = path.join(root, "coverage");
const metadata: Record<string, Record<string, { conditionCount: number; possibleCombinations: string[] }>> = {};
const generatedStatementLines: Record<string, number[]> = {};

function isExcluded(sourcePath: string): boolean {
  return ignoredTestPaths.some(({ path: ignoredPath }) =>
    sourcePath === ignoredPath || sourcePath.startsWith(ignoredPath.endsWith("/") ? ignoredPath : `${ignoredPath}/`));
}

function visit(value: unknown, callback: (node: AstNode, parent?: AstNode) => void, parent?: AstNode): void {
  if (typeof value !== "object" || value === null) return;
  const candidate = value as Record<string, unknown>;
  const node = typeof candidate.type === "string" ? value as AstNode : undefined;
  if (node) callback(node, parent);
  for (const [key, child] of Object.entries(candidate)) {
    if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) continue;
    if (Array.isArray(child)) {
      for (const nested of child) visit(nested, callback, node ?? parent);
    } else if (child && typeof child === "object") {
      visit(child, callback, node ?? parent);
    }
  }
}

function isLogical(node: AstNode | undefined): boolean {
  return node?.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||");
}

function flattenConditions(node: AstNode, result: AstNode[] = []): AstNode[] {
  if (isLogical(node)) {
    flattenConditions(node.left as AstNode, result);
    flattenConditions(node.right as AstNode, result);
  } else {
    result.push(node);
  }
  return result;
}

function toBooleanConditionTree(node: AstNode, conditionIndexes: Map<AstNode, number>): BooleanConditionTree {
  if (isLogical(node)) {
    return {
      type: node.operator === "&&" ? "and" : "or",
      left: toBooleanConditionTree(node.left as AstNode, conditionIndexes),
      right: toBooleanConditionTree(node.right as AstNode, conditionIndexes),
    };
  }
  const index = conditionIndexes.get(node);
  if (index === undefined) throw new Error("Could not index an atomic condition while measuring MCC.");
  return { type: "condition", index };
}

function sourcePosition(source: string, offset: number): string {
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length;
  const column = offset - prefix.lastIndexOf("\n");
  return `${line}:${column}`;
}

function isDecisionTest(node: AstNode): boolean {
  return node.type === "IfStatement"
    || node.type === "WhileStatement"
    || node.type === "DoWhileStatement"
    || node.type === "ForStatement"
    || node.type === "ConditionalExpression";
}

function conditionExpression(node: AstNode): AstNode | undefined {
  return isDecisionTest(node) ? node.test as AstNode : undefined;
}

function isConditionRoot(node: AstNode, parent?: AstNode): boolean {
  return isLogical(node) && !isLogical(parent);
}

function containsAwait(node: AstNode): boolean {
  let found = false;
  visit(node, (child) => {
    if (child.type === "AwaitExpression") found = true;
  });
  return found;
}

async function collectJavaScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJavaScript(filename));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(filename);
  }
  return files;
}

async function instrument(filename: string): Promise<void> {
  const distRelative = path.relative(distDirectory, filename).split(path.sep).join("/");
  const sourcePath = `src/${distRelative.replace(/\.js$/, ".ts")}`;
  if (isExcluded(sourcePath)) return;

  const source = await readFile(filename, "utf8");
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const roots = new Map<AstNode, true>();
  visit(ast, (node, parent) => {
    const test = conditionExpression(node);
    if (test) roots.set(test, true);
    if (isConditionRoot(node, parent)) roots.set(node, true);
  });

  const editor = new MagicString(source);
  const fileMetadata: Record<string, { conditionCount: number; possibleCombinations: string[] }> = {};
  for (const rootNode of roots.keys()) {
    const conditions = flattenConditions(rootNode);
    if (conditions.length > 1 && containsAwait(rootNode)) {
      throw new Error(`Cannot measure C2/MCC for an awaited compound condition in ${sourcePath}:${sourcePosition(source, rootNode.start)}.`);
    }
    const id = `${distRelative}:${sourcePosition(source, rootNode.start)}`;
    const conditionIndexes = new Map(conditions.map((condition, index) => [condition, index]));
    fileMetadata[id] = {
      conditionCount: conditions.length,
      possibleCombinations: enumerateReachableCombinations(toBooleanConditionTree(rootNode, conditionIndexes), conditions.length),
    };

    if (conditions.length === 1) {
      editor.appendLeft(rootNode.start, `__conditionCoverage.directDecision(${JSON.stringify(id)}, (`);
      editor.appendRight(rootNode.end, "))");
      continue;
    }

    editor.appendLeft(rootNode.start, `__conditionCoverage.decision(${JSON.stringify(id)}, ${conditions.length}, () => (`);
    editor.appendRight(rootNode.end, "))");
    // Insert the decision wrapper before condition wrappers. When the first
    // condition starts at the same offset as the whole expression, this keeps
    // the decision frame active while that condition is evaluated.
    for (const [index, condition] of conditions.entries()) {
      editor.appendLeft(condition.start, `__conditionCoverage.condition(${index}, (`);
      editor.appendRight(condition.end, "))");
    }
  }

  if (Object.keys(fileMetadata).length === 0) return;
  metadata[sourcePath] = fileMetadata;
  const preamble = `import { createConditionCoverage } from "../.coverage-tools/scripts/coverage/coverage-runtime.js";\nconst __conditionCoverage = createConditionCoverage(${JSON.stringify(sourcePath)});\n`;
  const firstPreambleLine = source.startsWith("#!") ? 2 : 1;
  generatedStatementLines[sourcePath] = [firstPreambleLine, firstPreambleLine + 1];
  if (source.startsWith("#!")) editor.appendLeft(source.indexOf("\n") + 1, preamble);
  else editor.prepend(preamble);
  await writeFile(filename, editor.toString());
  console.log(`Instrumented dist/${distRelative} (${Object.keys(fileMetadata).length} decisions)`);
}

await mkdir(coverageDirectory, { recursive: true });
for (const filename of await collectJavaScript(distDirectory)) await instrument(filename);
await writeFile(path.join(coverageDirectory, "condition-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
await writeFile(path.join(coverageDirectory, "instrumented-statement-lines.json"), `${JSON.stringify(generatedStatementLines, null, 2)}\n`);
