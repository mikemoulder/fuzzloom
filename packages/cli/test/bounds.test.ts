import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBounds } from "../src/bounds.ts";
import { boundsExpr, harnessBody } from "../src/harness.ts";
import { floorOf, shrinkByReplay, shrinkCandidates } from "../src/engine.ts";
import type { FeType, Target, Words } from "../src/types.ts";

const args = (...ts: [string, FeType][]) => ts.map(([name, type]) => ({ name, type }));

test("unsigned ranges become word ranges; .. excludes the upper end", () => {
  assert.deepEqual(parseBounds(["/// fuzzloom: start in 100..=200"], args(["total", "u128"], ["start", "u64"])), [{ arg: 1, lo: 100n, hi: 200n }]);
  assert.deepEqual(parseBounds(["/// fuzzloom: x in 0x10..0x20"], args(["x", "u8"])), [{ arg: 0, lo: 16n, hi: 31n }]);
  assert.deepEqual(parseBounds(["/// fuzzloom: x in 1_000..=2_000"], args(["x", "u32"])), [{ arg: 0, lo: 1000n, hi: 2000n }]);
  assert.deepEqual(parseBounds(["/// just a comment", "#[test]"], args(["x", "u8"])), []);
});

test("signed ranges must be centred on zero, because words are zigzag-encoded", () => {
  // zigzag: 0, -1, 1, -2, 2 ... -> words 0, 1, 2, 3, 4
  assert.deepEqual(parseBounds(["/// fuzzloom: d in -1000..=1000"], args(["d", "i64"])), [{ arg: 0, lo: 0n, hi: 2000n }]);
  assert.deepEqual(parseBounds(["/// fuzzloom: d in -1001..=1000"], args(["d", "i64"])), [{ arg: 0, lo: 0n, hi: 2001n }]);
  assert.match(String(parseBounds(["/// fuzzloom: d in 10..=20"], args(["d", "i64"]))), /centred on zero/);
});

test("every mistake is an error, never a silently wider range", () => {
  const a = args(["x", "u8"], ["f", "bool"]);
  assert.match(String(parseBounds(["/// fuzzloom: y in 1..=2"], a)), /not an argument/);
  assert.match(String(parseBounds(["/// fuzzloom: x in 1..=300"], a)), /does not fit u8/);
  assert.match(String(parseBounds(["/// fuzzloom: x in 5..=4"], a)), /empty/);
  assert.match(String(parseBounds(["/// fuzzloom: x from 1 to 2"], a)), /cannot read the annotation/);
  assert.match(String(parseBounds(["/// fuzzloom: f in 0..=1"], a)), /bool/);
  assert.match(String(parseBounds(["/// fuzzloom: x in 1..=2", "/// fuzzloom: x in 3..=4"], a)), /more than one range/);
});

const t: Target = {
  kind: "property", name: "prop_v", file: "f", line: 1,
  args: [{ name: "total", type: "u128" }, { name: "start", type: "u64" }],
  bounds: [{ arg: 1, lo: 100n, hi: 200n }],
};

test("a bounded target uses the bounded entry point in every mode", () => {
  assert.equal(boundsExpr(t), "bounds_of(prop2(prop_v)).restrict(1, lo: 0x64, hi: 0xc8)");
  const B = boundsExpr(t);
  assert.ok(harnessBody(t, { mode: "check", base: 1n, runs: 5n }).startsWith(`check_bounded(prop2(prop_v), bounds: ${B},`));
  assert.ok(harnessBody(t, { mode: "check", base: 1n, runs: 5n, corpus: [1n, 150n, 0n] }).startsWith("check_mutating_within("));
  assert.ok(harnessBody(t, { mode: "input_at", base: 1n, iteration: 2n }).includes(`bounds: ${B}`));
  assert.ok(harnessBody(t, { mode: "input_at", base: 1n, iteration: 2n, corpus: [1n, 150n, 0n] }).startsWith("mutant_at_within("));
  assert.ok(harnessBody(t, { mode: "replay_at", base: 1n, iteration: 2n }).includes(`generated_at(${B},`));
  const d: Target = { ...t, kind: "differential", returns: "u8" };
  assert.ok(harnessBody(d, { mode: "checkpoints", base: 1n, first: 1n, step: 1n, count: 2 }).startsWith("digest_checkpoints_within("));
  assert.ok(harnessBody(d, { mode: "target_input_at", base: 1n, iteration: 2n }).startsWith("target_input_at_within("));
  assert.ok(harnessBody(d, { mode: "evaluate_at", base: 1n, iteration: 2n }).includes("generated_at(target_bounds_of("));
  assert.throws(() => harnessBody(d, { mode: "digest", base: 1n, runs: 5n }), /checkpoints/);
});

test("replay shrinking never leaves the declared range", async () => {
  assert.deepEqual(floorOf(t), [0n, 100n, 0n]);
  // Fails for every input: unbounded shrinking would reach (0, 0), which is
  // outside the declared range; floor-aware shrinking stops at (0, 100).
  const seen: Words[] = [];
  const r = await shrinkByReplay(t, [1n << 90n, 199n, 0n], 64, async (ws) => {
    seen.push(...ws);
    return ws.map(() => true);
  });
  assert.ok(seen.every((w) => w[1] >= 100n), "a candidate went below the floor");
  assert.deepEqual(r.input, [0n, 100n, 0n]);
  assert.equal(r.complete, true);
});

test("floor-aware shrinking ends at a local minimum measured from the floor", async () => {
  // Fails for start >= 150. The guarantee is local: no move (measured as a
  // distance from the floor) from the result still fails. Here a joint move
  // lowers both arguments by 5, then every single move on start lands below
  // 150, so the result is (0, 194), not the global minimum (0, 150).
  const fails = (w: Words) => w[1] >= 150n;
  const r = await shrinkByReplay(t, [5n, 199n, 0n], 64, async (ws) => ws.map(fails));
  assert.deepEqual(r.input, [0n, 194n, 0n]);
  const f = floorOf(t);
  const dist: Words = [r.input[0] - f[0], r.input[1] - f[1], 0n];
  for (const c of shrinkCandidates(dist, 2)) assert.ok(!fails([c[0] + f[0], c[1] + f[1], 0n]), `move to ${c} still fails`);
});
