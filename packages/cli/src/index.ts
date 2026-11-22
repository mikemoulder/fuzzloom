#!/usr/bin/env node
// Fuzzloom CLI entry point.

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { discover, type Skipped } from "./discover.ts";
import { defaultFeConfig, feVersion } from "./fe.ts";
import { describeAbort, runCases, runDiffs, runProperties, workDir, type Context, type DiffResult, type PropertyResult, type Seed } from "./engine.ts";
import type { Case } from "./harness.ts";
import { listRecords, loadRecord, makeRecord, recordSequence, recordWords, saveRecord, type FailureRecord } from "./store.ts";
import { bold, dim, formatResult, green, red, toJson, values, yellow } from "./report.ts";
import { wordToValue } from "./abi.ts";
import { checks } from "./doctor.ts";
import { junitXml, type JUnitCase, type JUnitOutcome } from "./junit.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { safeDir } from "./paths.ts";
import type { Discovery } from "./discover.ts";
import { MAX_SEQUENCE_STEPS, type Backend, type Outcome, type Target, type Words } from "./types.ts";

const USAGE = `fuzzloom <command> [path] [options]

Commands:
  doctor    [path]              check fe, the native backend, the Fe library and the project
  list      [path]              show the prop_*, diff_* and seq_* functions found
  fuzz      [path]              run every property campaign
  reproduce <id> [path]         replay one saved failure from its stored input
  replay    [path]              replay every saved failure (regression check)
  diff      [path]              compare every diff_* target on sonatina and native
  sequence  [path]              generate and shrink traces of seq_* invariant checks

Options:
  --seed <n>        base seed (default: random, printed so the run can be repeated)
  --digest-key <n>  diff: reuse a recorded checkpoint key (default: independently random)
  --runs <n>        inputs per target (defaults: fuzz 10000, diff 100000, sequence 1000)
  --steps <n>       sequence: maximum actions per trace (default 8)
  --backend <b>     sonatina (EVM, default) or native
  --only <name>     run only targets (or, for replay, saved failures) whose name contains this text
  --strict          fail before running if a selected campaign target was skipped
  --no-corpus       fuzz: skip the mutation campaigns seeded from saved failures
  --uniform         fuzz: draw independent uniform arguments without corpus mutation
  --json            machine-readable output
  --junit <file>    fuzz, diff, sequence, replay: also write a JUnit XML report
  -h, --help

Exit codes: 0 all passed, 1 a property failed or aborted, 2 infrastructure error.`;

type Opts = { seed?: string; "digest-key"?: string; runs?: string; steps?: string; backend: string; only?: string; json: boolean; strict: boolean; "no-corpus": boolean; uniform: boolean; junit?: string };
type RunOpts = Opts & { scratchDir: string };

