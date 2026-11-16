// Campaign orchestration: run one target through fe, classify the result,
// and recover the input when a property aborts.

import { join } from "node:path";
import { runHarness, type FeConfig } from "./fe.ts";
import { writeHarness, type HarnessCall } from "./harness.ts";
import type { Backend, Outcome, Target, Words } from "./types.ts";

export type Context = {
  userRoot: string;
  ingot: string;
  backend: Backend;
  fe: FeConfig;
  /** Called after every fe run, for progress output. */
  onRun?: (what: string, ms: number) => void;
  /** fe replays allowed when shrinking an aborting property (default 16). */
  abortShrinkBudget?: number;
};

export type Stats = { edgeArgs: bigint; correlated: bigint; extremes: bigint };

export type PropertyResult =
  | { status: "passed"; target: Target; runs: bigint; stats: Stats; feRuns: number; ms: number }
  | { status: "failed"; target: Target; iteration: bigint; original: Words; input: Words; shrinkAttempts: bigint; shrinkComplete: boolean; feRuns: number; ms: number }
  | { status: "aborted"; target: Target; iteration: bigint; original: Words; input: Words; abort: string; shrinkAborted: boolean; shrinkReplays: number; shrinkComplete: boolean; feRuns: number; ms: number }
  | { status: "infra"; target: Target; reason: string; detail: string; feRuns: number; ms: number };

export function workDir(userRoot: string): string {
  return join(userRoot, ".fuzzloom", "tmp");
}

/** Runs one harness call and returns its outcome. */
export function call(ctx: Context, target: Target, c: HarnessCall): { outcome: Outcome; ms: number } {
  const dir = writeHarness({ userRoot: ctx.userRoot, ingot: ctx.ingot, target, call: c, workDir: workDir(ctx.userRoot) });
  const r = runHarness(dir, ctx.backend, ctx.fe);
  ctx.onRun?.(`${target.name} ${c.mode}`, r.ms);
  return { outcome: r.outcome, ms: r.ms };
}

const isAbort = (o: Outcome) => o.kind === "panic" || o.kind === "revert";

export function describeAbort(o: Outcome): string {
  if (o.kind === "panic") return `${o.reason} (Panic 0x${o.code.toString(16)})`;
  if (o.kind === "revert") return `reverted: "${o.message}"`;
  return o.kind;
}

/**
 * Runs a property campaign. If it aborts (Fe cannot catch a panic or a
 * revert, so the payload carries no input), recovers the input:
 *
 *   1. Bisect on runs. A campaign of k runs either passes or aborts: it
 *      cannot return a counterexample, because the first failing input and
 *      its shrink are the same for every k past it, so that shrink would
 *      abort too. The smallest aborting k gives iteration k - 1.
 *   2. input_at(iteration) reconstructs the input (it evaluates nothing).
 *   3. replay(input) tells the two cases apart: an abort means the property
 *      itself aborts on that input; a plain false means the property fails
 *      normally and it was the shrinker that hit an aborting candidate.
 *
 * Cost: about log2(runs) + 2 fe runs.
 */
export function runProperty(ctx: Context, target: Target, base: bigint, runs: bigint): PropertyResult {
  let feRuns = 0;
  let ms = 0;
  const run = (c: HarnessCall) => {
    const r = call(ctx, target, c);
    feRuns++;
    ms += r.ms;
    return r.outcome;
  };
  const infra = (o: Outcome): PropertyResult => o.kind === "infra"
    ? { status: "infra", target, reason: o.reason, detail: o.detail, feRuns, ms }
    : { status: "infra", target, reason: "unexpected", detail: `unexpected ${o.kind} payload`, feRuns, ms };

  const first = run({ mode: "check", base, runs });
  if (first.kind === "passed") {
    return { status: "passed", target, runs: first.runs, stats: { edgeArgs: first.edgeArgs, correlated: first.correlated, extremes: first.extremes }, feRuns, ms };
  }
  if (first.kind === "counterexample") {
    return {
      status: "failed", target, iteration: first.iteration, original: first.original, input: first.shrunk,
      shrinkAttempts: first.shrinkAttempts, shrinkComplete: first.shrinkComplete, feRuns, ms,
    };
  }
  if (!isAbort(first)) return infra(first);

  let lo = 1n;
  let hi = runs;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const o = run({ mode: "check", base, runs: mid });
    if (isAbort(o)) hi = mid;
    else if (o.kind === "passed") lo = mid + 1n;
    else return infra(o);
  }
  const iteration = hi - 1n;
  const g = run({ mode: "input_at", base, iteration });
  if (g.kind !== "generated") return infra(g);
  const rep = run({ mode: "replay", input: g.input });
  let reproduces: (o: Outcome) => boolean;
  let abort: string;
  let shrinkAborted: boolean;
  if (isAbort(rep)) {
    abort = describeAbort(rep);
    shrinkAborted = false;
    reproduces = (o) => isAbort(o) && describeAbort(o) === abort;
  } else if (rep.kind === "replayed" && rep.failed) {
    abort = describeAbort(first);
    shrinkAborted = true;
    reproduces = (o) => o.kind === "replayed" && o.failed;
  } else {
    return { status: "infra", target, reason: "inconsistent", detail: "the recovered input neither fails nor aborts on replay", feRuns, ms };
  }
  const s = shrinkByReplay(target, g.input, ctx.abortShrinkBudget ?? 16, (w) => reproduces(run({ mode: "replay", input: w })));
  return {
    status: "aborted", target, iteration, original: g.input, input: s.input, abort, shrinkAborted,
    shrinkReplays: s.replays, shrinkComplete: s.complete, feRuns, ms,
  };
}

/**
 * Coarse shrinking when every evaluation is a separate fe run (an aborting
 * property cannot be shrunk inside Fe, since Fe cannot catch the abort).
 * Per argument: try 0, otherwise keep halving while the failure reproduces.
 * Rounds repeat until one makes no progress (complete) or the replay budget
 * is spent. `reproduces` must demand the same failure (for aborts, the same
 * panic code or revert message), so shrinking cannot slide onto a different
 * bug.
 */
export function shrinkByReplay(target: Target, input: Words, budget: number, reproduces: (w: Words) => boolean): { input: Words; replays: number; complete: boolean } {
  let best: Words = [...input];
  let replays = 0;
  const tryWith = (i: number, v: bigint): boolean => {
    if (replays >= budget) return false;
    const c: Words = [...best];
    c[i] = v;
    replays++;
    if (reproduces(c)) {
      best = c;
      return true;
    }
    return false;
  };
  let progressed = true;
  while (progressed && replays < budget) {
    progressed = false;
    for (let i = 0; i < target.args.length; i++) {
      if (best[i] === 0n) continue;
      if (tryWith(i, 0n)) {
        progressed = true;
        continue;
      }
      while (best[i]! > 1n && tryWith(i, best[i]! >> 1n)) progressed = true;
    }
  }
  return { input: best, replays, complete: !progressed };
}
