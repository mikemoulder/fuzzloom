import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { callable, caseName, fnv1a64, harnessBody, writeBatch, writeHarness, type Case } from "../src/harness.ts";
import { runBatch, runHarness } from "../src/fe.ts";
import { discover } from "../src/discover.ts";
import type { Target, Words } from "../src/types.ts";

test("fnv1a64 matches reference vectors", () => {
  assert.equal(fnv1a64(""), 0xcbf29ce484222325n);
  assert.equal(fnv1a64("a"), 0xaf63dc4c8601ec8cn);
  assert.equal(fnv1a64("foobar"), 0x85944171f73967e8n);
});

const two: Target = { kind: "property", name: "prop_w", args: [{ name: "b", type: "u128" }, { name: "a", type: "u128" }], file: "f", line: 1 };

test("harness bodies for every mode", () => {
  const id = "0x" + fnv1a64("prop_w").toString(16);
  assert.equal(harnessBody(two, { mode: "check", base: 7n, runs: 100n }), `check(prop2(prop_w), seed: derive_seed(7, ${id}), runs: 100)`);
  assert.equal(harnessBody(two, { mode: "replay", input: [0n, 1n, 0n] }), "replay(prop2(prop_w), input: Input::two(0x0, 0x1))");
  assert.equal(harnessBody(two, { mode: "input_at", base: 7n, iteration: 41n }),
    `input_at(prop2(prop_w), bounds: bounds_of(prop2(prop_w)), seed: derive_seed(7, ${id}), iteration: 41)`);
  const d: Target = { ...two, kind: "differential", returns: "u256" };
  assert.equal(harnessBody(d, { mode: "digest", base: 7n, runs: 5n }), `digest(target2(prop_w), seed: derive_seed(7, ${id}), runs: 5)`);
  assert.equal(harnessBody(d, { mode: "checkpoints", base: 7n, first: 40n, step: 40n, count: 3 }),
    `digest_checkpoints(target2(prop_w), seed: derive_seed(7, ${id}), first: 40, step: 40, count: 3)`);
  const cid = "0x" + fnv1a64("prop_w@0x5,0x6").toString(16);
  assert.equal(harnessBody(two, { mode: "check", base: 7n, runs: 100n, corpus: [5n, 6n, 0n] }),
    `check_mutating(prop2(prop_w), corpus: Input::two(0x5, 0x6), seed: derive_seed(7, ${cid}), runs: 100)`);
  assert.equal(harnessBody(two, { mode: "input_at", base: 7n, iteration: 4n, corpus: [5n, 6n, 0n] }),
    `mutant_at(prop2(prop_w), corpus: Input::two(0x5, 0x6), seed: derive_seed(7, ${cid}), iteration: 4)`);
  assert.equal(harnessBody(two, { mode: "replay_at", base: 7n, iteration: 4n, corpus: [5n, 6n, 0n] }),
    `replay(prop2(prop_w), input: mutated_at(bounds_of(prop2(prop_w)), arity: arity_of(prop2(prop_w)), corpus: Input::two(0x5, 0x6), seed: derive_seed(7, ${cid}), iteration: 4))`);
  assert.equal(harnessBody(two, { mode: "replay_at", base: 7n, iteration: 3n }),
    `replay(prop2(prop_w), input: generated_at(bounds_of(prop2(prop_w)), arity: arity_of(prop2(prop_w)), seed: derive_seed(7, ${id}), iteration: 3))`);
  assert.equal(harnessBody(d, { mode: "evaluate_at", base: 7n, iteration: 3n }),
    `evaluate(target2(prop_w), input: target_generated_at(target2(prop_w), seed: derive_seed(7, ${id}), iteration: 3))`);
});

test("dependency paths are relative", () => {
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const user = resolve(import.meta.dirname, "../../../examples/vault-math");
  const dir = writeHarness({ userRoot: user, ingot: "vault_math", target: two, call: { mode: "check", base: 1n, runs: 1n }, workDir: work });
  const toml = readFileSync(join(dir, "fe.toml"), "utf8");
  for (const m of toml.matchAll(/path = "([^"]+)"/g)) assert.ok(!/^([A-Za-z]:|\/)/.test(m[1]!), `absolute path ${m[1]}`);
});