/** Most saved failures seeding mutation campaigns, per property (most recently updated first). */
const SEEDS_PER_TARGET = 8;

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      seed: { type: "string" },
      "digest-key": { type: "string" },
      runs: { type: "string" },
      steps: { type: "string" },
      backend: { type: "string", default: "sonatina" },
      only: { type: "string" },
      json: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      "no-corpus": { type: "boolean", default: false },
      uniform: { type: "boolean", default: false },
      junit: { type: "string" },
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
  if (opts["digest-key"] !== undefined && command !== "diff") throw new Error("--digest-key requires diff");
  if (opts.uniform && command !== "fuzz") throw new Error("--uniform requires fuzz");
  if (opts.strict && command !== "fuzz" && command !== "diff" && command !== "sequence") throw new Error("--strict requires fuzz, diff or sequence");
  if (opts.seed !== undefined) uint64Option("--seed", opts.seed, 0n);
  if (opts.runs !== undefined) uint64Option("--runs", opts.runs, 1n);
  if (opts.steps !== undefined && (command !== "sequence" || !/^[1-8]$/.test(opts.steps))) {
    throw new Error("--steps must be 1 to 8 and requires sequence");
  }
  if (opts.only !== undefined && !opts.only.trim()) throw new Error("--only requires a nonempty target filter");
  const pathArg = (i: number) => resolve(positionals[i] ?? ".");
  switch (command) {
    case "doctor": return doctor(positionals[1] ? pathArg(1) : undefined, opts);
    case "list": return list(pathArg(1), opts);
    case "fuzz": return scratch(pathArg(1), opts, fuzz);
    case "diff": return scratch(pathArg(1), opts, diff);
    case "sequence": return scratch(pathArg(1), opts, sequence);
    case "replay": return scratch(pathArg(1), opts, replayAll);
    case "reproduce": {
      const id = positionals[1];
      if (!id) throw new Error("reproduce needs a failure id (see .fuzzloom/failures/)");
      return scratch(pathArg(2), opts, (root, options) => reproduce(root, id, options));
    }
    default:
      console.error(`unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Removes the generated harnesses under .fuzzloom/tmp once a command is
 * done, so they never show up in the user's own `fe fmt --check` or
 * `fe test`. They are kept after an infrastructure error (exit 2), where the
 * generated code is what you need to debug it.
 */
async function scratch(root: string, opts: Opts, run: (root: string, options: RunOpts) => Promise<number>): Promise<number> {
  if (!existsSync(join(root, "fe.toml"))) throw new Error(`no fe.toml in ${root}`);
  const base = workDir(root);
  mkdirSync(base, { recursive: true });
  const scratchDir = mkdtempSync(join(base, "run-"));
  let code: number | undefined;
  try {
    code = await run(root, { ...opts, scratchDir });
    return code;
  } finally {
    if (code === 2) {
      if (!opts.json) console.error(dim(`generated harnesses kept for debugging in ${scratchDir}`));
    } else {
      const dir = safeDir(root, ".fuzzloom", "tmp", basename(scratchDir));
      if (dir === scratchDir) rmSync(dir, { recursive: true, force: true });
    }
  }
}

function uint64Option(option: string, text: string, min: bigint): void {
  if (!/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(text)) throw new Error(`${option} must be an unsigned 64-bit integer`);
  const value = BigInt(text);
  if (value < min || value >= 1n << 64n) throw new Error(`${option} must be in ${min}..=18446744073709551615`);
}

function doctor(root: string | undefined, opts: Opts): number {
  const cs = checks(root ?? (existsSync(resolve("fe.toml")) ? resolve(".") : undefined));
  if (opts.json) {
    console.log(JSON.stringify(cs, null, 2));
  } else {
    const width = Math.max(...cs.map((c) => c.name.length));
    for (const c of cs) {
      const tag = c.level === "ok" ? green("ok  ") : c.level === "warn" ? yellow("warn") : red("FAIL");
      console.log(`${tag}  ${c.name.padEnd(width)}  ${c.detail}`);
      if (c.fix) console.log(dim(`      ${" ".repeat(width)}  ${c.fix}`));
    }
  }
  return cs.some((c) => c.level === "fail") ? 2 : 0;
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
    console.log(`  ${PREFIX[t.kind]}  ${t.name}(${sig})${t.returns ? ` -> ${t.returns}` : ""}  ${dim(`${t.file}:${t.line}`)}`);
    if (t.effects?.length) console.log(dim(`        uses ${t.effects.map((e) => `${e.mut ? "mut " : ""}${e.type} <- ${e.fixture}()`).join(", ")}`));
    for (const b of t.bounds ?? []) {
      const a = t.args[b.arg]!;
      // A signed range is zigzag words 0..=W: -k..=k for W = 2k, -(k+1)..=k for W = 2k + 1.
      const k = b.hi / 2n;
      const range = a.type.startsWith("i") ? `${b.hi % 2n === 0n ? -k : -(k + 1n)}..=${k}` : `${b.lo}..=${b.hi}`;
      console.log(dim(`        ${a.name} in ${range}`));
    }
  }
  for (const s of d.skipped) console.log(`  ${yellow("skip")}  ${s.name}  ${dim(`${s.file}:${s.line}`)}  ${s.reason}`);
  return 0;
}

const PREFIX = { property: "prop", differential: "diff", sequence: "seq" } as const;

function selectedCampaign(d: Discovery, kind: Target["kind"], command: string, opts: Opts): { targets: Target[]; skipped: Skipped[] } | undefined {
  const matches = (name: string) => name.startsWith(`${PREFIX[kind]}_`) && (!opts.only || name.includes(opts.only));
  const targets = d.targets.filter((t) => t.kind === kind && matches(t.name));
  const skipped = d.skipped.filter((s) => matches(s.name));
  const coverage = campaignCoverage(targets, skipped, []);
  if (!opts.json) for (const s of skipped) console.log(`${yellow("SKIP")} ${s.name} (${s.file}:${s.line}) ${s.reason}`);
  if (opts.strict && skipped.length > 0) {
    writeJUnit(opts, `fuzzloom ${command} ${d.ingot}`, Date.now(), { command, strict: "true" }, skipped.map((s) => ({
      name: s.name, classname: `${d.ingot}.${command}`, outcome: "error", type: "skipped-target",
      message: s.reason, body: `${s.file}:${s.line} ${s.reason}`,
    })));
    if (opts.json) console.log(JSON.stringify(toJson({ ingot: d.ingot, coverage, skipped, error: "strict discovery rejected skipped targets", results: [] }), null, 2));
    else console.error(`strict discovery rejected ${skipped.length} skipped target(s). No campaigns ran.`);
    return;
  }
  if (targets.length === 0) throw new Error(`no runnable ${PREFIX[kind]}_* targets${opts.only ? ` matching "${opts.only}"` : ""}; use fuzzloom list`);
  return { targets, skipped };
}

/** Count primary results only. Auxiliary corpus campaigns and search
 * replays are excluded. Infrastructure outcomes have no verified count. */
function campaignCoverage(targets: Target[], skipped: Skipped[], measurements: readonly (bigint | undefined)[]) {
  return {
    selectedTargets: targets.length + skipped.length,
    runnableTargets: targets.length,
    skippedTargets: skipped.length,
    targetsRun: measurements.length,
    targetsCompleted: measurements.filter((n) => n !== undefined).length,
    inputsThroughReportedOutcome: measurements.reduce<bigint>((total, n) => total + (n ?? 0n), 0n),
  };
}

function printCoverage(unit: string, coverage: ReturnType<typeof campaignCoverage>): void {
  console.log(`  ran ${coverage.targetsRun} of ${coverage.selectedTargets} selected targets, ${coverage.skippedTargets} skipped, ${coverage.targetsCompleted} completed, ${coverage.inputsThroughReportedOutcome} ${unit} through reported outcomes`);
}

async function fuzz(root: string, opts: RunOpts): Promise<number> {
  const d = discover(root);
  const selection = selectedCampaign(d, "property", "fuzz", opts);
  if (!selection) return 2;
  const { targets, skipped } = selection;
  const base = baseSeed(opts);
  const runs = BigInt(opts.runs ?? "10000");
  const backend = opts.backend as Backend;
  const fe = defaultFeConfig();
  const version = feVersion(fe);
  const ctx: Context = {
    userRoot: root, ingot: d.ingot, backend, fe,
    onRun: progress(opts), uniform: opts.uniform, scratchDir: opts.scratchDir,
  };
  const seeds = opts["no-corpus"] || opts.uniform ? new Map<string, Seed[]>() : seedsFrom(root, d, targets);
  const seeded = [...seeds.values()].reduce((a, s) => a + s.length, 0);
  if (!opts.json) {
    const corpus = seeded ? `, ${seeded} mutation campaign${seeded === 1 ? "" : "s"} from saved failures` : "";
    const sampler = opts.uniform ? ", uniform sampling" : "";
    console.log(`${bold("fuzzloom fuzz")} ${d.ingot}  ${dim(`seed ${base}, ${runs} runs, ${backend}, ${version}${sampler}${corpus}`)}`);
  }
  const started = Date.now();
  const results: { result: PropertyResult; record?: string }[] = [];
  for (const r of await runProperties(ctx, targets, base, runs, seeds)) {
    const t = r.target;
    let id: string | undefined;
    if (r.status === "failed" || r.status === "aborted") {
      const rec = makeRecord({
        kind: r.status === "failed" ? "property" : "abort",
        target: t, input: r.input, original: r.original,
        iteration: r.iteration, base, runs, backend, feVersion: version,
        ...(opts.uniform ? { sampling: "uniform" } : {}),
        ...(r.status === "aborted" ? { detail: r.abort } : {}),
        ...(r.seededBy ? { seededBy: r.seededBy } : {}),
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
  const sampling = opts.uniform ? "uniform" : "biased";
  const coverage = campaignCoverage(targets, skipped, results.map(({ result: r }) => r.status === "infra" ? undefined : r.status === "passed" ? r.runs : r.iteration + 1n));
  writeJUnit(opts, `fuzzloom fuzz ${d.ingot}`, started, { command: "fuzz", seed: String(base), runs: String(runs), backend, sampling, fe_version: version },
    results.map(({ result: r, record }) => junitCase(`${d.ingot}.fuzz`, r.target, formatResult(r, record),
      r.status === "passed" ? "pass" : r.status === "infra" ? "error" : "failure",
      r.status === "failed" ? "counterexample" : r.status === "aborted" ? "abort" : r.status === "infra" ? r.reason : undefined)));
  if (opts.json) {
    console.log(JSON.stringify(toJson({ ingot: d.ingot, seed: base, runs, backend, sampling, fe_version: version, coverage, skipped, results }), null, 2));
  } else {
    console.log(`\n${passed} passed, ${failed} failed, ${infra} infrastructure errors in ${seconds(started)}  ${dim(`(repeat with --seed ${base}${opts.uniform ? " --uniform" : ""})`)}`);
    printCoverage("inputs", coverage);
  }
  return infra > 0 ? 2 : failed > 0 ? 1 : 0;
}

/**
 * Saved property and abort failures (open or fixed) whose target still
 * exists with the same signature, as mutation seeds. A fixed record is the
 * point: its neighbourhood is where an incomplete fix still fails.
 */
function seedsFrom(root: string, d: Discovery, targets: Target[]): Map<string, Seed[]> {
  const out = new Map<string, Seed[]>();
  const records = listRecords(root)
    .filter((r) => r.kind === "property" || r.kind === "abort")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const t of targets) {
    const same = records.filter((r) => r.target === t.name && r.args.length === t.args.length && r.args.every((a, i) => a.type === t.args[i]!.type));
    if (same.length) out.set(t.name, same.slice(0, SEEDS_PER_TARGET).map((r) => ({ record: r.id, input: recordWords(r) })));
  }
  return out;
}

/** One JUnit case from a result's terminal lines; the message is the headline without the status word. */
function junitCase(classname: string, t: Target, lines: string[], outcome: JUnitOutcome, type?: string): JUnitCase {
  const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
  const body = lines.map(strip).join("\n");
  const name = `${t.name}(${t.args.map((a) => a.type).join(", ")})`;
  const headline = strip(lines[0] ?? "").replace(/^\S+\s+/, "").trim();
  const message = headline.startsWith(name) ? headline.slice(name.length).trim() : headline;
  return { name, classname, outcome, message, ...(type ? { type } : {}), body };
}

function writeJUnit(opts: Opts, name: string, started: number, properties: Record<string, string>, cases: JUnitCase[]): void {
  if (!opts.junit) return;
  writeFileSync(resolve(opts.junit), junitXml({ name, timestamp: new Date(started), seconds: (Date.now() - started) / 1000, properties, cases }));
  if (!opts.json) console.log(dim(`JUnit report written to ${opts.junit}`));
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)} s`;
}

function baseSeed(opts: Opts): bigint {
  return opts.seed !== undefined ? BigInt(opts.seed) : BigInt("0x" + randomBytes(8).toString("hex"));
}

function progress(opts: Opts): Context["onRun"] {
  return opts.json ? undefined : (what, ms) => process.stderr.write(dim(`  .. ${what} (${ms} ms)\n`));
}

function digestKey(requested: string | undefined): bigint {
  const prime = (1n << 127n) - 1n;
  if (requested !== undefined) {
    const key = BigInt(requested);
    if (key <= 0n || key >= prime) throw new Error("--digest-key must be between 1 and 2^127 - 2");
    return key;
  }
  // Mask to 127 bits and reject the two endpoints for a uniform nonzero field key.
  let key: bigint;
  do {
    key = BigInt("0x" + randomBytes(16).toString("hex")) & prime;
  } while (key === 0n || key === prime);
  return key;
}

async function diff(root: string, opts: RunOpts): Promise<number> {
  const d = discover(root);
  const selection = selectedCampaign(d, "differential", "diff", opts);
  if (!selection) return 2;
  const { targets, skipped } = selection;
  const base = baseSeed(opts);
  const key = digestKey(opts["digest-key"]);
  const runs = BigInt(opts.runs ?? "100000");
  const fe = defaultFeConfig();
  const version = feVersion(fe);
  const ctx: Context = { userRoot: root, ingot: d.ingot, backend: "sonatina", fe, onRun: progress(opts), scratchDir: opts.scratchDir };
  if (!opts.json) console.log(`${bold("fuzzloom diff")} ${d.ingot}  ${dim(`seed ${base}, digest key ${key}, ${runs} inputs per target, sonatina vs native, ${version}`)}`);
  const started = Date.now();
  const results: { result: DiffResult; record?: string }[] = [];
  for (const r of await runDiffs(ctx, targets, base, runs, key)) {
    const t = r.target;
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
  const coverage = campaignCoverage(targets, skipped, results.map(({ result: r }) => r.status === "infra" ? undefined : runs));
  writeJUnit(opts, `fuzzloom diff ${d.ingot}`, started, { command: "diff", seed: String(base), digest_key: String(key), runs: String(runs), backends: "sonatina,native", fe_version: version },
    results.map(({ result: r, record }) => junitCase(`${d.ingot}.diff`, r.target, formatDiff(r, record),
      r.status === "agreed" ? "pass" : r.status === "infra" ? "error" : "failure",
      r.status === "diverged" ? "divergence" : r.status === "infra" ? r.reason : undefined)));
  if (opts.json) console.log(JSON.stringify(toJson({ ingot: d.ingot, seed: base, digest_key: key, runs, fe_version: version, coverage, skipped, results }), null, 2));
  else {
    console.log(`\n${results.length - diverged - infra} agreed, ${diverged} diverged, ${infra} infrastructure errors in ${seconds(started)}  ${dim(`(repeat with --seed ${base} --digest-key ${key})`)}`);
    printCoverage("input pairs", coverage);
  }
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
        `${red("DIVERGE")} ${sig}  ${dim(`first at input ${r.iteration + 1n}, found in ${r.rounds} search rounds, ${r.feRuns} fe runs in total`)}`,
        ...values(t, r.input).map((l) => `      ${bold(l)}`),
        `      sonatina returns ${bold(String(wordToValue(r.outputs.sonatina, t.returns!)))}`,
        `      native   returns ${bold(String(wordToValue(r.outputs.native, t.returns!)))}`,
        ...(id ? [dim(`      reproduce: fuzzloom reproduce ${id}`)] : []),
      ];
    case "infra":
      return [`${yellow("INFRA")} ${sig}  ${r.reason} on ${r.backend}`, ...r.detail.split("\n").slice(0, 4).map((l) => dim(`      ${l}`))];
  }
}

