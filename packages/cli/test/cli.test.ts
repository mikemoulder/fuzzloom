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