test("integration: a generated harness runs through fe and decodes", async () => {
  const root = resolve(import.meta.dirname, "../../../examples/vault-math");
  const d = discover(root);
  const t = d.targets.find((x) => x.name === "prop_withdraw_never_overdraws")!;
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const dir = writeHarness({ userRoot: root, ingot: d.ingot, target: t, call: { mode: "replay", input: [0n, 1n, 0n] }, workDir: work });
  const r = await runHarness(dir, "sonatina");
  assert.deepEqual(r.outcome, { kind: "replayed", arity: 2, input: [0n, 1n, 0n], failed: true });
});

test("every library function the harness generator calls is exported", () => {
  // Regression: target_input_at existed but was not re-exported from lib.fe,
  // so diff harnesses failed to compile while the library's own tests passed.
  const lib = readFileSync(resolve(import.meta.dirname, "../../../ingots/fuzzloom/src/lib.fe"), "utf8");
  const exported = new Set([...lib.matchAll(/pub use [\w:]+::(?:\{([^}]*)\}|(\w+))/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? "").split(",").map((x) => x.trim()).filter(Boolean)));
  const calls: Parameters<typeof harnessBody>[1][] = [
    { mode: "check", base: 1n, runs: 1n }, { mode: "replay", input: [1n, 2n, 3n] },
    { mode: "input_at", base: 1n, iteration: 1n }, { mode: "digest", base: 1n, runs: 1n },
    { mode: "checkpoints", base: 1n, first: 1n, step: 1n, count: 1 },
    { mode: "target_input_at", base: 1n, iteration: 1n }, { mode: "evaluate", input: [1n, 2n, 3n] },
    { mode: "replay_at", base: 1n, iteration: 1n }, { mode: "evaluate_at", base: 1n, iteration: 1n },
    { mode: "check", base: 1n, runs: 1n, corpus: [1n, 2n, 3n] }, { mode: "input_at", base: 1n, iteration: 1n, corpus: [1n, 2n, 3n] },
    { mode: "replay_at", base: 1n, iteration: 1n, corpus: [1n, 2n, 3n] },
  ];
  const used = new Set<string>();
  for (const arity of [1, 2, 3]) {
    const args = two.args.concat(two.args).slice(0, arity);
    for (const kind of ["property", "differential"] as const) {
      for (const c of calls) {
        const body = harnessBody({ ...two, kind, args, returns: "u8" }, c);
        // Free functions and types, not associated functions after `::`.
        for (const m of body.matchAll(/(?<!::)\b([A-Za-z_]\w*)\s*(?:\(|::)/g)) if (m[1] !== "prop_w") used.add(m[1]!);
      }
    }
  }
  const missing = [...used].filter((n) => !exported.has(n));
  assert.deepEqual(missing, [], `not exported from lib.fe: ${missing.join(", ")}`);
});

test("integration: one batch harness answers every case by name, including the new modes", async () => {
  const root = resolve(import.meta.dirname, "../../../examples/vault-math");
  const d = discover(root);
  const withdraw = d.targets.find((x) => x.name === "prop_withdraw_never_overdraws")!;
  const price = d.targets.find((x) => x.name === "prop_share_price_defined")!;
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const cases: Case[] = [
    { target: withdraw, call: { mode: "replay", input: [0n, 1n, 0n] } },
    { target: withdraw, call: { mode: "replay", input: [5n, 1n, 0n] } },
    { target: price, call: { mode: "replay", input: [0n, 0n, 0n] } },
    { target: withdraw, call: { mode: "input_at", base: 7n, iteration: 3n } },
    { target: withdraw, call: { mode: "replay_at", base: 7n, iteration: 3n } },
  ];
  const dir = writeBatch({ userRoot: root, ingot: d.ingot, cases, workDir: work, name: "batch" });
  const r = await runBatch(dir, cases.map((_, i) => caseName(i)), "sonatina");
  assert.deepEqual(r.outcomes[0], { kind: "replayed", arity: 2, input: [0n, 1n, 0n], failed: true });
  assert.deepEqual(r.outcomes[1], { kind: "replayed", arity: 2, input: [5n, 1n, 0n], failed: false });
  assert.deepEqual(r.outcomes[2], { kind: "panic", code: 18n, reason: "division or modulo by zero" });
  // replay_at evaluates exactly the input input_at reports.
  const g = r.outcomes[3]!, rep = r.outcomes[4]!;
  assert.equal(g.kind, "generated");
  assert.equal(rep.kind, "replayed");
  if (g.kind === "generated" && rep.kind === "replayed") assert.deepEqual(rep.input, g.input);
});

