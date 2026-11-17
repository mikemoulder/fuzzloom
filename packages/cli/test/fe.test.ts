// parseFeOutput against fe test output recorded from real runs (fe 26.6.0).
import { test } from "node:test";
import { SELECTORS } from "../src/abi.ts";
import assert from "node:assert/strict";
import { parseBatchOutput, parseFeOutput } from "../src/fe.ts";

const PANIC_NATIVE = `FAIL  [0.0018s] h
    Test reverted: 0x4e487b710000000000000000000000000000000000000000000000000000000000000012
stdout:

stderr:


test result: FAILED. 0 passed; 1 failed

failures:
    h`;

const OUT_OF_GAS = `FAIL  [1.0596s] h
    Test halted: OutOfGas(Basic) (gas: 1000000000)

test result: FAILED. 0 passed; 1 failed

failures:
    h`;

const COMPILE = `Compilation errors in file:///C:/x/probe1.fe

error[8-0024]: argument label mismatch
   ┌─ probe1.fe:58:23
   │
58 │         buggy_sat_add(input, 1) >= input
   │                       ^^^^^ expected \`a\` label, but \`input\` given

ERROR [0.1102s] Compilation errors in file:///C:/x/probe1.fe

test result: FAILED. 0 passed; 1 failed

failures:
    probe1::compile`;

const BAD_TOML = `Compilation errors while initializing ingot \`.fuzzloom/tmp/h-7\`
ERROR [0.0043s] Compilation errors while initializing ingot \`.fuzzloom/tmp/h-7\`
Error: Invalid fe.toml in ingot file:///C:/x/h-7/:
  • The dependency "demo" has an invalid path "C:/x/demo"`;

const NO_NATIVE = `Failed to emit test native: native test execution supports x86-64 Linux and AArch64 macOS
ERROR [0.1193s] Failed to emit test native: native test execution supports x86-64 Linux and AArch64 macOS`;

test("payloads are results, including on native with its extra output", () => {
  assert.deepEqual(parseFeOutput(PANIC_NATIVE), { kind: "panic", code: 18n, reason: "division or modulo by zero" });
});

test("out of gas is infra, never a failure", () => {
  const o = parseFeOutput(OUT_OF_GAS);
  assert.equal(o.kind, "infra");
  assert.equal(o.kind === "infra" && o.reason, "out-of-gas");
});

test("compile errors are infra and keep the first diagnostic", () => {
  const o = parseFeOutput(COMPILE);
  assert.equal(o.kind === "infra" && o.reason, "compile");
  assert.match(o.kind === "infra" ? o.detail : "", /argument label mismatch/);
  assert.equal(parseFeOutput(BAD_TOML).kind === "infra" && (parseFeOutput(BAD_TOML) as { reason: string }).reason, "compile");
});

test("an unsupported native host is reported as such", () => {
  const o = parseFeOutput(NO_NATIVE);
  assert.equal(o.kind === "infra" && o.reason, "backend-unavailable");
});

test("a harness that returns without a payload is not a pass", () => {
  const o = parseFeOutput("PASS  [0.0003s] h\n\ntest result: ok. 1 passed; 0 failed");
  assert.equal(o.kind === "infra" && o.reason, "unparsed");
});

test("a known selector with a truncated body is infra, not a crash", () => {
  // Digest needs four words; this carries one.
  const o = parseFeOutput(`FAIL  [0.001s] h
    Test reverted: ${SELECTORS.digest}${"0".repeat(63)}1
`);
  assert.equal(o.kind === "infra" && o.reason, "unparsed");
  assert.match(o.kind === "infra" ? o.detail : "", /malformed payload: Digest payload has 1 words/);
});

// Recorded from a four-test vault-math harness on sonatina (completion order, not case order).
const BATCH = `PASS  [0.0008s] case_3
FAIL  [0.0010s] case_0
    Test reverted: 0x4e487b710000000000000000000000000000000000000000000000000000000000000012
FAIL  [0.0062s] case_2
    Test reverted: 0xdeadbeef
FAIL  [5.1168s] case_1
    Test halted: OutOfGas(Basic) (gas: 1000000000)

test result: FAILED. 1 passed; 3 failed

failures:
    case_0
    case_2
    case_1`;

test("batch output is split per test name, whatever the completion order", () => {
  const o = parseBatchOutput(BATCH, ["case_0", "case_1", "case_2", "case_3", "case_4"]);
  assert.deepEqual(o[0], { kind: "panic", code: 18n, reason: "division or modulo by zero" });
  assert.equal(o[1]!.kind === "infra" && o[1]!.reason, "out-of-gas"); // only this case, not its neighbours
  assert.equal(o[2]!.kind === "infra" && o[2]!.reason, "unparsed"); // unknown selector
  assert.equal(o[3]!.kind === "infra" && o[3]!.reason, "unparsed"); // returned without a payload
  assert.equal(o[4]!.kind === "infra" && o[4]!.reason, "unparsed"); // no line at all: never a pass
});

test("batch output with a compile error applies it to every case", () => {
  const o = parseBatchOutput(COMPILE, ["case_0", "case_1"]);
  assert.ok(o.every((x) => x.kind === "infra" && x.reason === "compile"));
});
