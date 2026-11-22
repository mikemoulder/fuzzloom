import { test } from "node:test";
import assert from "node:assert/strict";
import { checkpointCall, chooseWidth, jointCandidates, MAX_CHECKPOINTS, narrow, probePoints, roundsFor, searchFirst, shrinkByReplay, shrinkCandidates } from "../src/engine.ts";
import type { Target, Words } from "../src/types.ts";

const t2: Target = { kind: "property", name: "p", args: [{ name: "a", type: "u64" }, { name: "b", type: "u64" }], file: "f", line: 1 };

/** Adapts a single-input predicate to the batched shape, counting rounds and replays. */
function batched(pred: (w: Words) => boolean) {
  const m = { rounds: 0, replays: 0 };
  const f = async (ws: Words[]) => {
    m.rounds++;
    m.replays += ws.length;
    return ws.map(pred);
  };
  return { f, m };
}

test("searchFirst finds the exact minimum within the stated round bound", async () => {
  for (const width of [1, 2, 7, 21, 64]) {
    for (const n of [1n, 2n, 9n, 100n, 10000n]) {
      // Every answer position, sampled densely near the ends where off-by-one bugs live.
      const answers = new Set<bigint>([1n, 2n, n / 2n, n - 1n, n].filter((a) => a >= 1n && a <= n));
      for (let a = 1n; a <= n; a += n / 37n + 1n) answers.add(a);
      for (const a of answers) {
        let calls = 0;
        const r = await searchFirst(1n, n, width, async (ks) => {
          calls++;
          assert.ok(ks.length <= width, `probe of ${ks.length} > width ${width}`);
          assert.ok(ks.every((k) => k >= 1n && k < n), "probes only undecided values");
          return ks.map((k) => k >= a);
        });
        assert.equal(r.value, a, `width ${width}, n ${n}, answer ${a}`);
        assert.equal(r.rounds, calls);
        assert.ok(r.rounds <= roundsFor(n - 1n, width), `width ${width}, n ${n}: ${r.rounds} rounds > bound ${roundsFor(n - 1n, width)}`);
      }
    }
  }
});

test("a matching checkpoint after an earlier mismatch can hide the first divergence", async () => {
  // The first unequal prefix is 2, but a collision at the probe at 4
  // discards that prefix. The search then finds the later unequal prefix.
  const result = await searchFirst(1n, 8n, 1, async (probes) =>
    probes.map((prefix) => prefix === 2n || prefix >= 7n));
  assert.equal(result.value, 7n);
});

test("probePoints is an evenly spaced progression whose gaps meet the roundsFor bound", () => {
  for (const width of [1, 3, 21, 255, 256]) {
    for (const [lo, hi] of [[1n, 2n], [1n, 40n], [5n, 300n], [1n, 10000n], [1n, 1n << 40n]] as const) {
      const ks = probePoints(lo, hi, width);
      const u = hi - lo;
      assert.ok(ks.length >= 1 && ks.length <= width);
      assert.ok(ks.every((k) => k >= lo && k < hi));
      checkpointCall(0n, ks.length <= MAX_CHECKPOINTS ? ks : ks.slice(0, MAX_CHECKPOINTS)); // throws unless evenly spaced
      // Undecided values left in every gap, including below the lowest probe and above the highest.
      const edges = [lo - 1n, ...ks, hi];
      for (let i = 1; i < edges.length; i++) {
        const gap = edges[i]! - edges[i - 1]! - 1n;
        assert.ok(gap <= u / BigInt(width + 1), `width ${width}, [${lo}, ${hi}): gap ${gap}`);
      }
    }
  }
  assert.deepEqual(probePoints(3n, 6n, 8), [3n, 4n, 5n]); // a small range probes every value
});

test("narrow keeps exactly the undecided values", () => {
  const ks = [10n, 20n, 30n];
  assert.deepEqual(narrow(1n, 40n, ks, [false, true, true]), { lo: 11n, hi: 20n });
  assert.deepEqual(narrow(1n, 40n, ks, [true, true, true]), { lo: 1n, hi: 10n });
  assert.deepEqual(narrow(1n, 40n, ks, [false, false, false]), { lo: 31n, hi: 40n });
});

test("an incomplete replay batch cannot certify a shrink minimum", async () => {
  await assert.rejects(shrinkByReplay(t2, [9n, 0n, 0n], 4, async () => []), /incomplete shrink replay/);
});

test("the first diff round fits one checkpoint case and leaves at most 39 of 10,000 run counts", () => {
  // Same construction as runDiffs: the first search round's probes plus runs itself.
  const runs = 10000n;
  const ks = [...probePoints(1n, runs, MAX_CHECKPOINTS - 1), runs];
  const call = checkpointCall(7n, ks);
  assert.ok(call.mode === "checkpoints" && call.count <= MAX_CHECKPOINTS && call.step === 40n);
  assert.equal(ks.at(-1), runs);
  for (const answer of [1n, 2n, 39n, 40n, 41n, 5000n, 9999n, 10000n]) {
    const r = narrow(1n, runs, ks, ks.map((k) => k >= answer));
    assert.ok(r.lo <= answer && answer <= r.hi && r.hi - r.lo <= 39n, `answer ${answer}: [${r.lo}, ${r.hi}]`);
    assert.equal(roundsFor(r.hi - r.lo, MAX_CHECKPOINTS), r.hi === r.lo ? 0 : 1);
  }
  assert.throws(() => checkpointCall(0n, [1n, 2n, 4n]), /evenly spaced/);
  assert.throws(() => checkpointCall(0n, []), /cannot checkpoint/);
});

