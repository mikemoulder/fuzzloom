#!/usr/bin/env node
// Fuzzloom CLI entry point.

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { discover } from "./discover.ts";
import { defaultFeConfig, feVersion } from "./fe.ts";
import { runProperty, type Context, type PropertyResult } from "./engine.ts";
import { makeRecord, saveRecord } from "./store.ts";
import { bold, dim, formatResult, toJson, yellow } from "./report.ts";
import type { Backend } from "./types.ts";

const USAGE = `fuzzloom <command> [path] [options]

Commands:
  list      [path]              show the prop_* and diff_* functions found
  fuzz      [path]              run every property campaign

Options:
  --seed <n>        base seed (default: random, printed so the run can be repeated)
  --runs <n>        inputs per property (default 10000)
  --backend <b>     sonatina (EVM, default) or native
  --only <name>     run only targets whose name contains this text
  --json            machine-readable output
  -h, --help

Exit codes: 0 all passed, 1 a property failed or aborted, 2 infrastructure error.`;

type Opts = { seed?: string; runs: string; backend: string; only?: string; json: boolean };

function main(argv: string[]): number {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      seed: { type: "string" },
      runs: { type: "string", default: "10000" },
      backend: { type: "string", default: "sonatina" },
      only: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, path = "."] = positionals;
  if (v.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const opts = v as Opts;
  if (opts.backend !== "sonatina" && opts.backend !== "native") throw new Error(`unknown backend ${opts.backend}`);
  const root = resolve(path);
  switch (command) {
    case "list": return list(root, opts);
    case "fuzz": return fuzz(root, opts);
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
  const base = opts.seed !== undefined ? BigInt(opts.seed) : BigInt("0x" + randomBytes(8).toString("hex"));
  const runs = BigInt(opts.runs);
  const backend = opts.backend as Backend;
  const fe = defaultFeConfig();
  const version = feVersion(fe);
  const targets = d.targets.filter((t) => t.kind === "property" && (!opts.only || t.name.includes(opts.only)));
  const ctx: Context = {
    userRoot: root, ingot: d.ingot, backend, fe,
    onRun: opts.json ? undefined : (what, ms) => process.stderr.write(dim(`  .. ${what} (${ms} ms)\n`)),
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

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`fuzzloom: ${(e as Error).message}`);
  process.exitCode = 2;
}
