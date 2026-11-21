// Campaign orchestration: run targets through fe in batched rounds, classify
// the results, and recover inputs when a property aborts or two backends
// diverge.
//
// Every fe run pays a fixed compile cost, so the unit of work is a round: one
// harness holding every evaluation that does not depend on another. Rounds
// on the two backends of a differential run execute concurrently.

import { runBatch, type FeConfig } from "./fe.ts";
import { safeDir } from "./paths.ts";
import { caseName, writeBatch, type Case, type HarnessCall } from "./harness.ts";
import type { Backend, Outcome, Target, Words } from "./types.ts";

export type Context = {
  userRoot: string;
  ingot: string;
  backend: Backend;
  fe: FeConfig;
  /** Called after every fe run, for progress output. */
  onRun?: (what: string, ms: number) => void;
  /** fe runs (rounds) allowed when shrinking an aborting property (default 8). */
  abortShrinkRounds?: number;
  /** Most cases in one abort-search round (default 64). Divergence search uses checkpoints instead. */
  maxWidth?: number;
};

export type Stats = { edgeArgs: bigint; correlated: bigint; extremes: bigint };

/** A saved failure whose neighbourhood a mutation campaign explores. */
export type Seed = { record: string; input: Words };

/**
 * `mutated` on a pass counts the mutation campaigns that also passed;
 * `seededBy` on a failure names the saved failure whose mutation campaign
 * found it (iteration then counts mutants, not campaign inputs).
 */
export type PropertyResult =
  | { status: "passed"; target: Target; runs: bigint; stats: Stats; mutated: number; feRuns: number }
  | { status: "failed"; target: Target; iteration: bigint; original: Words; input: Words; shrinkAttempts: bigint; shrinkComplete: boolean; seededBy?: string; feRuns: number }
  | { status: "aborted"; target: Target; iteration: bigint; original: Words; input: Words; abort: string; shrinkAborted: boolean; shrinkRounds: number; shrinkReplays: number; shrinkComplete: boolean; seededBy?: string; feRuns: number }
  | { status: "infra"; target: Target; reason: string; detail: string; feRuns: number };

/**
 * Where harnesses are generated, and what the cleanup deletes recursively.
 * Refuses a `.fuzzloom` or `.fuzzloom/tmp` that is a symlink (see paths.ts),
 * so neither writes nor the cleanup can reach outside the ingot.
 */
export function workDir(userRoot: string): string {
  return safeDir(userRoot, ".fuzzloom", "tmp");
}

/** An infrastructure outcome that ends the current recovery. */
class Stop extends Error {
  readonly reason: string;
  readonly detail: string;
  readonly backend: Backend;
  constructor(reason: string, detail: string, backend: Backend) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
    this.backend = backend;
  }
  static of(o: Outcome, backend: Backend, expected: string): Stop {
    return o.kind === "infra"
      ? new Stop(o.reason, o.detail, backend)
      : new Stop("unexpected", `expected ${expected}, got ${o.kind === "panic" || o.kind === "revert" ? describeAbort(o) : o.kind}`, backend);
  }
}

/** Counts fe runs for one target. */
type Meter = { feRuns: number };

/** Runs one round: every case in one harness, one fe run. */
export async function runCases(ctx: Context, cases: Case[], label: string, backend: Backend = ctx.backend, meter?: Meter): Promise<Outcome[]> {
  const name = `${label}-${backend}`.replace(/[^\w-]/g, "_");
  const dir = writeBatch({ userRoot: ctx.userRoot, ingot: ctx.ingot, cases, workDir: workDir(ctx.userRoot), name });
  const r = await runBatch(dir, cases.map((_, i) => caseName(i)), backend, ctx.fe);
  if (meter) meter.feRuns++;
  ctx.onRun?.(`${label} on ${backend}, ${cases.length} case${cases.length === 1 ? "" : "s"}`, r.ms);
  return r.outcomes;
}

const isAbort = (o: Outcome) => o.kind === "panic" || o.kind === "revert";

export function describeAbort(o: Outcome): string {
  if (o.kind === "panic") return `${o.reason} (Panic 0x${o.code.toString(16)})`;
  if (o.kind === "revert") return `reverted: "${o.message}"`;
  return o.kind;
}

// ------------------------------------------------------------ k-ary search