test("roundsFor and chooseWidth: bisection is the width-1 case, and wider rounds cut fe runs", () => {
  assert.equal(roundsFor(0n, 5), 0);
  assert.equal(roundsFor(9999n, 1), 14); // ceil(log2(10000))
  assert.equal(roundsFor(9999n, 21), 3);
  const k = chooseWidth(9999n);
  assert.ok(roundsFor(9999n, k) <= 4, `chosen width ${k} needs ${roundsFor(9999n, k)} rounds`);
  assert.ok(k > 1 && k <= 64);
  assert.equal(chooseWidth(3n), 3); // one round decides everything
});

test("shrinkCandidates: zero and power-of-two right shifts, deduplicated", () => {
  const c = shrinkCandidates([1000n, 0n, 0n], 2);
  // 1000 has 10 bits: shifts 1, 2, 4, 8.
  assert.deepEqual(c.map((w) => w[0]), [0n, 500n, 250n, 62n, 3n]);
  assert.deepEqual(shrinkCandidates([1n, 0n, 0n], 2).map((w) => w[0]), [0n]);
  assert.deepEqual(shrinkCandidates([0n, 0n, 0n], 2), []);
});

test("shrinks each argument to zero when the failure allows it", async () => {
  // Aborts whenever b == 0 (like a division by b).
  const { f, m } = batched((w) => w[1] === 0n);
  const r = await shrinkByReplay(t2, [123456789n, 0n, 0n], 8, f);
  assert.deepEqual(r.input, [0n, 0n, 0n]);
  assert.equal(r.complete, true);
  assert.equal(m.rounds, 1); // all zero after one round: no candidates remain, so no second fe run
});

test("reaches the stated local minimum and never accepts a non-reproducing candidate", async () => {
  const fails = (w: Words) => w[0]! >= 1000n && w[1] === 7n;
  const { f } = batched(fails);
  const r = await shrinkByReplay(t2, [1n << 40n, 7n, 0n], 64, f);
  assert.ok(fails(r.input));
  assert.equal(r.complete, true);
  // The guarantee, checked directly: no single move still reproduces.
  for (const c of shrinkCandidates(r.input, 2)) assert.ok(!fails(c), `move to ${c} still reproduces`);
  assert.ok(r.input[0]! < 2000n, `shift by 1 must get below 2*threshold, got ${r.input[0]}`);
  assert.equal(r.input[1], 7n);
});

/** True when no single-argument move (the pre-joint candidate set) still reproduces. */
const stuckOnSingles = (w: Words, fails: (w: Words) => boolean) =>
  shrinkCandidates(w, 2).filter((c) => c.filter((v, i) => v !== w[i]).length === 1).every((c) => !fails(c));

test("joint moves walk a diagonal failure (b == a + 1) down to its exact floor", async () => {
  // The vault-math withdraw shape, with a floor so the answer is not just (0, 1).
  const fails = (w: Words) => w[1] === w[0]! + 1n && w[0]! >= 10n;
  const start: Words = [(1n << 100n) + 12345n, (1n << 100n) + 12346n, 0n];
  assert.ok(stuckOnSingles(start, fails), "single-argument moves alone cannot leave the start");
  const { f } = batched(fails);
  const r = await shrinkByReplay(t2, start, 64, f);
  assert.deepEqual(r.input, [10n, 11n, 0n]);
  assert.equal(r.complete, true);
});

test("joint moves follow a proportional failure (b == 2a) where the gcd step overshoots", async () => {
  const fails = (w: Words) => w[1] === 2n * w[0]! && w[0]! >= 3n;
  const start: Words = [96n, 192n, 0n]; // gcd 96 jumps to (1, 2), which passes
  assert.ok(stuckOnSingles(start, fails));
  const { f } = batched(fails);
  const r = await shrinkByReplay(t2, start, 64, f);
  // 96 -> 32 (by 3) -> 16 -> 8 -> 4 (by 2). (4, 8) is a local minimum, not
  // the global (3, 6): reaching 3 would need scaling by 3/4, which no move
  // offers. This pins the documented limit.
  assert.deepEqual(r.input, [4n, 8n, 0n]);
  for (const c of shrinkCandidates(r.input, 2)) assert.ok(!fails(c), `move to ${c} still reproduces`);
});

test("jointCandidates: none for fewer than two nonzero arguments, never the input itself", () => {
  assert.deepEqual(jointCandidates([5n, 0n, 0n], 2), []);
  assert.deepEqual(jointCandidates([5n, 9n, 7n], 1), []);
  const c = shrinkCandidates([6n, 6n, 0n], 2).map((w) => w.join(","));
  assert.ok(!c.includes("6,6,0") && new Set(c).size === c.length);
  assert.ok(c.includes("0,0,0") && c.includes("3,3,0") && c.includes("2,2,0") && c.includes("5,5,0"));
});

test("respects the round budget", async () => {
  const { f, m } = batched((w) => w[0]! > 5n);
  const r = await shrinkByReplay(t2, [1n << 200n, 0n, 0n], 2, f);
  assert.equal(m.rounds, 2);
  assert.equal(r.rounds, 2);
  assert.equal(r.complete, false);
  assert.ok(r.input[0]! < 1n << 200n);
});
