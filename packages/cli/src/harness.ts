// Harness codegen. A harness is an ingot that depends on the Fuzzloom
// library and the user's ingot, with one #[test] per case; every case ends
// by reverting with one payload. Batching cases matters: each fe run pays a
// fixed compile cost (about 2.4 s measured on vault-math) and each extra case
// only about 85 ms, so the engine puts every independent evaluation of a
// round into one harness. Dependency paths are relative: fe 26.6.0 rejects
// absolute ones.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Target, Words } from "./types.ts";

/** The Fuzzloom library ingot shipped with this CLI. */
/**
 * Where the Fe library ingot lives: FUZZLOOM_INGOT if set, else the
 * repository checkout (ingots/fuzzloom, when running inside the repo, so a
 * stale bundled copy never shadows the live library), else the copy bundled
 * into an installed package (package/ingot, next to dist/).
 */
export function libraryIngot(): string {
  if (process.env.FUZZLOOM_INGOT) return resolve(process.env.FUZZLOOM_INGOT);
  const candidates = [
    resolve(import.meta.dirname, "../../../ingots/fuzzloom"),
    resolve(import.meta.dirname, "../ingot"),
  ];
  const found = candidates.find((c) => existsSync(join(c, "fe.toml")));
  if (!found) throw new Error(`Fuzzloom's Fe library was not found (looked in ${candidates.join(", ")}); set FUZZLOOM_INGOT`);
  return found;
}

/** 64-bit FNV-1a of a UTF-8 string: the property id fed to derive_seed. */
export function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/**
 * `corpus` on check, input_at and replay_at switches from the fresh campaign
 * to a mutation campaign around that saved input (check_mutating,
 * mutant_at, mutated_at), with its own seed.
 */
export type HarnessCall =
  | { mode: "check"; base: bigint; runs: bigint; corpus?: Words }
  | { mode: "replay"; input: Words }
  | { mode: "input_at"; base: bigint; iteration: bigint; corpus?: Words }
  | { mode: "digest"; base: bigint; runs: bigint }
  /** Prefix digests after first, first + step, ... (count of them) runs, from one pass. */
  | { mode: "checkpoints"; base: bigint; first: bigint; step: bigint; count: number; key?: bigint }
  | { mode: "target_input_at"; base: bigint; iteration: bigint }
  | { mode: "evaluate"; input: Words }
  /** replay on the input the campaign draws at `iteration`, in one case. */
  | { mode: "replay_at"; base: bigint; iteration: bigint; corpus?: Words }
  /** evaluate on the input the digest draws at `iteration`, in one case. */
  | { mode: "evaluate_at"; base: bigint; iteration: bigint };

export type Case = { target: Target; call: HarnessCall };

const hex = (n: bigint) => "0x" + n.toString(16);

/** The campaign seed: per property, and per saved input for mutation campaigns. */
function seedExpr(t: Target, base: bigint, corpus?: Words): string {
  const key = corpus ? `${t.name}@${corpus.slice(0, t.args.length).map(hex).join(",")}` : t.name;
  return `derive_seed(${base}, ${hex(fnv1a64(key))})`;
}

function inputExpr(t: Target, w: Words): string {
  const n = t.args.length;
  const ws = w.slice(0, n).map(hex).join(", ");
  return n === 1 ? `Input::one(${ws})` : n === 2 ? `Input::two(${ws})` : `Input::three(${ws})`;
}

/**
 * The Fuzzloom wrapper around `t`: prop1/2/3 or target1/2/3 of the function
 * itself, or, for a target with effects, of a closure that builds every
 * effect fresh from its fixture and provides it with `with`. A fresh value
 * per evaluation keeps evaluations independent, so replay and shrinking see
 * the same behaviour as the campaign (verified on both backends in
 * spike/effects). The closure is repeated rather than bound to a variable
 * because Fe closures are not Copy.
 */
export function callable(t: Target): string {
  const n = t.args.length;
  const head = t.kind === "property" ? `prop${n}` : `target${n}`;
  if (!t.effects?.length) return `${head}(${t.name})`;
  const params = t.args.map((a, i) => `a${i}: ${a.type}`).join(", ");
  const args = t.args.map((a, i) => (a.label === null ? `a${i}` : `${a.label ?? a.name}: a${i}`)).join(", ");
  const vars = t.effects.map((e, i) => `var e${i} = ${e.fixture}()`);
  const provide = t.effects.map((e, i) => `${e.type} = e${i}`).join(", ");
  return `${head}(|${params}| {
${vars.map((v) => `        ${v}
`).join("")}        with (${provide}) { ${t.name}(${args}) }
    })`;
}

/**
 * The Bounds expression for `t`: its full type ranges, restricted per
 * annotated argument. Every mode of a bounded target uses this same
 * expression, so the campaign, input recovery, mutation and digests all draw
 * from one domain.
 */
export function boundsExpr(t: Target): string {
  const w = callable(t);
  const full = t.kind === "property" ? `bounds_of(${w})` : `target_bounds_of(${w})`;
  return (t.bounds ?? []).reduce((e, b) => `${e}.restrict(${b.arg}, lo: ${hex(b.lo)}, hi: ${hex(b.hi)})`, full);
}

