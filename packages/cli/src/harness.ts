// Harness codegen. A harness is an ingot that depends on the Fuzzloom
// library and the user's ingot, with one #[test] per case; every case ends
// by reverting with one payload. Batching cases matters: each fe run pays a
// fixed compile cost (about 2.4 s measured on vault-math) and each extra case
// only about 85 ms, so the engine puts every independent evaluation of a
// round into one harness. Dependency paths are relative: fe 26.6.0 rejects
// absolute ones.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Target, Words } from "./types.ts";

/** The Fuzzloom library ingot shipped with this CLI. */
export function libraryIngot(): string {
  return process.env.FUZZLOOM_INGOT ?? resolve(import.meta.dirname, "../../../ingots/fuzzloom");
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

export type HarnessCall =
  | { mode: "check"; base: bigint; runs: bigint }
  | { mode: "replay"; input: Words }
  | { mode: "input_at"; base: bigint; iteration: bigint }
  | { mode: "digest"; base: bigint; runs: bigint }
  /** Prefix digests after first, first + step, ... (count of them) runs, from one pass. */
  | { mode: "checkpoints"; base: bigint; first: bigint; step: bigint; count: number }
  | { mode: "target_input_at"; base: bigint; iteration: bigint }
  | { mode: "evaluate"; input: Words }
  /** replay on the input the campaign draws at `iteration`, in one case. */
  | { mode: "replay_at"; base: bigint; iteration: bigint }
  /** evaluate on the input the digest draws at `iteration`, in one case. */
  | { mode: "evaluate_at"; base: bigint; iteration: bigint };

export type Case = { target: Target; call: HarnessCall };

const hex = (n: bigint) => "0x" + n.toString(16);

function seedExpr(t: Target, base: bigint): string {
  return `derive_seed(${base}, ${hex(fnv1a64(t.name))})`;
}

function inputExpr(t: Target, w: Words): string {
  const n = t.args.length;
  const ws = w.slice(0, n).map(hex).join(", ");
  return n === 1 ? `Input::one(${ws})` : n === 2 ? `Input::two(${ws})` : `Input::three(${ws})`;
}

/** The body of the harness test for `call` on `t`. */
export function harnessBody(t: Target, call: HarnessCall): string {
  const n = t.args.length;
  const wrapped = t.kind === "property" ? `prop${n}(${t.name})` : `target${n}(${t.name})`;
  switch (call.mode) {
    case "check": return `check(${wrapped}, seed: ${seedExpr(t, call.base)}, runs: ${call.runs})`;
    case "replay": return `replay(${wrapped}, input: ${inputExpr(t, call.input)})`;
    case "input_at": {
      const p = `prop${n}(${t.name})`;
      return `input_at(${p}, bounds: bounds_of(${p}), seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`;
    }
    case "digest": return `digest(${wrapped}, seed: ${seedExpr(t, call.base)}, runs: ${call.runs})`;
    case "checkpoints": return `digest_checkpoints(${wrapped}, seed: ${seedExpr(t, call.base)}, first: ${call.first}, step: ${call.step}, count: ${call.count})`;
    case "target_input_at": return `target_input_at(${wrapped}, seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`;
    case "evaluate": return `evaluate(${wrapped}, input: ${inputExpr(t, call.input)})`;
    case "replay_at": {
      const p = `prop${n}(${t.name})`;
      const gen = `generated_at(bounds_of(${p}), arity: arity_of(${p}), seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`;
      return `replay(${p}, input: ${gen})`;
    }
    case "evaluate_at": {
      const gen = `target_generated_at(${wrapped}, seed: ${seedExpr(t, call.base)}, iteration: ${call.iteration})`;
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
  const imports = [...new Set(cases.map((c) => c.target.name))].sort().map((n) => `use ${ingot}::${n}`);
  const tests = cases.flatMap((c, i) => ["#[test]", `fn ${caseName(i)}() {`, `    ${harnessBody(c.target, c.call)}`, "}", ""]);
  writeFileSync(join(dir, "src", "lib.fe"), ["// Generated by the Fuzzloom CLI. Do not edit.", "use fuzzloom::*", ...imports, "", ...tests].join("\n"));
  return dir;
}

/** A one-case harness, named after its target and mode. */
export function writeHarness(opts: { userRoot: string; ingot: string; target: Target; call: HarnessCall; workDir: string }): string {
  const { target, call, ...rest } = opts;
  return writeBatch({ ...rest, cases: [{ target, call }], name: `${target.name}-${call.mode}` });
}
