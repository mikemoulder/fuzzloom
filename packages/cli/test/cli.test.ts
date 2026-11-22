import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dirname, "../src/index.ts");
const run = (command: string, root: string, ...options: string[]) =>
  spawnSync(process.execPath, [entry, command, root, ...options], { encoding: "utf8" });

test("campaign CLI rejects empty selections and invalid u64 parameters", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fuzzloom-cli-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "fe.toml"), '[ingot]\nname = "test_ingot"\n');
  writeFileSync(join(root, "src", "lib.fe"), "pub fn prop_example(_ x: u8) -> bool { x == x }");
  for (const [command, options, expected] of [
    ["fuzz", ["--only", "typo"], /no runnable prop_/],
    ["diff", [], /no runnable diff_/],
    ["replay", ["--only", "typo"], /no saved failures/],
    ["fuzz", ["--runs", "0"], /--runs must be in/],
    ["fuzz", ["--seed", "18446744073709551616"], /--seed must be in/],
  ] as const) {
    const result = run(command, root, ...options);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, expected);
  }
});

test("CLI cleanup preserves another invocation's harnesses", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fuzzloom-cli-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "fe.toml"), '[ingot]\nname = "test_ingot"\n');
  const base = join(root, ".fuzzloom", "tmp");
  const other = join(base, "run-other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "marker"), "another invocation");
  assert.equal(run("replay", root).status, 0);
  assert.deepEqual(readdirSync(base), ["run-other"]);
  assert.equal(readFileSync(join(other, "marker"), "utf8"), "another invocation");
});

test("strict discovery gates only the selected candidates and returns a CI error", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fuzzloom-cli-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "fe.toml"), '[ingot]\nname = "test_ingot"\n');
  writeFileSync(join(root, "src", "lib.fe"), [
    "pub fn diff_valid(_ x: u8) -> u8 { x }",
    "pub fn diff_invalid(_ x: u8) -> (u8, u8) { (x, x) }",
    "pub fn prop_invalid(_ x: u8) -> u8 { x }",
  ].join("\n"));
  const report = join(root, "strict.xml");
  const result = run("diff", root, "--strict", "--json", "--junit", report);
  assert.equal(result.status, 2, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.skipped.map((s: { name: string }) => s.name), ["diff_invalid"]);
  assert.equal(json.coverage.selectedTargets, 2);
  assert.equal(json.coverage.targetsRun, 0);
  assert.match(readFileSync(report, "utf8"), /<error .*type="skipped-target"/);
  const filtered = run("diff", root, "--strict", "--only", "missing");
  assert.match(filtered.stderr, /no runnable diff_/);
});