function traceLines(target: Target, steps: readonly Words[]): string[] {
  return steps.map((step, i) => `step ${i + 1}: ${values(target, step).join(", ")}`);
}

async function sequence(root: string, opts: RunOpts): Promise<number> {
  const d = discover(root);
  const selection = selectedCampaign(d, "sequence", "sequence", opts);
  if (!selection) return 2;
  const { targets, skipped } = selection;
  const base = baseSeed(opts);
  const runs = BigInt(opts.runs ?? "1000");
  const maxSteps = Number(opts.steps ?? MAX_SEQUENCE_STEPS);
  const backend = opts.backend as Backend;
  const fe = defaultFeConfig();
  const version = feVersion(fe);
  const ctx: Context = { userRoot: root, ingot: d.ingot, backend, fe, onRun: progress(opts), scratchDir: opts.scratchDir };
  if (!opts.json) console.log(`fuzzloom sequence ${d.ingot}, seed ${base}, ${runs} traces per target, at most ${maxSteps} steps`);
  const started = Date.now();
  const outcomes = await runCases(ctx, targets.map((target) => ({ target, call: { mode: "check_sequence", base, runs, maxSteps } })), "sequence");
  const results = outcomes.map((outcome, i) => {
    const target = targets[i]!;
    if (outcome.kind === "sequence-passed") {
      return { status: "passed", target, outcome, count: runs, lines: [`PASS ${target.name}, ${runs} traces`] } as const;
    }
    if (outcome.kind === "sequence-failed") {
      const record = makeRecord({ kind: "sequence", target, input: outcome.steps[0]!, steps: outcome.steps,
        iteration: outcome.iteration, base, runs, backend, feVersion: version });
      saveRecord(root, record);
      return { status: "failed", target, outcome, count: outcome.iteration + 1n, record: record.id, lines: [
        `FAIL ${target.name}, trace ${outcome.iteration + 1n}: ${outcome.originalSteps} to ${outcome.steps.length} steps${outcome.shrinkComplete ? "" : " (shrink budget reached)"}`,
        ...traceLines(target, outcome.steps), `reproduce: fuzzloom reproduce ${record.id}`,
      ] } as const;
    }
    const reason = outcome.kind === "infra" ? `${outcome.reason}: ${outcome.detail}` : describeAbort(outcome);
    return { status: "infra", target, outcome, count: undefined, lines: [`INFRA ${target.name}, ${reason}`] } as const;
  });
  const coverage = campaignCoverage(targets, skipped, results.map((r) => r.count));
  writeJUnit(opts, `fuzzloom sequence ${d.ingot}`, started, { command: "sequence", seed: String(base), runs: String(runs), backend },
    results.map((r) => ({ name: r.target.name, classname: `${d.ingot}.sequence`, body: r.lines.join("\n"),
      outcome: r.status === "passed" ? "pass" : r.status === "failed" ? "failure" : "error" })));
  if (opts.json) console.log(JSON.stringify(toJson({ ingot: d.ingot, seed: base, runs, maxSteps, backend, coverage, skipped, results }), null, 2));
  else {
    for (const r of results) for (const line of r.lines) console.log(line);
    printCoverage("traces", coverage);
  }
  return results.some((r) => r.status === "infra") ? 2 : results.some((r) => r.status === "failed") ? 1 : 0;
}

