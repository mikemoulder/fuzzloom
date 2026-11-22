// Measure detection with the real Fe properties and unchanged bounds.
// Perform no shrinking or corpus mutation. Aborting campaigns are
// localized by comparing prefixes of their original stream.
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discover } from "../packages/cli/src/discover.ts";
import { runCases } from "../packages/cli/src/engine.ts";
import { defaultFeConfig, feVersion } from "../packages/cli/src/fe.ts";
import { toJson } from "../packages/cli/src/report.ts";

const examples = new Map([
  ["vault-math", ["prop_fee_matches_exact_math", "prop_withdraw_never_overdraws", "prop_redeem_rounds_toward_vault", "prop_share_price_defined"]],
  ["token-ledger", ["prop_transfer_conserves_supply", "prop_vested_never_exceeds_total"]],
]);
const backend = process.argv[2] ?? "sonatina";
if (!["sonatina", "native"].includes(backend)) throw new Error("expected sonatina or native");
const runs = 10000n;
const seeds = Array.from({ length: 20 }, (_, i) => BigInt(i + 1));
const fe = defaultFeConfig();
const root = mkdtempSync(join(tmpdir(), "fuzzloom-sampling-"));
const result = [];
let invocations = 0;

function isAbort(o) {
  return o.kind === "panic" || o.kind === "revert";
}

async function evaluate(ctx, jobs, label) {
  const cases = jobs.map(({ trial, count }) => ({
    target: trial.target, call: { mode: "check", base: trial.seed, runs: count, uniform: trial.uniform, measure: true },
  }));
  invocations++;
  process.stderr.write(`${backend} ${ctx.ingot} ${label}: ${cases.length} cases\n`);
  const outcomes = await runCases(ctx, cases, label);
  return jobs.map(({ trial }, i) => {
    trial.feRuns++;
    const outcome = outcomes[i];
    if (outcome.kind === "infra") {
      throw new Error(`${trial.target.name}, seed ${trial.seed}: ${outcome.reason}: ${outcome.detail}`);
    }
    return outcome;
  });
}

try {
  for (const [example, names] of examples) {
    const copy = join(root, example);
    mkdirSync(copy);
    for (const name of ["fe.toml", "src"]) cpSync(resolve("examples", example, name), join(copy, name), { recursive: true });
    const d = discover(copy);
    const targets = names.map((name) => {
      const t = d.targets.find((item) => item.name === name);
      if (!t) throw new Error(`missing property ${name}`);
      return t;
    });
    const ctx = { userRoot: copy, ingot: d.ingot, backend, fe };
    const trials = targets.flatMap((target) => [false, true].flatMap((uniform) =>
      seeds.map((seed) => ({ target, uniform, seed, feRuns: 0, first: null }))));
    const first = await evaluate(ctx, trials.map((trial) => ({ trial, count: runs })), "initial");
    let pending = [];
    for (const [i, outcome] of first.entries()) {
      const trial = trials[i];
      if (outcome.kind === "counterexample") trial.first = outcome.iteration + 1n;
      else if (isAbort(outcome)) pending.push({ trial, lo: 0n, hi: runs, count: 1n, bracketed: false });
      else if (outcome.kind !== "passed") throw new Error(`unexpected ${outcome.kind}`);
    }
    let round = 0;
    while (pending.length) {
      const outcomes = await evaluate(ctx, pending, `prefix-${++round}`);
      pending = pending.filter((search, i) => {
        const o = outcomes[i];
        if (o.kind === "passed") search.lo = search.count;
        else if (isAbort(o)) {
          search.hi = search.count;
          search.bracketed = true;
        } else {
          throw new Error(`non-monotone abort prefix for ${search.trial.target.name}: ${o.kind}`);
        }
        if (search.hi - search.lo === 1n) {
          search.trial.first = search.hi;
          return false;
        }
        const doubled = search.count * 2n;
        search.count = !search.bracketed && doubled < search.hi ? doubled : (search.lo + search.hi) / 2n;
        return true;
      });
    }
    result.push(...trials.map(({ target, uniform, seed, feRuns, first }) => ({
      example, property: target.name, sampler: uniform ? "uniform" : "biased", seed, first, feRuns,
    })));
  }
  console.log(JSON.stringify(toJson({ fe: feVersion(fe), backend, runs, invocations, result }), null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
