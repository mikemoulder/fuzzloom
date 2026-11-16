import { test } from "node:test";
import assert from "node:assert/strict";
import { keccakHex, selector } from "../src/keccak.ts";

test("keccak-256 matches published vectors", () => {
  assert.equal(keccakHex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccakHex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});

test("keccak-256 handles inputs longer than one block", () => {
  // 200 bytes crosses the 136-byte rate boundary.
  const long = "a".repeat(200);
  assert.equal(keccakHex(long).length, 66);
  assert.notEqual(keccakHex(long), keccakHex("a".repeat(199)));
});

test("Solidity's built-in error selectors", () => {
  assert.equal(selector("Panic(uint256)"), "0x4e487b71");
  assert.equal(selector("Error(string)"), "0x08c379a0");
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
});