test("integration: a mutation campaign runs through fe and its mutants are recoverable", async () => {
  const root = resolve(import.meta.dirname, "../../../examples/vault-math");
  const d = discover(root);
  const withdraw = d.targets.find((x) => x.name === "prop_withdraw_never_overdraws")!;
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const corpus: Words = [1000n, 1001n, 0n]; // a saved failure on the off-by-one diagonal
  const cases: Case[] = [
    { target: withdraw, call: { mode: "check", base: 7n, runs: 2000n, corpus } },
    { target: withdraw, call: { mode: "input_at", base: 7n, iteration: 5n, corpus } },
    { target: withdraw, call: { mode: "replay_at", base: 7n, iteration: 5n, corpus } },
  ];
  const dir = writeBatch({ userRoot: root, ingot: d.ingot, cases, workDir: work, name: "mutate" });
  const r = await runBatch(dir, cases.map((_, i) => caseName(i)), "sonatina");
  const c = r.outcomes[0]!;
  assert.equal(c.kind, "counterexample");
  if (c.kind === "counterexample") assert.deepEqual(c.shrunk, [0n, 1n, 0n]);
  const g = r.outcomes[1]!, rep = r.outcomes[2]!;
  assert.ok(g.kind === "generated" && rep.kind === "replayed");
  if (g.kind === "generated" && rep.kind === "replayed") assert.deepEqual(rep.input, g.input);
});

test("integration: real checkpoints equal separate digests, on both backends", async () => {
  // The decoder reads the DynArray tail from real fe output, and every
  // checkpoint matches the digest a separate case computes for that run count.
  const root = resolve(import.meta.dirname, "../../../examples/vault-math");
  const d = discover(root);
  const fee = d.targets.find((x) => x.name === "diff_fee")!;
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const cases: Case[] = [
    { target: fee, call: { mode: "checkpoints", base: 7n, first: 0n, step: 25n, count: 5 } },
    ...[0n, 25n, 50n, 75n, 100n].map((runs): Case => ({ target: fee, call: { mode: "digest", base: 7n, runs } })),
  ];
  for (const backend of ["sonatina", "native"] as const) {
    const dir = writeBatch({ userRoot: root, ingot: d.ingot, cases, workDir: work, name: `cps-${backend}` });
    const r = await runBatch(dir, cases.map((_, i) => caseName(i)), backend);
    const c = r.outcomes[0]!;
    assert.equal(c.kind, "checkpoints", JSON.stringify(c, (_, v) => typeof v === "bigint" ? v.toString() : v));
    if (c.kind !== "checkpoints") continue;
    assert.equal(c.accs.length, 5);
    assert.deepEqual(c.accs, r.outcomes.slice(1).map((o) => (o.kind === "digest" ? o.acc : -1n)), backend);
  }
});

test("an effectful target becomes a closure that builds fresh fixtures", () => {
  const t: Target = {
    ...two,
    args: [{ name: "x", type: "u8", label: null }, { name: "y", type: "u16", label: "at" }],
    effects: [{ type: "Ledger", mut: true, fixture: "fixture_ledger" }, { type: "Clock", mut: false, fixture: "fixture_clock" }],
  };
  const c = callable(t);
  assert.ok(c.startsWith("prop2(|a0: u8, a1: u16| {"), c);
  assert.ok(c.includes("var e0 = fixture_ledger()") && c.includes("var e1 = fixture_clock()"), c);
  assert.ok(c.includes("with (Ledger = e0, Clock = e1) { prop_w(a0, at: a1) }"), c);
  assert.equal(callable(two), "prop2(prop_w)");
});

