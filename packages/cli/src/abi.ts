// Decoding of Fuzzloom payloads (ABI-encoded custom errors) and of Fe input
// words into typed values. The error signatures mirror
// ingots/fuzzloom/src/payload.fe field for field; selectors are computed
// from them with keccak-256, never hardcoded.

import { selector } from "./keccak.ts";
import type { FeType, Outcome, Words } from "./types.ts";

export const SIGNATURES = {
  counterexample: "Counterexample(uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint64,bool)",
  passed: "Passed(uint64,uint64,uint64,uint64,uint64,uint64)",
  replayed: "Replayed(uint64,uint256,uint256,uint256,bool)",
  generated: "Generated(uint64,uint64,uint64,uint256,uint256,uint256)",
  digest: "Digest(uint64,uint64,uint64,uint256)",
  evaluated: "Evaluated(uint64,uint256,uint256,uint256,uint256)",
  panic: "Panic(uint256)",
  error: "Error(string)",
} as const;

export const SELECTORS = Object.fromEntries(
  Object.entries(SIGNATURES).map(([k, v]) => [k, selector(v)]),
) as Record<keyof typeof SIGNATURES, string>;

/** Solidity panic codes, as Fe uses them (core::panics). */
export const PANIC_REASONS: Record<string, string> = {
  "0": "generic panic",
  "1": "assertion failed",
  "17": "arithmetic overflow or underflow",
  "18": "division or modulo by zero",
  "33": "invalid enum conversion",
  "34": "invalid storage encoding",
  "49": "pop on empty array",
  "50": "index out of bounds",
  "65": "out of memory",
  "81": "call to zero-initialised function pointer",
};

function words(hex: string): bigint[] {
  const body = hex.slice(10);
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(BigInt("0x" + body.slice(i, i + 64)));
  return out;
}

function need(w: bigint[], n: number, what: string): void {
  if (w.length < n) throw new Error(`${what} payload has ${w.length} words, expected ${n}`);
}

const num = (b: bigint | undefined): number => Number(b ?? 0n);
const triple = (w: bigint[], at: number): Words => [w[at] ?? 0n, w[at + 1] ?? 0n, w[at + 2] ?? 0n];

/** Decodes the revert data of one harness test. */
export function decodePayload(hex: string): Outcome {
  const sel = hex.slice(0, 10).toLowerCase();
  const w = words(hex.toLowerCase());
  switch (sel) {
    case SELECTORS.counterexample:
      need(w, 11, "Counterexample");
      return {
        kind: "counterexample", seed: w[0]!, iteration: w[1]!, arity: num(w[2]),
        original: triple(w, 3), shrunk: triple(w, 6), shrinkAttempts: w[9]!, shrinkComplete: w[10] === 1n,
      };
    case SELECTORS.passed:
      need(w, 6, "Passed");
      return { kind: "passed", seed: w[0]!, runs: w[1]!, arity: num(w[2]), edgeArgs: w[3]!, correlated: w[4]!, extremes: w[5]! };
    case SELECTORS.replayed:
      need(w, 5, "Replayed");
      return { kind: "replayed", arity: num(w[0]), input: triple(w, 1), failed: w[4] === 1n };
    case SELECTORS.generated:
      need(w, 6, "Generated");
      return { kind: "generated", seed: w[0]!, iteration: w[1]!, arity: num(w[2]), input: triple(w, 3) };
    case SELECTORS.digest:
      need(w, 4, "Digest");
      return { kind: "digest", seed: w[0]!, runs: w[1]!, arity: num(w[2]), acc: w[3]! };
    case SELECTORS.evaluated:
      need(w, 5, "Evaluated");
      return { kind: "evaluated", arity: num(w[0]), input: triple(w, 1), output: w[4]! };
    case SELECTORS.panic: {
      const code = w[0] ?? 0n;
      return { kind: "panic", code, reason: PANIC_REASONS[code.toString()] ?? "unknown panic code" };
    }
    case SELECTORS.error: {
      const body = hex.slice(10);
      const len = Number(BigInt("0x" + body.slice(64, 128)));
      const msg = Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
      return { kind: "revert", message: msg };
    }
    default:
      return { kind: "infra", reason: "unparsed", detail: `unknown revert selector ${sel}` };
  }
}

const BITS: Record<FeType, number> = {
  u8: 8, u16: 16, u32: 32, u64: 64, u128: 128, u256: 256,
  i8: 8, i16: 16, i32: 32, i64: 64, i128: 128, i256: 256, bool: 1,
};

/** Interprets an input word as a value of `type` (zigzag for signed types). */
export function wordToValue(w: bigint, type: FeType): bigint | boolean {
  if (type === "bool") return w !== 0n;
  if (type.startsWith("u")) return w;
  return (w & 1n) === 0n ? w >> 1n : -((w >> 1n) + 1n);
}

/** Encodes a typed value as an input word (inverse of `wordToValue`). */
export function valueToWord(v: bigint | boolean, type: FeType): bigint {
  if (type === "bool") return v ? 1n : 0n;
  const x = BigInt(v);
  if (type.startsWith("u")) {
    if (x < 0n || x >= 1n << BigInt(BITS[type])) throw new Error(`${x} does not fit ${type}`);
    return x;
  }
  const half = 1n << BigInt(BITS[type] - 1);
  if (x < -half || x >= half) throw new Error(`${x} does not fit ${type}`);
  return x >= 0n ? x << 1n : ((-x - 1n) << 1n) | 1n;
}

/** Human-readable value, with the type's boundary named when it is one. */
export function describe(w: bigint, type: FeType): string {
  const v = wordToValue(w, type);
  if (typeof v === "boolean") return String(v);
  const bits = BigInt(BITS[type]);
  const notes: string[] = [];
  if (type.startsWith("u")) {
    const max = (1n << bits) - 1n;
    if (v === max) notes.push(`${type}::MAX`);
    else if (max - v < 256n && v > 255n) notes.push(`${type}::MAX - ${max - v}`);
  } else {
    const max = (1n << (bits - 1n)) - 1n;
    if (v === max) notes.push(`${type}::MAX`);
    if (v === -max - 1n) notes.push(`${type}::MIN`);
  }
  return notes.length ? `${v} (${notes.join(", ")})` : `${v}`;
}
