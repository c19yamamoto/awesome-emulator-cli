export type BooleanConditionTree =
  | { type: "condition"; index: number }
  | { type: "and" | "or"; left: BooleanConditionTree; right: BooleanConditionTree };

/** Return truth vectors reachable with JavaScript's left-to-right short circuiting. */
export function enumerateReachableCombinations(tree: BooleanConditionTree, conditionCount: number): string[] {
  if (!Number.isSafeInteger(conditionCount) || conditionCount < 1 || conditionCount > 16) {
    throw new Error(`MCC supports 1-16 conditions per decision; received ${conditionCount}.`);
  }

  const combinations = new Set<string>();
  for (let bits = 0; bits < 2 ** conditionCount; bits += 1) {
    const outcomes: Array<boolean | null> = Array(conditionCount).fill(null);
    const evaluate = (node: BooleanConditionTree): boolean => {
      if (node.type === "condition") {
        const value = (bits & (1 << node.index)) !== 0;
        outcomes[node.index] = value;
        return value;
      }
      const left = evaluate(node.left);
      if (node.type === "and") return left && evaluate(node.right);
      return left || evaluate(node.right);
    };
    evaluate(tree);
    combinations.add(outcomes.map((outcome) => outcome === null ? "x" : outcome ? "1" : "0").join(""));
  }
  return [...combinations].sort();
}
