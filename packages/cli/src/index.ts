#!/usr/bin/env node
// Fuzzloom CLI entry point.

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { discover } from "./discover.ts";
import { defaultFeConfig, feVersion } from "./fe.ts";
import { call, describeAbort, runDiff, runProperty, type Context, type DiffResult, type PropertyResult } from "./engine.ts";
import { listRecords, loadRecord, makeRecord, recordWords, saveRecord, type FailureRecord } from "./store.ts";
import { bold, dim, formatResult, green, red, toJson, values, yellow } from "./report.ts";
import { wordToValue } from "./abi.ts";
import type { Discovery } from "./discover.ts";
import type { Backend, Outcome, Target } from "./types.ts";

const USAGE = `fuzzloom <command> [path] [options]

Commands:
  list      [path]              show the prop_* and diff_* functions found
  fuzz      [path]              run every property campaign
  reproduce <id> [path]         replay one saved failure from its stored input
  replay    [path]              replay every saved failure (regression check)
  diff      [path]              compare every diff_* target on sonatina and native

Options:
  --seed <n>        base seed (default: random, printed so the run can be repeated)
  --runs <n>        inputs per property (default 10000; diff default 100000)
  --backend <b>     sonatina (EVM, default) or native
  --only <name>     run only targets whose name contains this text
  --json            machine-readable output
  -h, --help

Exit codes: 0 all passed, 1 a property failed or aborted, 2 infrastructure error.`;

type Opts = { seed?: string; runs?: string; backend: string; only?: string; json: boolean };

