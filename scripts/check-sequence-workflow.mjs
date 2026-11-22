// Reproduce the entire stateful regression lifecycle through a source CLI
// or an installed executable. The example is copied before applying its fix.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = process.argv[2];
const invoke = (...args) => cli
  ? spawnSync(cli, args, { encoding: "utf8" })
  : spawnSync(process.execPath, [resolve(import.meta.dirname, "../packages/cli/src/index.ts"), ...args], { encoding: "utf8" });

const root = mkdtempSync(join(tmpdir(), "fuzzloom-sequence-"));
try {
  cpSync(resolve(import.meta.dirname, "../examples/receipt-ledger"), root, {
    recursive: true, filter: (path) => !path.split(/[\\/]/).includes(".fuzzloom"),
  });
  const run = (code, ...args) => {
    const result = invoke(...args);
    assert.equal(result.status, code, [...args, result.error?.message, result.stderr, result.stdout].join("\n"));
    return result.stdout;
  };
  const backends = ["sonatina", "native"];
  const campaign = (backend) => ["sequence", root, "--strict", "--seed", "7", "--runs", "32", "--backend", backend, "--json"];
  const records = new Set();
  for (const backend of backends) {
    const one = JSON.parse(run(0, ...campaign(backend), "--steps", "1"));
    assert.equal(one.coverage.inputsThroughReportedOutcome, "32");
    assert.equal(one.results[0].status, "passed");

    const { results: [failure] } = JSON.parse(run(1, ...campaign(backend)));
    assert.equal(failure.outcome.originalSteps, 4);
    assert.equal(failure.outcome.shrinkComplete, true);
    assert.deepEqual(failure.outcome.steps, [["0", "0", "0"], ["0", "0", "0"]]);
    const saved = JSON.parse(readFileSync(join(root, ".fuzzloom", "failures", `${failure.record}.json`), "utf8"));
    assert.equal(saved.backend, backend);
    assert.deepEqual(saved.sequence, [["0x0"], ["0x0"]]);
    records.add(failure.record);
    assert.match(run(1, "reproduce", failure.record, root), /invariant fails at step 2/);
  }
  assert.equal(records.size, backends.length, "identical traces need independent backend verdicts");
  const file = join(root, "src", "lib.fe");
  const buggy = readFileSync(file, "utf8");
  const fixed = buggy.replace("ledger.seen = ledger.seen | bit", "if ledger.seen & bit != 0 { return }\n    ledger.seen = ledger.seen | bit");
  assert.notEqual(fixed, buggy);
  writeFileSync(file, fixed);
  const replay = ["replay", root, "--only", "seq_credit_once"];
  assert.equal((run(0, ...replay).match(/\bFIXED\b/g) ?? []).length, backends.length);
  for (const backend of backends) {
    assert.equal(JSON.parse(run(0, ...campaign(backend))).results[0].status, "passed");
  }
  writeFileSync(file, buggy);
  assert.equal((run(1, ...replay).match(/\bREGRESSED\b/g) ?? []).length, backends.length);
  console.log("Sonatina and native: 32 single-step traces pass per backend; four steps shrink to [0, 0]");
  console.log("Both backend records reproduce and transition FAILS → FIXED → REGRESSED from one ingot");
} finally {
  rmSync(root, { recursive: true, force: true });
}
