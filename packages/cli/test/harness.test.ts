import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fnv1a64, harnessBody, writeHarness } from "../src/harness.ts";
import { runHarness } from "../src/fe.ts";
import { discover } from "../src/discover.ts";
import type { Target } from "../src/types.ts";

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
});

test("dependency paths are relative", () => {
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const user = resolve(import.meta.dirname, "../../../examples/vault-math");
  const dir = writeHarness({ userRoot: user, ingot: "vault_math", target: two, call: { mode: "check", base: 1n, runs: 1n }, workDir: work });
  const toml = readFileSync(join(dir, "fe.toml"), "utf8");
  for (const m of toml.matchAll(/path = "([^"]+)"/g)) assert.ok(!/^([A-Za-z]:|\/)/.test(m[1]!), `absolute path ${m[1]}`);
});

test("integration: a generated harness runs through fe and decodes", () => {
  const root = resolve(import.meta.dirname, "../../../examples/vault-math");
  const d = discover(root);
  const t = d.targets.find((x) => x.name === "prop_withdraw_never_overdraws")!;
  const work = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  const dir = writeHarness({ userRoot: root, ingot: d.ingot, target: t, call: { mode: "replay", input: [0n, 1n, 0n] }, workDir: work });
  const r = runHarness(dir, "sonatina");
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
    { mode: "target_input_at", base: 1n, iteration: 1n }, { mode: "evaluate", input: [1n, 2n, 3n] },
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