test("integration: effectful targets run through fe on both backends", async () => {
  // Real fixtures, real with-blocks: the transfer property aborts (planted
  // fee underflow) at amount 0, the overdraft property passes, the fee quote
  // evaluates identically on both backends.
  const root = resolve(import.meta.dirname, "../../../examples/token-ledger");
  const d = discover(root);
  const by = (n: string) => d.targets.find((x) => x.name === n)!;
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const cases: Case[] = [
    { target: by("prop_transfer_conserves_supply"), call: { mode: "replay", input: [0n, 0n, 0n] } },
    { target: by("prop_transfer_conserves_supply"), call: { mode: "replay", input: [10000n, 1n, 0n] } },
    { target: by("prop_overdraft_changes_nothing"), call: { mode: "check", base: 7n, runs: 500n } },
    { target: by("diff_fee_quote"), call: { mode: "evaluate", input: [1000000n, 0n, 0n] } },
  ];
  for (const backend of ["sonatina", "native"] as const) {
    const dir = writeBatch({ userRoot: root, ingot: d.ingot, cases, workDir: work, name: `fx-${backend}` });
    const r = await runBatch(dir, cases.map((_, i) => caseName(i)), backend);
    assert.deepEqual(r.outcomes[0], { kind: "panic", code: 17n, reason: "arithmetic overflow or underflow" }, backend);
    assert.deepEqual(r.outcomes[1], { kind: "replayed", arity: 2, input: [10000n, 1n, 0n], failed: false }, backend);
    assert.equal(r.outcomes[2]!.kind, "passed", backend);
    assert.deepEqual(r.outcomes[3], { kind: "evaluated", arity: 1, input: [1000000n, 0n, 0n], output: 2500n }, backend);
  }
});

test("integration: every bounded entry point compiles, runs and stays in range", async () => {
  const root = resolve(import.meta.dirname, "../../../examples/token-ledger");
  const d = discover(root);
  const quote: Target = { ...d.targets.find((x) => x.name === "diff_fee_quote")!, bounds: [{ arg: 0, lo: 1000n, hi: 2000n }] };
  const over: Target = { ...d.targets.find((x) => x.name === "prop_overdraft_changes_nothing")!, bounds: [{ arg: 0, lo: 1000000n, hi: 1000100n }] };
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const cases: Case[] = [
    { target: quote, call: { mode: "checkpoints", base: 3n, first: 1n, step: 10n, count: 3 } },
    { target: quote, call: { mode: "target_input_at", base: 3n, iteration: 4n } },
    { target: quote, call: { mode: "evaluate_at", base: 3n, iteration: 4n } },
    { target: over, call: { mode: "check", base: 3n, runs: 300n } },
    { target: over, call: { mode: "check", base: 3n, runs: 300n, corpus: [5n, 0n, 0n] } },
    { target: over, call: { mode: "input_at", base: 3n, iteration: 7n } },
    { target: over, call: { mode: "input_at", base: 3n, iteration: 7n, corpus: [5n, 0n, 0n] } },
  ];
  const dir = writeBatch({ userRoot: root, ingot: d.ingot, cases, workDir: work, name: "bounded" });
  const o = (await runBatch(dir, cases.map((_, i) => caseName(i)), "sonatina")).outcomes;
  assert.equal(o[0]!.kind === "checkpoints" && o[0]!.accs.length, 3);
  const g = o[1]!, e = o[2]!;
  assert.ok(g.kind === "generated" && g.input[0] >= 1000n && g.input[0] <= 2000n, JSON.stringify(g, (_, v) => typeof v === "bigint" ? String(v) : v));
  assert.ok(e.kind === "evaluated" && g.kind === "generated" && e.input[0] === g.input[0], "evaluate_at evaluates the bounded input");
  assert.equal(o[3]!.kind, "passed");
  assert.equal(o[4]!.kind, "passed");
  for (const x of [o[5]!, o[6]!]) assert.ok(x.kind === "generated" && x.input[0] >= 1000000n && x.input[0] <= 1000100n, "input within range (corpus clamped)");
});
