import { test } from "node:test";
import assert from "node:assert/strict";
import { shrinkByReplay } from "../src/engine.ts";
import type { Target } from "../src/types.ts";

const t2: Target = { kind: "property", name: "p", args: [{ name: "a", type: "u64" }, { name: "b", type: "u64" }], file: "f", line: 1 };

test("shrinks each argument to zero when the failure allows it", () => {
  // Aborts whenever b == 0 (like a division by b).
  const r = shrinkByReplay(t2, [123456789n, 0n, 0n], 16, (w) => w[1] === 0n);
  assert.deepEqual(r.input, [0n, 0n, 0n]);
  assert.equal(r.complete, true);
});

test("halves toward a threshold and never accepts a non-reproducing candidate", () => {
  const fails = (w: readonly bigint[]) => w[0]! >= 1000n;
  const r = shrinkByReplay(t2, [1n << 40n, 7n, 0n], 64, fails);
  assert.ok(fails(r.input));
  assert.ok(r.input[0]! < 2000n, `halving should get below 2*threshold, got ${r.input[0]}`);
  assert.equal(r.input[1], 0n);
});

test("respects the replay budget", () => {
  let calls = 0;
  const r = shrinkByReplay(t2, [1n << 60n, 1n << 60n, 0n], 5, () => { calls++; return true; });
  assert.equal(calls, 2); // both arguments go straight to zero
  assert.deepEqual(r.input, [0n, 0n, 0n]);
  let calls2 = 0;
  const r2 = shrinkByReplay(t2, [1n << 60n, 0n, 0n], 3, (w) => { calls2++; return w[0]! > 5n; });
  assert.equal(calls2, 3);
  assert.equal(r2.complete, false);
});
