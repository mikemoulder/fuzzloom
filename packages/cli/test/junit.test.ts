import { test } from "node:test";
import assert from "node:assert/strict";
import { junitXml, xmlEscape, type JUnitCase } from "../src/junit.ts";

const cases: JUnitCase[] = [
  { name: "prop_ok(u64)", classname: "vm.fuzz", outcome: "pass", body: "10000 inputs" },
  { name: "prop_bad(u64, u64)", classname: "vm.fuzz", outcome: "failure", type: "counterexample", message: "counterexample at input 3", body: "a = 0\nb = 1 <b & \"c\">" },
  { name: "prop_gas(u64)", classname: "vm.fuzz", outcome: "error", type: "out-of-gas", message: "out-of-gas", body: "OutOfGas(Basic)" },
];

const xml = junitXml({ name: "fuzzloom fuzz vm", timestamp: new Date("2026-11-17T10:00:00.123Z"), seconds: 12.5, properties: { seed: "7" }, cases });

test("counts failures and infrastructure errors separately", () => {
  assert.match(xml, /<testsuite name="fuzzloom fuzz vm" tests="3" failures="1" errors="1" skipped="0" time="12.500" timestamp="2026-11-17T10:00:00">/);
  assert.match(xml, /<failure message="counterexample at input 3" type="counterexample">/);
  assert.match(xml, /<error message="out-of-gas" type="out-of-gas">OutOfGas\(Basic\)<\/error>/);
  assert.match(xml, /<property name="seed" value="7"\/>/);
});

test("escapes markup, drops colours and characters XML cannot carry", () => {
  assert.equal(xmlEscape(`a<b>&"'`), "a&lt;b&gt;&amp;&quot;&apos;");
  assert.equal(xmlEscape("\x1b[31mFAIL\x1b[0m\x00\x07 ok\ttab"), "FAIL ok\ttab");
  assert.match(xml, /b = 1 &lt;b &amp; &quot;c&quot;&gt;/);
});

test("every element is closed: the document is well formed", () => {
  // A minimal tag-balance check (no XML parser in the standard library).
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([a-z-]+)[^>]*?(\/?)>/g)) {
    if (m[3] === "/") continue;
    if (m[1] === "/") assert.equal(stack.pop(), m[2]);
    else stack.push(m[2]!);
  }
  assert.deepEqual(stack, []);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
});
