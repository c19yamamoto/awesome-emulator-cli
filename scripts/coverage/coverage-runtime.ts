import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type ConditionCounts = { true: number; false: number };
type DecisionCounts = {
  conditions: ConditionCounts[];
  combinations: Record<string, number>;
};
type ActiveDecision = { file: string; id: string; outcomes: Array<boolean | null> };
type RuntimeState = {
  active: ActiveDecision[];
  files: Record<string, Record<string, DecisionCounts>>;
  registered: boolean;
};

const runtimeKey = Symbol.for("awesome-emulator-cli.condition-coverage");
const globalRuntime = globalThis as typeof globalThis & { [runtimeKey]?: RuntimeState };
const runtime = globalRuntime[runtimeKey] ??= { active: [], files: {}, registered: false };

if (!runtime.registered) {
  runtime.registered = true;
  process.once("exit", () => {
    const directory = process.env.CONDITION_COVERAGE_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${process.pid}.json`), JSON.stringify(runtime.files));
  });
}

function finishDecision(file: string, id: string, outcomes: Array<boolean | null>): void {
  const decisions = runtime.files[file] ??= {};
  const decision = decisions[id] ??= {
    conditions: outcomes.map(() => ({ true: 0, false: 0 })),
    combinations: {},
  };

  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === null) continue;
    decision.conditions[index][String(outcome) as "true" | "false"] += 1;
  }

  const combination = outcomes.map((outcome) => outcome === null ? "x" : outcome ? "1" : "0").join("");
  decision.combinations[combination] = (decision.combinations[combination] ?? 0) + 1;
}

export function createConditionCoverage(file: string) {
  return {
    directDecision(id: string, value: unknown): unknown {
      finishDecision(file, id, [Boolean(value)]);
      return value;
    },

    decision<T>(id: string, conditionCount: number, evaluate: () => T): T {
      const frame: ActiveDecision = { file, id, outcomes: Array(conditionCount).fill(null) };
      runtime.active.push(frame);
      try {
        return evaluate();
      } finally {
        runtime.active.pop();
        finishDecision(file, id, frame.outcomes);
      }
    },

    condition<T>(index: number, value: T): T {
      const frame = runtime.active.at(-1);
      if (frame) frame.outcomes[index] = Boolean(value);
      return value;
    },
  };
}
