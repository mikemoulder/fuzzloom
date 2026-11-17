// Campaign orchestration: run targets through fe in batched rounds, classify
// the results, and recover inputs when a property aborts or two backends
// diverge.
//
// Every fe run pays a fixed compile cost, so the unit of work is a round: one
// harness holding every evaluation that does not depend on another. Rounds
// on the two backends of a differential run execute concurrently.

import { join } from "node:path";
import { runBatch, type FeConfig } from "./fe.ts";
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
  /** Most cases in one search round (default 64). */
  maxWidth?: number;
};

export type Stats = { edgeArgs: bigint; correlated: bigint; extremes: bigint };

export type PropertyResult =
  | { status: "passed"; target: Target; runs: bigint; stats: Stats; feRuns: number }
  | { status: "failed"; target: Target; iteration: bigint; original: Words; input: Words; shrinkAttempts: bigint; shrinkComplete: boolean; feRuns: number }
  | { status: "aborted"; target: Target; iteration: bigint; original: Words; input: Words; abort: string; shrinkAborted: boolean; shrinkRounds: number; shrinkReplays: number; shrinkComplete: boolean; feRuns: number }
  | { status: "infra"; target: Target; reason: string; detail: string; feRuns: number };

export function workDir(userRoot: string): string {
  return join(userRoot, ".fuzzloom", "tmp");
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
 * Finds the smallest k in [lo, hi] with pred(k), for a predicate that is
 * monotone (false then true) and known true at hi. Each round probes up to
 * `width` points that split the undecided range evenly, all in one call.
 *
 * Guarantee: the exact minimum, in at most roundsFor(hi - lo, width) rounds.
 * Limit: if pred is not monotone the answer is some k with pred(k) and
 * !pred(k - 1), not necessarily the smallest.
 */
export async function searchFirst(lo: bigint, hi: bigint, width: number, probe: (ks: bigint[]) => Promise<boolean[]>): Promise<{ value: bigint; rounds: number }> {
  if (width < 1) throw new Error("width must be at least 1");
  let rounds = 0;
  while (lo < hi) {
    const u = hi - lo;
    const W = BigInt(width);
    const ks: bigint[] = [];
    if (u <= W) for (let k = lo; k < hi; k++) ks.push(k);
    else for (let j = 1n; j <= W; j++) ks.push(lo + (j * u) / (W + 1n));
    const res = await probe(ks);
    rounds++;
    const t = res.findIndex((x) => x);
    if (t >= 0) hi = ks[t]!;
    const f = t >= 0 ? t - 1 : ks.length - 1;
    if (f >= 0) lo = ks[f]! + 1n;
  }
  return { value: hi, rounds };
}

// ------------------------------------------------------- parallel shrinking

const bitLen = (v: bigint) => v.toString(2).length - (v === 0n ? 1 : 0);
const size = (w: Words, n: number) => w.slice(0, n).reduce((a, v) => a + bitLen(v), 0);
const total = (w: Words, n: number) => w.slice(0, n).reduce((a, v) => a + v, 0n);

/** One round of single-argument candidates: each nonzero argument set to 0 or shifted right by 1, 2, 4, 8, ... */
export function shrinkCandidates(best: Words, arity: number): Words[] {
  const out: Words[] = [];
  for (let i = 0; i < arity; i++) {
    const v = best[i]!;
    if (v === 0n) continue;
    const seen = new Set<bigint>();
    const add = (x: bigint) => {
      if (seen.has(x)) return;
      seen.add(x);
      const c: Words = [...best];
      c[i] = x;
      out.push(c);
    };
    add(0n);
    for (let s = 1; s < bitLen(v); s *= 2) add(v >> BigInt(s));
  }
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
 * Guarantee: when complete, no single argument can be set to 0 or shifted
 * right by any power of two and still reproduce (a local minimum under
 * those moves). Limit: not a global minimum, and joint moves are not tried.
 * At most `maxRounds` fe runs.
 */
export async function shrinkByReplay(target: Target, input: Words, maxRounds: number, reproduces: (ws: Words[]) => Promise<boolean[]>): Promise<{ input: Words; rounds: number; replays: number; complete: boolean }> {
  const n = target.args.length;
  let best: Words = [...input];
  let rounds = 0;
  let replays = 0;
  while (rounds < maxRounds) {
    const cands = shrinkCandidates(best, n);
    if (cands.length === 0) return { input: best, rounds, replays, complete: true };
    const ok = await reproduces(cands);
    rounds++;
    replays += cands.length;
    let pick: Words | undefined;
    cands.forEach((c, i) => {
      if (!ok[i]) return;
      if (!pick || size(c, n) < size(pick, n) || (size(c, n) === size(pick, n) && total(c, n) < total(pick, n))) pick = c;
    });
    if (!pick) return { input: best, rounds, replays, complete: true };
    best = pick;
  }
  return { input: best, rounds, replays, complete: shrinkCandidates(best, n).length === 0 };
}

// ----------------------------------------------------------- property runs

/**
 * Runs every property campaign in one round. A property that aborts (Fe
 * cannot catch a panic or a revert, so the payload carries no input) is
 * recovered with recoverAbort.
 */
export async function runProperties(ctx: Context, targets: Target[], base: bigint, runs: bigint): Promise<PropertyResult[]> {
  if (targets.length === 0) return [];
  const first = await runCases(ctx, targets.map((target) => ({ target, call: { mode: "check", base, runs } })), "check");
  const out: PropertyResult[] = [];
  for (const [i, target] of targets.entries()) {
    const o = first[i]!;
    if (o.kind === "passed") {
      out.push({ status: "passed", target, runs: o.runs, stats: { edgeArgs: o.edgeArgs, correlated: o.correlated, extremes: o.extremes }, feRuns: 1 });
    } else if (o.kind === "counterexample") {
      out.push({
        status: "failed", target, iteration: o.iteration, original: o.original, input: o.shrunk,
        shrinkAttempts: o.shrinkAttempts, shrinkComplete: o.shrinkComplete, feRuns: 1,
      });
    } else if (isAbort(o)) {
      out.push(await recoverAbort(ctx, target, base, runs, o));
    } else {
      const s = Stop.of(o, ctx.backend, "a campaign payload");
      out.push({ status: "infra", target, reason: s.reason, detail: s.detail, feRuns: 1 });
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
 * Cost: 1 + roundsFor(runs - 1, width) + 1 + shrink rounds fe runs.
 */
export async function recoverAbort(ctx: Context, target: Target, base: bigint, runs: bigint, first: Outcome): Promise<PropertyResult> {
  const meter: Meter = { feRuns: 1 };
  const run = (calls: HarnessCall[], label: string) => runCases(ctx, calls.map((call) => ({ target, call })), `${target.name}-${label}`, ctx.backend, meter);
  try {
    const width = chooseWidth(runs - 1n, ctx.maxWidth);
    const found = await searchFirst(1n, runs, width, async (ks) => {
      const os = await run(ks.map((k) => ({ mode: "check", base, runs: k })), "search");
      return os.map((o) => {
        if (isAbort(o)) return true;
        if (o.kind === "passed") return false;
        throw Stop.of(o, ctx.backend, "Passed or an abort");
      });
    });
    const iteration = found.value - 1n;
    const [g, rep] = await run([{ mode: "input_at", base, iteration }, { mode: "replay_at", base, iteration }], "recover");
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
  | { status: "infra"; target: Target; backend: Backend; reason: string; detail: string; feRuns: number };

/** One round on both backends at the same time. */
async function onBoth(ctx: Context, cases: Case[], label: string, meter?: Meter): Promise<{ s: Outcome[]; n: Outcome[] }> {
  const [s, n] = await Promise.all([
    runCases(ctx, cases, label, "sonatina", meter),
    runCases(ctx, cases, label, "native", meter),
  ]);
  return { s, n };
}

const digestOf = (o: Outcome, backend: Backend): bigint => {
  if (o.kind === "digest") return o.acc;
  // An abort while digesting is about the target, not a backend difference.
  throw o.kind === "infra" ? Stop.of(o, backend, "Digest") : new Stop("aborted", `${describeAbort(o)} while digesting`, backend);
};

/**
 * Differential run of every target: one digest round for all of them on
 * sonatina and native concurrently, then localiseDivergence for each target
 * whose digests differ.
 */
export async function runDiffs(ctx: Context, targets: Target[], base: bigint, runs: bigint): Promise<DiffResult[]> {
  if (targets.length === 0) return [];
  const first = await onBoth(ctx, targets.map((target) => ({ target, call: { mode: "digest", base, runs } })), "digest");
  const out: DiffResult[] = [];
  for (const [i, target] of targets.entries()) {
    try {
      const s = digestOf(first.s[i]!, "sonatina");
      const n = digestOf(first.n[i]!, "native");
      out.push(s === n ? { status: "agreed", target, runs, acc: s, feRuns: 2 } : await localiseDivergence(ctx, target, base, runs));
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      out.push({ status: "infra", target, backend: e.backend, reason: e.reason, detail: e.detail, feRuns: 2 });
    }
  }
  return out;
}

/**
 * Finds the first input on which the two backends disagree. Digests are
 * prefix-consistent (the first k folds are identical for any run count
 * >= k), so "digests differ at k runs" is monotone in k and searchFirst
 * finds the first diverging input exactly. One last round evaluates that
 * input on both backends (target_input_at alongside, since evaluate may
 * abort). Infrastructure outcomes are reported as such, never as a
 * divergence.
 */
export async function localiseDivergence(ctx: Context, target: Target, base: bigint, runs: bigint): Promise<DiffResult> {
  const meter: Meter = { feRuns: 2 };
  const label = (l: string) => `${target.name}-${l}`;
  try {
    const width = chooseWidth(runs - 1n, ctx.maxWidth);
    const found = await searchFirst(1n, runs, width, async (ks) => {
      const r = await onBoth(ctx, ks.map((k) => ({ target, call: { mode: "digest", base, runs: k } })), label("search"), meter);
      return ks.map((_, i) => digestOf(r.s[i]!, "sonatina") !== digestOf(r.n[i]!, "native"));
    });
    const iteration = found.value - 1n;
    const r = await onBoth(ctx, [
      { target, call: { mode: "target_input_at", base, iteration } },
      { target, call: { mode: "evaluate_at", base, iteration } },
    ], label("recover"), meter);
    const g = r.s[0]!;
    if (g.kind !== "generated") throw Stop.of(g, "sonatina", "Generated");
    const es = r.s[1]!, en = r.n[1]!;
    if (es.kind !== "evaluated") throw Stop.of(es, "sonatina", "Evaluated");
    if (en.kind !== "evaluated") throw Stop.of(en, "native", "Evaluated");
    return { status: "diverged", target, iteration, input: g.input, outputs: { sonatina: es.output, native: en.output }, rounds: found.rounds, feRuns: meter.feRuns };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return { status: "infra", target, backend: e.backend, reason: e.reason, detail: e.detail, feRuns: meter.feRuns };
  }
}
