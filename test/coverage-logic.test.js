import assert from "node:assert/strict";
import test from "node:test";
import { enumerateReachableCombinations } from "../.coverage-tools/scripts/coverage/condition-logic.js";

function condition(index) {
  return { type: "condition", index };
}

test("enumerates only the condition vectors reachable through short-circuit AND", () => {
  assert.deepEqual(enumerateReachableCombinations({ type: "and", left: condition(0), right: condition(1) }, 2), ["0x", "10", "11"]);
});

test("enumerates all short-circuit-reachable MCC vectors for nested AND and OR", () => {
  const tree = {
    type: "and",
    left: { type: "or", left: condition(0), right: condition(1) },
    right: condition(2),
  };
  assert.deepEqual(enumerateReachableCombinations(tree, 3), ["00x", "010", "011", "1x0", "1x1"]);
});

test("rejects decisions too large for exhaustive MCC analysis", () => {
  assert.throws(() => enumerateReachableCombinations(condition(0), 17), /supports 1-16 conditions/);
});