type Verdict = { reproduces: boolean | undefined; text: string };

/**
 * Replays saved records in at most one round per backend, run concurrently.
 * `reproduces` is undefined on an infrastructure outcome.
 */
async function verdicts(ctx: Context, d: Discovery, records: FailureRecord[]): Promise<Verdict[]> {
  const out: Verdict[] = [];
  const cases: Record<Backend, Case[]> = { sonatina: [], native: [] };
  const slot: { s?: number; n?: number; t?: Target }[] = [];
  for (const [i, rec] of records.entries()) {
    slot.push({});
    const t: Target | undefined = d.targets.find((x) => x.name === rec.target);
    if (!t) {
      out[i] = { reproduces: undefined, text: `${rec.target} no longer exists in ${d.ingot}` };
      continue;
    }
    if (t.args.length !== rec.args.length || t.args.some((a, j) => a.type !== rec.args[j]!.type)) {
      out[i] = { reproduces: undefined, text: `${rec.target} changed signature since the failure was recorded` };
      continue;
    }
    const expectedKind = rec.kind === "sequence" ? "sequence" : rec.kind === "differential" ? "differential" : "property";
    if (t.kind !== expectedKind) {
      out[i] = { reproduces: undefined, text: `${rec.target} changed target kind since the failure was recorded` };
      continue;
    }
    const input = recordWords(rec);
    slot[i]!.t = t;
    if (rec.kind === "differential") {
      slot[i]!.s = cases.sonatina.push({ target: t, call: { mode: "evaluate", input } }) - 1;
      slot[i]!.n = cases.native.push({ target: t, call: { mode: "evaluate", input } }) - 1;
    } else {
      const call: Case["call"] = rec.kind === "sequence" ? { mode: "replay_sequence", steps: recordSequence(rec) } : { mode: "replay", input };
      const native = rec.backend === "native";
      slot[i]![native ? "n" : "s"] = cases[native ? "native" : "sonatina"].push({ target: t, call }) - 1;
    }
  }
  const round = (b: Backend) => (cases[b].length ? runCases(ctx, cases[b], "replay", b) : Promise.resolve([]));
  const [so, no] = await Promise.all([round("sonatina"), round("native")]);
  const infraText = (o: Outcome) => (o.kind === "infra" ? `${o.reason}: ${o.detail.split("\n")[0]}` : `unexpected ${o.kind}`);
  for (const [i, rec] of records.entries()) {
    const { s: si, n: ni, t } = slot[i]!;
    if (!t) continue;
    if (rec.kind === "differential") {
      const s = so[si!]!, n = no[ni!]!;
      if (s.kind !== "evaluated") { out[i] = { reproduces: undefined, text: infraText(s) }; continue; }
      if (n.kind !== "evaluated") { out[i] = { reproduces: undefined, text: infraText(n) }; continue; }
      const sv = wordToValue(s.output, t.returns!), nv = wordToValue(n.output, t.returns!);
      out[i] = s.output !== n.output
        ? { reproduces: true, text: `still diverges: sonatina ${sv}, native ${nv}` }
        : { reproduces: false, text: `backends now agree (${sv})` };
      continue;
    }
    const o = si !== undefined ? so[si]! : no[ni!]!;
    if (rec.kind === "sequence") {
      out[i] = o.kind === "sequence-replayed"
        ? o.failedStep === 0n ? { reproduces: false, text: "all sequence steps now pass" }
          : { reproduces: true, text: `invariant fails at step ${o.failedStep}` }
        : { reproduces: undefined, text: infraText(o) };
      continue;
    }
    if (o.kind === "replayed") {
      out[i] = o.failed ? { reproduces: true, text: "still fails" } : { reproduces: false, text: "now passes" };
    } else if (o.kind === "panic" || o.kind === "revert") {
      const same = rec.kind === "abort" && rec.detail === describeAbort(o);
      out[i] = { reproduces: true, text: same ? `still aborts: ${describeAbort(o)}` : `aborts differently: ${describeAbort(o)}` };
    } else {
      out[i] = { reproduces: undefined, text: infraText(o) };
    }
  }
  return out;
}

