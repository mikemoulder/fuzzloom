// parseFeOutput against fe test output recorded from real runs (fe 26.6.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeOutput } from "../src/fe.ts";

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
