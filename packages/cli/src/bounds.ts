// Per-argument input ranges, declared in a doc comment above a property or
// differential target:
//
//   /// fuzzloom: start in 1668464000..=1700000000
//   /// fuzzloom: delta in -1000..=1000
//   pub fn prop_x(_ total: u128, start: u64, delta: i64) -> bool { ... }
//
// Ranges are written in the argument's own type and become a word-level
// Bounds restriction in Fe: campaigns, input recovery and mutation draw
// within it, and shrinking stops at its lower end. `..=` is inclusive, `..`
// excludes the upper end.
//
// Signed arguments are zigzag-encoded words (0, -1, 1, -2, 2, ...), so a
// signed range is one contiguous word range only when it is centred on zero:
// -k..=k or -(k+1)..=k. Other signed ranges are rejected with that reason,
// never approximated.

import { valueToWord } from "./abi.ts";
import type { FeType } from "./types.ts";

/** A word range for argument `arg` (0-based). */
export type ArgBound = { arg: number; lo: bigint; hi: bigint };

const ANNOTATION = /fuzzloom:\s*(\w+)\s+in\s+(-?[0-9a-fA-Fx_]+)\s*(\.\.=?)\s*(-?[0-9a-fA-Fx_]+)\s*$/;
const NUMBER = /^-?(0x[0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|[0-9]+(?:_[0-9]+)*)$/;

function parseNumber(s: string): bigint | undefined {
  if (!NUMBER.test(s)) return undefined;
  const neg = s.startsWith("-");
  const v = BigInt(s.replace(/^-/, "").replaceAll("_", ""));
  return neg ? -v : v;
}

/**
 * Reads the `fuzzloom:` lines of a doc comment. Every line that mentions
 * `fuzzloom:` must parse and validate; otherwise the result is an error
 * message, so a typo never silently widens the input range.
 */
export function parseBounds(doc: string[], args: { name: string; type: FeType }[]): ArgBound[] | string {
  const out: ArgBound[] = [];
  for (const raw of doc) {
    if (!raw.includes("fuzzloom:")) continue;
    const line = raw.replace(/^\s*\/\/\/?\s?/, "").trim();
    const m = line.match(ANNOTATION);
    if (!m) return `cannot read the annotation "${line}"; expected "fuzzloom: <argument> in <lo>..=<hi>"`;
    const [, name = "", loText = "", op = "", hiText = ""] = m;
    const arg = args.findIndex((a) => a.name === name);
    if (arg < 0) return `the annotation names "${name}", which is not an argument`;
    if (out.some((b) => b.arg === arg)) return `"${name}" has more than one range`;
    const type = args[arg]!.type;
    if (type === "bool") return `"${name}" is a bool; ranges apply to integer arguments`;
    const lo = parseNumber(loText);
    let hi = parseNumber(hiText);
    if (lo === undefined || hi === undefined) return `cannot read the range of "${name}" (${loText}${op}${hiText})`;
    if (op === "..") hi -= 1n;
    if (lo > hi) return `the range of "${name}" is empty`;
    let wlo: bigint, whi: bigint;
    try {
      wlo = valueToWord(lo, type);
      whi = valueToWord(hi, type);
    } catch {
      return `the range of "${name}" does not fit ${type}`;
    }
    if (type.startsWith("i")) {
      if (!(lo <= 0n && hi >= 0n && (hi === -lo || hi === -lo - 1n))) {
        return `signed ranges must be centred on zero (-k..=k or -(k+1)..=k), because signed words are zigzag-encoded; "${name}" has ${lo}..=${hi}`;
      }
      out.push({ arg, lo: 0n, hi: wlo > whi ? wlo : whi });
    } else {
      out.push({ arg, lo: wlo, hi: whi });
    }
  }
  return out.sort((a, b) => a.arg - b.arg);
}