function applyVerdict(root: string, rec: FailureRecord, v: Verdict): string {
  if (v.reproduces === undefined) return yellow("INFRA");
  const was = rec.status;
  saveRecord(root, { ...rec, status: v.reproduces ? "open" : "fixed", updated_at: new Date().toISOString() });
  if (v.reproduces && was === "fixed") return red("REGRESSED");
  return v.reproduces ? red("FAILS") : green("FIXED");
}

async function reproduce(root: string, id: string, opts: RunOpts): Promise<number> {
  const d = discover(root);
  const rec = loadRecord(root, id);
  const ctx: Context = { userRoot: root, ingot: d.ingot, backend: "sonatina", fe: defaultFeConfig(), onRun: progress(opts), scratchDir: opts.scratchDir };
  const target = d.targets.find((x) => x.name === rec.target);
  const [v] = await verdicts(ctx, d, [rec]);
  const label = applyVerdict(root, rec, v!);
  if (opts.json) {
    console.log(JSON.stringify(toJson({ id, reproduces: v!.reproduces, text: v!.text, record: rec }), null, 2));
  } else {
    console.log(`${label}  ${rec.id}  ${v!.text}`);
    if (target) {
      const lines = rec.kind === "sequence" ? traceLines(target, recordSequence(rec)) : values(target, recordWords(rec));
      for (const l of lines) console.log(`      ${l}`);
    }
  }
  return v!.reproduces === undefined ? 2 : v!.reproduces ? 1 : 0;
}