function main(argv: string[]): number {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      seed: { type: "string" },
      runs: { type: "string" },
      backend: { type: "string", default: "sonatina" },
      only: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command] = positionals;
  if (v.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const opts = v as Opts;
  if (opts.backend !== "sonatina" && opts.backend !== "native") throw new Error(`unknown backend ${opts.backend}`);
  const pathArg = (i: number) => resolve(positionals[i] ?? ".");
  switch (command) {
    case "list": return list(pathArg(1), opts);
    case "fuzz": return fuzz(pathArg(1), opts);
    case "diff": return diff(pathArg(1), opts);
    case "replay": return replayAll(pathArg(1), opts);
    case "reproduce": {
      const id = positionals[1];
      if (!id) throw new Error("reproduce needs a failure id (see .fuzzloom/failures/)");
      return reproduce(pathArg(2), id, opts);
    }
    default:
      console.error(`unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

function list(root: string, opts: Opts): number {
  const d = discover(root);
  if (opts.json) {
    console.log(JSON.stringify(toJson(d), null, 2));
    return 0;
  }
  console.log(bold(`${d.ingot}`) + dim(`  ${root}`));
  for (const t of d.targets) {
    const sig = t.args.map((a) => `${a.name}: ${a.type}`).join(", ");
    console.log(`  ${t.kind === "property" ? "prop" : "diff"}  ${t.name}(${sig})${t.returns ? ` -> ${t.returns}` : ""}  ${dim(`${t.file}:${t.line}`)}`);
  }
  for (const s of d.skipped) console.log(`  ${yellow("skip")}  ${s.name}  ${dim(`${s.file}:${s.line}`)}  ${s.reason}`);
  return 0;
}

function fuzz(root: string, opts: Opts): number {
  const d = discover(root);
  const base = baseSeed(opts);
  const runs = BigInt(opts.runs ?? "10000");
  const backend = opts.backend as Backend;
  const fe = defaultFeConfig();
  const version = feVersion(fe);
  const targets = d.targets.filter((t) => t.kind === "property" && (!opts.only || t.name.includes(opts.only)));
  const ctx: Context = {
    userRoot: root, ingot: d.ingot, backend, fe,
    onRun: progress(opts),
  };
  if (!opts.json) {
    console.log(`${bold("fuzzloom fuzz")} ${d.ingot}  ${dim(`seed ${base}, ${runs} runs, ${backend}, ${version}`)}`);
    for (const s of d.skipped) console.log(`${yellow("SKIP")}  ${s.name}  ${dim(`${s.file}:${s.line}`)}  ${s.reason}`);
  }
  const results: { result: PropertyResult; record?: string }[] = [];
  for (const t of targets) {
    const r = runProperty(ctx, t, base, runs);
    let id: string | undefined;
    if (r.status === "failed" || r.status === "aborted") {
      const rec = makeRecord({
        kind: r.status === "failed" ? "property" : "abort",
        target: t, input: r.input, original: r.original,
        iteration: r.iteration, base, runs, backend, feVersion: version,
        ...(r.status === "aborted" ? { detail: r.abort } : {}),
      });
      saveRecord(root, rec);
      id = rec.id;
    }
    results.push({ result: r, record: id });
    if (!opts.json) for (const line of formatResult(r, id)) console.log(line);
  }
  const failed = results.filter((x) => x.result.status === "failed" || x.result.status === "aborted").length;
  const infra = results.filter((x) => x.result.status === "infra").length;
  const passed = results.length - failed - infra;
  if (opts.json) {
    console.log(JSON.stringify(toJson({ ingot: d.ingot, seed: base, runs, backend, fe_version: version, skipped: d.skipped, results }), null, 2));
  } else {
    console.log(`\n${passed} passed, ${failed} failed, ${infra} infrastructure errors  ${dim(`(repeat with --seed ${base})`)}`);
  }
  return infra > 0 ? 2 : failed > 0 ? 1 : 0;
}

function baseSeed(opts: Opts): bigint {
  return opts.seed !== undefined ? BigInt(opts.seed) : BigInt("0x" + randomBytes(8).toString("hex"));
}

function progress(opts: Opts): Context["onRun"] {
  return opts.json ? undefined : (what, ms) => process.stderr.write(dim(`  .. ${what} (${ms} ms)\n`));
}

function diff(root: string, opts: Opts): number {
  const d = discover(root);
  const base = baseSeed(opts);
  const runs = BigInt(opts.runs ?? "100000");
  const fe = defaultFeConfig();
  const version = feVersion(fe);
  const targets = d.targets.filter((t) => t.kind === "differential" && (!opts.only || t.name.includes(opts.only)));
  const ctx: Context = { userRoot: root, ingot: d.ingot, backend: "sonatina", fe, onRun: progress(opts) };
  if (!opts.json) console.log(`${bold("fuzzloom diff")} ${d.ingot}  ${dim(`seed ${base}, ${runs} inputs per target, sonatina vs native, ${version}`)}`);
  const results: { result: DiffResult; record?: string }[] = [];
  for (const t of targets) {
    const r = runDiff(ctx, t, base, runs);
    let id: string | undefined;
    if (r.status === "diverged") {
      const rec = makeRecord({
        kind: "differential", target: t, input: r.input, iteration: r.iteration, base, runs, backend: "both", feVersion: version,
        detail: `sonatina returned ${wordToValue(r.outputs.sonatina, t.returns!)}, native returned ${wordToValue(r.outputs.native, t.returns!)}`,
      });
      saveRecord(root, rec);
      id = rec.id;
    }
    results.push({ result: r, record: id });
    if (!opts.json) for (const line of formatDiff(r, id)) console.log(line);
  }
  const diverged = results.filter((x) => x.result.status === "diverged").length;
  const infra = results.filter((x) => x.result.status === "infra").length;
  if (opts.json) console.log(JSON.stringify(toJson({ ingot: d.ingot, seed: base, runs, fe_version: version, results }), null, 2));
  else console.log(`\n${results.length - diverged - infra} agreed, ${diverged} diverged, ${infra} infrastructure errors  ${dim(`(repeat with --seed ${base})`)}`);
  return infra > 0 ? 2 : diverged > 0 ? 1 : 0;
}

function formatDiff(r: DiffResult, id?: string): string[] {
  const t = r.target;
  const sig = `${t.name}(${t.args.map((a) => a.type).join(", ")}) -> ${t.returns}`;
  switch (r.status) {
    case "agreed":
      return [`${green("AGREE")} ${sig}  ${dim(`${r.runs} inputs, identical digests on sonatina and native`)}`];
    case "diverged":
      return [
        `${red("DIVERGE")} ${sig}  ${dim(`first at input ${r.iteration + 1n}, found by bisection in ${r.feRuns} fe runs`)}`,
        ...values(t, r.input).map((l) => `      ${bold(l)}`),
        `      sonatina returns ${bold(String(wordToValue(r.outputs.sonatina, t.returns!)))}`,
        `      native   returns ${bold(String(wordToValue(r.outputs.native, t.returns!)))}`,
        ...(id ? [dim(`      reproduce: fuzzloom reproduce ${id}`)] : []),
      ];
    case "infra":
      return [`${yellow("INFRA")} ${sig}  ${r.reason} on ${r.backend}`, ...r.detail.split("\n").slice(0, 4).map((l) => dim(`      ${l}`))];
  }
}

type Verdict = { reproduces: boolean | undefined; text: string };

/** Replays one record. `reproduces` is undefined on an infrastructure outcome. */
function check(ctx: Context, d: Discovery, rec: FailureRecord): Verdict {
  const t: Target | undefined = d.targets.find((x) => x.name === rec.target);
  if (!t) return { reproduces: undefined, text: `${rec.target} no longer exists in ${d.ingot}` };
  if (t.args.length !== rec.args.length || t.args.some((a, i) => a.type !== rec.args[i]!.type)) {
    return { reproduces: undefined, text: `${rec.target} changed signature since the failure was recorded` };
  }
  const w = recordWords(rec);
  const infraText = (o: Outcome) => (o.kind === "infra" ? `${o.reason}: ${o.detail.split("\n")[0]}` : `unexpected ${o.kind}`);
  if (rec.kind === "differential") {
    const s = call({ ...ctx, backend: "sonatina" }, t, { mode: "evaluate", input: w }).outcome;
    const n = call({ ...ctx, backend: "native" }, t, { mode: "evaluate", input: w }).outcome;
    if (s.kind !== "evaluated") return { reproduces: undefined, text: infraText(s) };
    if (n.kind !== "evaluated") return { reproduces: undefined, text: infraText(n) };
    const sv = wordToValue(s.output, t.returns!), nv = wordToValue(n.output, t.returns!);
    return s.output !== n.output
      ? { reproduces: true, text: `still diverges: sonatina ${sv}, native ${nv}` }
      : { reproduces: false, text: `backends now agree (${sv})` };
  }
  const backend: Backend = rec.backend === "native" ? "native" : "sonatina";
  const o = call({ ...ctx, backend }, t, { mode: "replay", input: w }).outcome;
  if (o.kind === "replayed") {
    return o.failed ? { reproduces: true, text: "still fails" } : { reproduces: false, text: "now passes" };
  }
  if (o.kind === "panic" || o.kind === "revert") {
    const same = rec.kind === "abort" && rec.detail === describeAbort(o);
    return { reproduces: true, text: same ? `still aborts: ${describeAbort(o)}` : `aborts differently: ${describeAbort(o)}` };
  }
  return { reproduces: undefined, text: infraText(o) };
}

function applyVerdict(root: string, rec: FailureRecord, v: Verdict): string {
  if (v.reproduces === undefined) return yellow("INFRA");
  const was = rec.status;
  saveRecord(root, { ...rec, status: v.reproduces ? "open" : "fixed", updated_at: new Date().toISOString() });
  if (v.reproduces && was === "fixed") return red("REGRESSED");
  return v.reproduces ? red("FAILS") : green("FIXED");
}

function reproduce(root: string, id: string, opts: Opts): number {
  const d = discover(root);
  const rec = loadRecord(root, id);
  const ctx: Context = { userRoot: root, ingot: d.ingot, backend: "sonatina", fe: defaultFeConfig(), onRun: progress(opts) };
  const target = d.targets.find((x) => x.name === rec.target);
  const v = check(ctx, d, rec);
  const label = applyVerdict(root, rec, v);
  if (opts.json) {
    console.log(JSON.stringify(toJson({ id, reproduces: v.reproduces, text: v.text, record: rec }), null, 2));
  } else {
    console.log(`${label}  ${rec.id}  ${v.text}`);
    if (target) for (const l of values(target, recordWords(rec))) console.log(`      ${l}`);
  }
  return v.reproduces === undefined ? 2 : v.reproduces ? 1 : 0;
}

function replayAll(root: string, opts: Opts): number {
  const d = discover(root);
  const records = listRecords(root);
  const ctx: Context = { userRoot: root, ingot: d.ingot, backend: "sonatina", fe: defaultFeConfig(), onRun: progress(opts) };
  if (!opts.json) console.log(`${bold("fuzzloom replay")} ${d.ingot}  ${dim(`${records.length} saved failures`)}`);
  let failing = 0;
  let infra = 0;
  const out: unknown[] = [];
  for (const rec of records) {
    const v = check(ctx, d, rec);
    const label = applyVerdict(root, rec, v);
    if (v.reproduces === undefined) infra++;
    else if (v.reproduces) failing++;
    out.push({ id: rec.id, reproduces: v.reproduces, text: v.text });
    if (!opts.json) console.log(`${label}  ${rec.id}  ${dim(v.text)}`);
  }
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else console.log(`\n${records.length - failing - infra} fixed, ${failing} still failing, ${infra} infrastructure errors`);
  return infra > 0 ? 2 : failing > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`fuzzloom: ${(e as Error).message}`);
  process.exitCode = 2;
}