/** The body of the harness test for `call` on `t`. */
export function harnessBody(t: Target, call: HarnessCall): string {
  const wrapped = callable(t);
  const bounded = Boolean(t.bounds?.length);
  const B = boundsExpr(t);
  const n = t.args.length;
  switch (call.mode) {
    case "check": {
      if (call.corpus) {
        const tail = `corpus: ${inputExpr(t, call.corpus)}, seed: ${seedExpr(t, call.base, call.corpus)}, runs: ${call.runs}`;
        return bounded ? `check_mutating_within(${wrapped}, bounds: ${B}, ${tail})` : `check_mutating(${wrapped}, ${tail})`;
      }
      const tail = `seed: ${seedExpr(t, call.base)}, runs: ${call.runs}`;
      return bounded ? `check_bounded(${wrapped}, bounds: ${B}, ${tail})` : `check(${wrapped}, ${tail})`;
    }
    case "replay": return `replay(${wrapped}, input: ${inputExpr(t, call.input)})`;
    case "input_at": {
      if (call.corpus) {
        const tail = `corpus: ${inputExpr(t, call.corpus)}, seed: ${seedExpr(t, call.base, call.corpus)}, iteration: ${call.iteration}`;
        return bounded ? `mutant_at_within(${wrapped}, bounds: ${B}, ${tail})` : `mutant_at(${wrapped}, ${tail})`;
      }
      return `input_at(${wrapped}, bounds: ${B}, seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`;
    }
    case "digest":
      if (bounded) throw new Error("digest mode draws from the full type ranges; use checkpoints for a bounded target");
      return `digest(${wrapped}, seed: ${seedExpr(t, call.base)}, runs: ${call.runs})`;
    case "checkpoints": {
      const tail = `seed: ${seedExpr(t, call.base)}, first: ${call.first}, step: ${call.step}, count: ${call.count}`;
      if (call.key !== undefined) return `keyed_checkpoints_within(${wrapped}, bounds: ${B}, ${tail}, key: ${hex(call.key)})`;
      return bounded ? `digest_checkpoints_within(${wrapped}, bounds: ${B}, ${tail})` : `digest_checkpoints(${wrapped}, ${tail})`;
    }
    case "target_input_at": {
      const tail = `seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration}`;
      return bounded ? `target_input_at_within(${wrapped}, bounds: ${B}, ${tail})` : `target_input_at(${wrapped}, ${tail})`;
    }
    case "evaluate": return `evaluate(${wrapped}, input: ${inputExpr(t, call.input)})`;
    case "replay_at": {
      const gen = call.corpus
        ? `mutated_at(${B}, arity: arity_of(${wrapped}), corpus: ${inputExpr(t, call.corpus)}, seed: ${seedExpr(t, call.base, call.corpus)}, iteration: ${call.iteration})`
        : `generated_at(${B}, arity: arity_of(${wrapped}), seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`;
      return `replay(${wrapped}, input: ${gen})`;
    }
    case "evaluate_at": {
      const gen = bounded
        ? `generated_at(${B}, arity: ${n}, seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`
        : `target_generated_at(${wrapped}, seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`;
      return `evaluate(${wrapped}, input: ${gen})`;
    }
  }
}

/** The test function name of case `i`. */
export const caseName = (i: number) => `case_${i}`;

/**
 * Writes a harness ingot with one test per case (named by caseName) into
 * `workDir/<name>` and returns its directory.
 */
export function writeBatch(opts: { userRoot: string; ingot: string; cases: Case[]; workDir: string; name: string }): string {
  const { userRoot, ingot, cases, workDir, name } = opts;
  if (cases.length === 0) throw new Error("a harness needs at least one case");
  const dir = join(workDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  const rel = (p: string) => relative(dir, p).split("\\").join("/");
  writeFileSync(join(dir, "fe.toml"), [
    "[ingot]",
    `name = "fuzzloom_harness"`,
    `version = "0.1.0"`,
    "",
    "[dependencies]",
    `fuzzloom = { path = "${rel(libraryIngot())}" }`,
    `${ingot} = { path = "${rel(userRoot)}" }`,
    "",
  ].join("\n"));
  const paths = cases.flatMap((c) => c.target.imports ?? [`${ingot}::${c.target.name}`]);
  const imports = [...new Set(paths)].sort().map((p) => `use ${p}`);
  const tests = cases.flatMap((c, i) => ["#[test]", `fn ${caseName(i)}() {`, `    ${harnessBody(c.target, c.call)}`, "}", ""]);
  writeFileSync(join(dir, "src", "lib.fe"), ["// Generated by the Fuzzloom CLI. Do not edit.", "use fuzzloom::*", ...imports, "", ...tests].join("\n"));
  return dir;
}

/** A one-case harness, named after its target and mode. */
export function writeHarness(opts: { userRoot: string; ingot: string; target: Target; call: HarnessCall; workDir: string }): string {
  const { target, call, ...rest } = opts;
  return writeBatch({ ...rest, cases: [{ target, call }], name: `${target.name}-${call.mode}` });
}