async function replayAll(root: string, opts: RunOpts): Promise<number> {
  const d = discover(root);
  const records = listRecords(root).filter((r) => !opts.only || r.target.includes(opts.only));
  if (opts.only !== undefined && records.length === 0) throw new Error(`no saved failures matching "${opts.only}"`);
  const ctx: Context = { userRoot: root, ingot: d.ingot, backend: "sonatina", fe: defaultFeConfig(), onRun: progress(opts), scratchDir: opts.scratchDir };
  if (!opts.json) console.log(`${bold("fuzzloom replay")} ${d.ingot}  ${dim(`${records.length} saved failures`)}`);
  let failing = 0;
  let infra = 0;
  const out: unknown[] = [];
  const started = Date.now();
  const vs = await verdicts(ctx, d, records);
  for (const [i, rec] of records.entries()) {
    const v = vs[i]!;
    const label = applyVerdict(root, rec, v);
    if (v.reproduces === undefined) infra++;
    else if (v.reproduces) failing++;
    out.push({ id: rec.id, reproduces: v.reproduces, text: v.text });
    if (!opts.json) console.log(`${label}  ${rec.id}  ${dim(v.text)}`);
  }
  writeJUnit(opts, `fuzzloom replay ${d.ingot}`, started, { command: "replay", records: String(records.length) },
    records.map((rec, i): JUnitCase => {
      const v = vs[i]!;
      const outcome: JUnitOutcome = v.reproduces === undefined ? "error" : v.reproduces ? "failure" : "pass";
      const target = d.targets.find((t) => t.name === rec.target);
      const steps = rec.kind === "sequence" && target
        ? traceLines(target, recordSequence(rec))
        : rec.args.map((a, j) => `${a.name} = ${rec.values[j]}`);
      const body = [`${rec.id}: ${v.text}`, ...steps, `reproduce: fuzzloom reproduce ${rec.id}`].join("\n");
      return { name: rec.id, classname: `${d.ingot}.replay`, outcome, message: v.text, type: outcome === "failure" ? `${rec.kind}-still-failing` : outcome === "error" ? "infrastructure" : undefined, body };
    }));
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else console.log(`\n${records.length - failing - infra} fixed, ${failing} still failing, ${infra} infrastructure errors`);
  return infra > 0 ? 2 : failing > 0 ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`fuzzloom: ${(e as Error).message}`);
  process.exitCode = 2;
}
