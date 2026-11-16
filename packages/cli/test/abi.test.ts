import { test } from "node:test";
import assert from "node:assert/strict";
import { selector } from "../src/keccak.ts";
import { decodePayload, describe, valueToWord, wordToValue } from "../src/abi.ts";

test("selectors agree with ones the Fe compiler actually emitted", () => {
  // Recorded from fe test output during the spikes (spike/evm3.txt, probe2,
  // spike/pipeline): Fe computes custom-error selectors exactly like Solidity.
  assert.equal(selector("Counterexample(uint64,uint64,uint64,uint64)"), "0xf8e73c77");
  assert.equal(selector("Digest(uint64,uint256,uint64)"), "0xf028dfbb");
  assert.equal(selector("Counterexample(uint64,uint64)"), "0x203dec3a");
});

const word = (n: bigint) => n.toString(16).padStart(64, "0");

test("decodes a Counterexample payload", () => {
  const sel = selector("Counterexample(uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint64,bool)");
  const hex = sel + [7n, 41n, 2n, 100n, 101n, 0n, 0n, 1n, 0n, 909n, 1n].map(word).join("");
  const o = decodePayload(hex);
  assert.equal(o.kind, "counterexample");
  if (o.kind !== "counterexample") return;
  assert.equal(o.iteration, 41n);
  assert.equal(o.arity, 2);
  assert.deepEqual(o.shrunk, [0n, 1n, 0n]);
  assert.equal(o.shrinkComplete, true);
});

test("decodes real Panic and Error(string) payloads", () => {
  // From fe test output: division by zero, and assert!(..., "property failed").
  const p = decodePayload("0x4e487b710000000000000000000000000000000000000000000000000000000000000012");
  assert.deepEqual(p, { kind: "panic", code: 18n, reason: "division or modulo by zero" });
  const e = decodePayload("0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f70726f7065727479206661696c65640000000000000000000000000000000000");
  assert.deepEqual(e, { kind: "revert", message: "property failed" });
});

test("unknown selectors are infra, not results", () => {
  assert.equal(decodePayload("0xdeadbeef" + word(1n)).kind, "infra");
});

test("zigzag matches the Fe Word encoding", () => {
  // From ingots/fuzzloom/src/word.fe tests: 0, -1, 1, -2, 2 -> 0, 1, 2, 3, 4.
  assert.deepEqual([0n, 1n, 2n, 3n, 4n].map((w) => wordToValue(w, "i64")), [0n, -1n, 1n, -2n, 2n]);
  assert.equal(wordToValue(255n, "i8"), -128n);
  assert.equal(wordToValue(254n, "i8"), 127n);
  for (const v of [-128n, -1n, 0n, 1n, 127n]) assert.equal(wordToValue(valueToWord(v, "i8"), "i8"), v);
  assert.throws(() => valueToWord(128n, "i8"));
  assert.throws(() => valueToWord(256n, "u8"));
});

test("describe names type boundaries", () => {
  assert.equal(describe(18446744073709551615n, "u64"), "18446744073709551615 (u64::MAX)");
  assert.equal(describe(255n, "i8"), "-128 (i8::MIN)");
  assert.equal(describe(1n, "bool"), "true");
  assert.equal(describe(42n, "u32"), "42");
});