/** Fixed cost of one fe run and marginal cost of one case, in ms (measured on vault-math, fe 26.6.0). */
export const COMPILE_MS = 2400;
export const CASE_MS = 85;

/**
 * Worst-case rounds searchFirst needs for `unknown` undecided values at
 * width `k`, which is ceil(log_{k+1}(unknown + 1)). The k probes cut the
 * undecided range into k + 1 gaps, and every gap holds at most
 * floor(unknown / (k + 1)) values that stay undecided (k = 1 is bisection).
 */
export function roundsFor(unknown: bigint, k: number): number {
  const K1 = BigInt(k) + 1n;
  let u = unknown;
  let r = 0;
  while (u > 0n) {
    r++;
    u /= K1;
  }
  return r;
}

/** The width minimising worst-case time, roundsFor(u, k) * (COMPILE_MS + CASE_MS * k). */
export function chooseWidth(unknown: bigint, maxWidth = 64): number {
  let best = 1;
  let bestCost = Infinity;
  for (let k = 1; k <= maxWidth; k++) {
    const cost = roundsFor(unknown, k) * (COMPILE_MS + CASE_MS * k);
    if (cost < bestCost) {
      best = k;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * The probes of one search round over the undecided values [lo, hi), with
 * hi known true: the arithmetic progression hi - s, hi - 2s, ... (returned
 * ascending, at most `width` values, all >= lo), s = floor((hi - lo) /
 * (width + 1)) + 1. Every gap between probes, and the one below the lowest,
 * then holds at most floor((hi - lo) / (width + 1)) undecided values, which
 * is the bound roundsFor counts. Being a progression lets one checkpoint
 * case answer a whole round.
 */
export function probePoints(lo: bigint, hi: bigint, width: number): bigint[] {
  if (width < 1) throw new Error("width must be at least 1");
  const u = hi - lo;
  if (u <= 0n) return [];
  const W = BigInt(width);
  const s = u / (W + 1n) + 1n;
  const ks: bigint[] = [];
  for (let j = 1n; j <= W && hi - j * s >= lo; j++) ks.unshift(hi - j * s);
  return ks;
}

/** The undecided range left after probing ascending `ks` with results `res`. */
export function narrow(lo: bigint, hi: bigint, ks: bigint[], res: boolean[]): { lo: bigint; hi: bigint } {
  const t = res.findIndex((x) => x);
  if (t >= 0) hi = ks[t]!;
  const f = t >= 0 ? t - 1 : ks.length - 1;
  if (f >= 0) lo = ks[f]! + 1n;
  return { lo, hi };
}

/**
 * Finds the smallest k in [lo, hi] with pred(k), for a predicate that is
 * monotone (false then true) and known true at hi. Each round probes the
 * probePoints of the undecided range, all in one call.
 *
 * Guarantee: the exact minimum, in at most roundsFor(hi - lo, width) rounds.
 * Limit: if pred is not monotone the answer is some k with pred(k) and
 * !pred(k - 1), not necessarily the smallest.
 */
export async function searchFirst(lo: bigint, hi: bigint, width: number, probe: (ks: bigint[]) => Promise<boolean[]>): Promise<{ value: bigint; rounds: number }> {
  let rounds = 0;
  while (lo < hi) {
    const ks = probePoints(lo, hi, width);
    const res = await probe(ks);
    rounds++;
    ({ lo, hi } = narrow(lo, hi, ks, res));
  }
  return { value: hi, rounds };
}

// ------------------------------------------------------- parallel shrinking

const bitLen = (v: bigint) => v.toString(2).length - (v === 0n ? 1 : 0);
const size = (w: Words, n: number) => w.slice(0, n).reduce((a, v) => a + bitLen(v), 0);
const total = (w: Words, n: number) => w.slice(0, n).reduce((a, v) => a + v, 0n);

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** Power-of-two right-shift amounts that still leave a nonzero value: 1, 2, 4, 8, ... */
const shifts = (v: bigint): bigint[] => {
  const out: bigint[] = [];
  for (let s = 1; s < bitLen(v); s *= 2) out.push(BigInt(s));
  return out;
};

/**
 * Moves that change every argument at once, offered when at least two are
 * nonzero. Single-argument moves get stuck when the failure lives on a
 * relation between arguments (b == a + 1, b == 2a): every one-argument
 * change leaves the relation and stops reproducing.
 *   - all arguments to 0;
 *   - proportional: divide all by their gcd g, and by each of 2, 3, 5, 7
 *     dividing g (smaller steps keep b == 2a reachable when g overshoots);
 *     halve all when g is 1;
 *   - diagonal: subtract the same d from all, for the smallest argument m:
 *     d = m, 1, and m >> s and m - (m >> s) for s in 1, 2, 4, 8, ...
 */
export function jointCandidates(best: Words, arity: number): Words[] {
  const args = best.slice(0, arity);
  if (args.filter((v) => v !== 0n).length < 2) return [];
  const make = (f: (v: bigint) => bigint): Words => {
    const c: Words = [...best];
    for (let i = 0; i < arity; i++) c[i] = f(best[i]!);
    return c;
  };
  const out: Words[] = [make(() => 0n)];
  const g = args.reduce((a, v) => gcd(a, v), 0n);
  const divisors = new Set<bigint>(g > 1n ? [g, ...[2n, 3n, 5n, 7n].filter((p) => p < g && g % p === 0n)] : [2n]);
  for (const d of divisors) out.push(make((v) => v / d));
  const m = args.reduce((a, v) => (v < a ? v : a));
  if (m > 0n) {
    // m >> s steps refine near the floor; m - (m >> s) steps move the
    // smallest argument straight to m >> s, removing bits quickly.
    const steps = new Set<bigint>([m, 1n, ...shifts(m).flatMap((s) => [m >> s, m - (m >> s)])]);
    for (const d of steps) out.push(make((v) => v - d));
  }
  return out;
}

/**
 * One round of candidates: each nonzero argument alone set to 0 or shifted
 * right by 1, 2, 4, 8, ..., then the jointCandidates. Deduplicated, and
 * never the input itself.
 */
export function shrinkCandidates(best: Words, arity: number): Words[] {
  const out: Words[] = [];
  const seen = new Set<string>([best.join(",")]);
  const push = (c: Words) => {
    const k = c.join(",");
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (let i = 0; i < arity; i++) {
    const v = best[i]!;
    if (v === 0n) continue;
    for (const x of [0n, ...shifts(v).map((s) => v >> s)]) {
      const c: Words = [...best];
      c[i] = x;
      push(c);
    }
  }
  for (const c of jointCandidates(best, arity)) push(c);
  return out;
}

/**
 * Shrinking when every evaluation is a replay through fe (an aborting
 * property cannot be shrunk inside Fe, since Fe cannot catch the abort).
 * Each round evaluates every shrinkCandidates move in one fe run and accepts
 * the reproducing candidate with the fewest total bits (then the smallest
 * sum). `reproduces` must demand the same failure (for aborts, the same
 * panic code or revert message), so shrinking cannot slide onto another bug.
 *
 * Guarantee: when complete, no shrinkCandidates move (single-argument zero
 * or power-of-two shift, or a jointCandidates move) still reproduces: a
 * local minimum under those moves. Limit: not a global minimum; relations
 * other than common divisors and equal offsets are not followed. At most
 * `maxRounds` fe runs.
 *
 * Moves act on each argument's distance from its floor (the lower end of
 * an annotated range, else 0), so no candidate leaves the declared domain.
 */
export async function shrinkByReplay(target: Target, input: Words, maxRounds: number, reproduces: (ws: Words[]) => Promise<boolean[]>): Promise<{ input: Words; rounds: number; replays: number; complete: boolean }> {
  const n = target.args.length;
  const floor = floorOf(target);
  const lift = (d: Words): Words => [d[0] + floor[0], d[1] + floor[1], d[2] + floor[2]];
  // Work on distances from the floor; candidates are lifted back before replay.
  let best: Words = [input[0] - floor[0], input[1] - floor[1], input[2] - floor[2]];
  if (best.some((d) => d < 0n)) throw new Error(`input below the declared floor of ${target.name}`);
  let rounds = 0;
  let replays = 0;
  const done = (complete: boolean) => ({ input: lift(best), rounds, replays, complete });
  while (rounds < maxRounds) {
    const cands = shrinkCandidates(best, n);
    if (cands.length === 0) return done(true);
    const ok = await reproduces(cands.map(lift));
    rounds++;
    replays += cands.length;
    let pick: Words | undefined;
    cands.forEach((c, i) => {
      if (!ok[i]) return;
      if (!pick || size(c, n) < size(pick, n) || (size(c, n) === size(pick, n) && total(c, n) < total(pick, n))) pick = c;
    });
    if (!pick) return done(true);
    best = pick;
  }
  return done(shrinkCandidates(best, n).length === 0);
}

/** The lowest word each argument may take: the annotated lower bound, else 0. */
export function floorOf(t: Target): Words {
  const f: Words = [0n, 0n, 0n];
  for (const b of t.bounds ?? []) f[b.arg] = b.lo;
  return f;
}

// ----------------------------------------------------------- property runs

/**
 * Runs every property campaign in one round: the fresh campaign of each
 * target plus one mutation campaign per saved failure in `seeds` (same
 * runs, same fe run, so seeding costs no extra compile). A campaign that
 * aborts (Fe cannot catch a panic or a revert, so the payload carries no
 * input) is recovered with recoverAbort.
 *
 * Per target, the fresh campaign's failure, abort or infrastructure outcome
 * wins; otherwise the first mutation campaign that fails, aborts or hits an
 * infrastructure outcome is reported; otherwise the target passes.
 */
export async function runProperties(ctx: Context, targets: Target[], base: bigint, runs: bigint, seeds: Map<string, Seed[]> = new Map()): Promise<PropertyResult[]> {
  if (targets.length === 0) return [];
  const cases: Case[] = [];
  const owner: { t: number; seed?: Seed }[] = [];
  for (const [t, target] of targets.entries()) {
    cases.push({ target, call: { mode: "check", base, runs } });
    owner.push({ t });
    for (const seed of seeds.get(target.name) ?? []) {
      cases.push({ target, call: { mode: "check", base, runs, corpus: seed.input } });
      owner.push({ t, seed });
    }
  }
  const outcomes = await runCases(ctx, cases, "check");
  const out: PropertyResult[] = [];
  for (const [t, target] of targets.entries()) {
    const mine = outcomes.flatMap((o, i) => (owner[i]!.t === t ? [{ o, seed: owner[i]!.seed }] : []));
    const fresh = mine[0]!;
    const decisive = fresh.o.kind !== "passed" ? fresh : mine.slice(1).find((m) => m.o.kind !== "passed");
    if (!decisive) {
      const o = fresh.o as Extract<Outcome, { kind: "passed" }>;
      out.push({ status: "passed", target, runs: o.runs, stats: { edgeArgs: o.edgeArgs, correlated: o.correlated, extremes: o.extremes }, mutated: mine.length - 1, feRuns: 1 });
      continue;
    }
    const { o, seed } = decisive;
    const seededBy = seed ? { seededBy: seed.record } : {};
    if (o.kind === "counterexample") {
      out.push({
        status: "failed", target, iteration: o.iteration, original: o.original, input: o.shrunk,
        shrinkAttempts: o.shrinkAttempts, shrinkComplete: o.shrinkComplete, feRuns: 1, ...seededBy,
      });
    } else if (isAbort(o)) {
      out.push({ ...(await recoverAbort(ctx, target, base, runs, o, seed?.input)), ...seededBy } as PropertyResult);
    } else {
      const s = Stop.of(o, ctx.backend, "a campaign payload");
      out.push({ status: "infra", target, reason: s.reason, detail: seed ? `${s.detail} (mutation campaign of ${seed.record})` : s.detail, feRuns: 1 });
    }
  }
  return out;
}

/**
 * Recovers the input of an aborted campaign:
 *
 *   1. Search on runs. A campaign of k runs either passes or aborts: it
 *      cannot return a counterexample, because the first failing input and
 *      its shrink are the same for every k past it, so that shrink would
 *      abort too. "Aborts at k runs" is therefore monotone in k, and the
 *      smallest aborting k (found exactly by searchFirst) gives iteration
 *      k - 1.
 *   2. One round with input_at(iteration), which evaluates nothing and so
 *      cannot abort, and replay_at(iteration). An abort from replay_at means
 *      the property itself aborts on that input; a plain false means the
 *      property fails normally and the shrinker hit an aborting candidate.
 *   3. shrinkByReplay, demanding the same abort.
 *
 * With `corpus`, the same steps run on that mutation campaign: its stream
 * is prefix-consistent too (mutant_at, mutated_at).
 *
 * Cost: 1 + roundsFor(runs - 1, width) + 1 + shrink rounds fe runs.
 */
export async function recoverAbort(ctx: Context, target: Target, base: bigint, runs: bigint, first: Outcome, corpus?: Words): Promise<PropertyResult> {
  const c = corpus ? { corpus } : {};
  const meter: Meter = { feRuns: 1 };
  const run = (calls: HarnessCall[], label: string) => runCases(ctx, calls.map((call) => ({ target, call })), `${target.name}-${label}`, ctx.backend, meter);
  try {
    const width = chooseWidth(runs - 1n, ctx.maxWidth);
    const found = await searchFirst(1n, runs, width, async (ks) => {
      const os = await run(ks.map((k) => ({ mode: "check", base, runs: k, ...c })), "search");
      return os.map((o) => {
        if (isAbort(o)) return true;
        if (o.kind === "passed") return false;
        throw Stop.of(o, ctx.backend, "Passed or an abort");
      });
    });
    const iteration = found.value - 1n;
    const [g, rep] = await run([{ mode: "input_at", base, iteration, ...c }, { mode: "replay_at", base, iteration, ...c }], "recover");
    if (g!.kind !== "generated") throw Stop.of(g!, ctx.backend, "Generated");
    let reproduces: (o: Outcome) => boolean;
    let abort: string;
    let shrinkAborted: boolean;
    if (isAbort(rep!)) {
      abort = describeAbort(rep!);
      shrinkAborted = false;
      reproduces = (o) => isAbort(o) && describeAbort(o) === abort;
    } else if (rep!.kind === "replayed" && rep!.failed) {
      abort = describeAbort(first);
      shrinkAborted = true;
      reproduces = (o) => o.kind === "replayed" && o.failed;
    } else {
      throw new Stop("inconsistent", "the recovered input neither fails nor aborts on replay", ctx.backend);
    }
    const s = await shrinkByReplay(target, g!.input, ctx.abortShrinkRounds ?? 8, async (ws) =>
      (await run(ws.map((input) => ({ mode: "replay", input })), "shrink")).map(reproduces));
    return {
      status: "aborted", target, iteration, original: g!.input, input: s.input, abort, shrinkAborted,
      shrinkRounds: s.rounds, shrinkReplays: s.replays, shrinkComplete: s.complete, feRuns: meter.feRuns,
    };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return { status: "infra", target, reason: e.reason, detail: e.detail, feRuns: meter.feRuns };
  }
}

// ------------------------------------------------------- differential runs

export type DiffResult =
  | { status: "agreed"; target: Target; runs: bigint; acc: bigint; feRuns: number }
  | { status: "diverged"; target: Target; iteration: bigint; input: Words; outputs: { sonatina: bigint; native: bigint }; rounds: number; feRuns: number }
  | { status: "infra"; target: Target; backend: Backend | "both"; reason: string; detail: string; feRuns: number };

/** One round on both backends at the same time. */
async function onBoth(ctx: Context, cases: Case[], label: string, meter?: Meter): Promise<{ s: Outcome[]; n: Outcome[] }> {
  const [s, n] = await Promise.all([
    runCases(ctx, cases, label, "sonatina", meter),
    runCases(ctx, cases, label, "native", meter),
  ]);
  return { s, n };
}

/** Most digests one checkpoint case returns (MAX_CHECKPOINTS in diff.fe). */
export const MAX_CHECKPOINTS = 256;

/** The checkpoints call answering ascending, evenly spaced run counts `ks`. */
export function checkpointCall(base: bigint, ks: bigint[], key?: bigint): HarnessCall {
  if (ks.length === 0 || ks.length > MAX_CHECKPOINTS) throw new Error(`cannot checkpoint ${ks.length} run counts`);
  const step = ks.length > 1 ? ks[1]! - ks[0]! : 1n;
  if (ks.some((k, j) => k !== ks[0]! + BigInt(j) * step)) throw new Error("checkpoint run counts must be evenly spaced");
  return { mode: "checkpoints", base, first: ks[0]!, step, count: ks.length, key };
}

const accsOf = (o: Outcome, backend: Backend, count: number): bigint[] => {
  if (o.kind === "checkpoints") {
    if (o.accs.length === count) return o.accs;
    throw new Stop("unparsed", `asked for ${count} checkpoints, got ${o.accs.length}`, backend);
  }
  // An abort while digesting is about the target, not a backend difference.
  if (o.kind === "panic" || o.kind === "revert") throw new Stop("aborted", `${describeAbort(o)} while digesting`, backend);
  throw Stop.of(o, backend, "Checkpoints");
};

/**
 * Differential run of every target in one round on sonatina and native
 * concurrently. Each target emits checkpoints at the first search round's
 * probe points plus `runs` itself, so the round that checks agreement also
 * narrows any divergence to a 1/256 slice of the run count. Targets whose
 * checkpoints differ go to localiseDivergence.
 */
export async function runDiffs(ctx: Context, targets: Target[], base: bigint, runs: bigint, key: bigint): Promise<DiffResult[]> {
  if (targets.length === 0) return [];
  const ks = [...probePoints(1n, runs, MAX_CHECKPOINTS - 1), runs];
  const first = await onBoth(ctx, targets.map((target) => ({ target, call: checkpointCall(base, ks, key) })), "digest");
  const out: DiffResult[] = [];
  for (const [i, target] of targets.entries()) {
    try {
      const s = accsOf(first.s[i]!, "sonatina", ks.length);
      const n = accsOf(first.n[i]!, "native", ks.length);
      // Any differing checkpoint proves a divergence, so all of them are
      // compared, not only the full-run digest (a fold collision there would
      // otherwise hide one).
      const res = ks.map((_, j) => s[j] !== n[j]);
      out.push(res.some((x) => x)
        ? await localiseDivergence(ctx, target, base, narrow(1n, runs, ks, res), key)
        : { status: "agreed", target, runs, acc: s[ks.length - 1]!, feRuns: 2 });
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      out.push({ status: "infra", target, backend: e.backend, reason: e.reason, detail: e.detail, feRuns: 2 });
    }
  }
  return out;
}

/**
 * Finds the first input on which the two backends disagree, given the run
 * counts [lo, hi] the first round left undecided (checkpoints known to
 * differ at hi). In the absence of collisions at the queried prefixes,
 * "digests differ" is monotone. The final round verifies that the same
 * input gives different outputs. A collision can still hide an earlier
 * divergence, so that verification alone cannot certify firstness.
 *
 * Cost: 2 * (1 + roundsFor(hi - lo, 256) + 1) fe runs of one case each. For
 * 10,000 runs the first round leaves at most 39 values, so 6 fe runs.
 */
async function localiseDivergence(ctx: Context, target: Target, base: bigint, range: { lo: bigint; hi: bigint }, key: bigint): Promise<DiffResult> {
  const meter: Meter = { feRuns: 2 };
  const label = (l: string) => `${target.name}-${l}`;
  try {
    const found = await searchFirst(range.lo, range.hi, MAX_CHECKPOINTS, async (ks) => {
      const r = await onBoth(ctx, [{ target, call: checkpointCall(base, ks, key) }], label("search"), meter);
      const s = accsOf(r.s[0]!, "sonatina", ks.length);
      const n = accsOf(r.n[0]!, "native", ks.length);
      return ks.map((_, j) => s[j] !== n[j]);
    });
    const iteration = found.value - 1n;
    const r = await onBoth(ctx, [
      { target, call: { mode: "evaluate_at", base, iteration } },
    ], label("recover"), meter);
    const es = r.s[0]!, en = r.n[0]!;
    if (es.kind !== "evaluated") throw Stop.of(es, "sonatina", "Evaluated");
    if (en.kind !== "evaluated") throw Stop.of(en, "native", "Evaluated");
    if (es.arity !== target.args.length || en.arity !== es.arity || es.input.some((word, i) => word !== en.input[i])) {
      return { status: "infra", target, backend: "both", reason: "unlocated", detail: `backends evaluated different inputs at input ${iteration + 1n}`, feRuns: meter.feRuns };
    }
    if (es.output === en.output) {
      return { status: "infra", target, backend: "both", reason: "unlocated", detail: `checkpoints differ but outputs match at input ${iteration + 1n}`, feRuns: meter.feRuns };
    }
    return { status: "diverged", target, iteration, input: es.input, outputs: { sonatina: es.output, native: en.output }, rounds: 1 + found.rounds, feRuns: meter.feRuns };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return { status: "infra", target, backend: e.backend, reason: e.reason, detail: e.detail, feRuns: meter.feRuns };
  }
}
