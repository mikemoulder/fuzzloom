// Failure records come from the repository under test, so these tests plant
// the attacks from the security audit and check that each one fails.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecordId, listRecords, loadRecord, makeRecord, saveRecord, validateRecord, type FailureRecord } from "../src/store.ts";
import { workDir } from "../src/engine.ts";
import type { Target } from "../src/types.ts";

const target: Target = { kind: "property", name: "prop_keeps_k", args: [{ name: "a", type: "u64" }, { name: "b", type: "u64" }], file: "src/lib.fe", line: 1 };

const record = (): FailureRecord =>
  makeRecord({ kind: "abort", target, input: [2358n, 1n, 0n], iteration: 1n, base: 7n, runs: 10000n, backend: "sonatina", detail: "overflow", feVersion: "fe 26.6.0" });

/** A fresh ingot root with a failures directory, inside its own parent (so a write to ".." is visible). */
function ingot(): { parent: string; root: string; failures: string } {
  const parent = mkdtempSync(join(tmpdir(), "fuzzloom-store-"));
  const root = join(parent, "repo");
  const failures = join(root, ".fuzzloom", "failures");
  mkdirSync(failures, { recursive: true });
  return { parent, root, failures };
}

test("record ids: only the shape recordId generates", () => {
  assert.ok(isRecordId(record().id));
  for (const bad of ["../../../package", "a/b-0123abcd", "x-0123abc", "x-0123abcz", "", "prop-0123ABCD", "..\\x-0123abcd"]) {
    assert.equal(isRecordId(bad), false, bad);
  }
});

test("a planted record whose id climbs out of the ingot writes nothing outside it", () => {
  const { parent, root, failures } = ingot();
  writeFileSync(join(parent, "package.json"), '{"name":"neighbour"}');
  const evil = { ...record(), id: "../../../package", scripts: { postinstall: "echo pwned" } };
  writeFileSync(join(failures, "innocent.json"), JSON.stringify(evil));
  const warnings: string[] = [];
  assert.deepEqual(listRecords(root, (m) => warnings.push(m)), []);
  assert.equal(warnings.length, 1);
  assert.throws(() => saveRecord(root, evil as FailureRecord), /invalid failure record/);
  assert.equal(readFileSync(join(parent, "package.json"), "utf8"), '{"name":"neighbour"}');
  assert.deepEqual(readdirSync(parent).sort(), ["package.json", "repo"]);
});

test("a record whose id does not match its file name is skipped, and loading it fails", () => {
  const { root, failures } = ingot();
  const r = record();
  writeFileSync(join(failures, "prop_other-0123abcd.json"), JSON.stringify(r));
  const warnings: string[] = [];
  assert.deepEqual(listRecords(root, (m) => warnings.push(m)), []);
  assert.match(warnings[0]!, /does not match its file name/);
  assert.throws(() => loadRecord(root, "prop_other-0123abcd"), /does not match its file name/);
});

test("reproduce refuses an id that is a path", () => {
  const { root } = ingot();
  assert.throws(() => loadRecord(root, "../../../package"), /invalid failure id/);
});

test("saving keeps only known fields, and strips control characters from text", () => {
  const { root, failures } = ingot();
  const r = { ...record(), sampling: "uniform" as const, detail: "overflow\u001b[2J\u001b]0;FIXED\u0007", scripts: { postinstall: "echo pwned" }, __proto__x: 1 };
  saveRecord(root, r as FailureRecord);
  const saved = JSON.parse(readFileSync(join(failures, `${r.id}.json`), "utf8"));
  assert.equal(saved.scripts, undefined);
  assert.equal(saved.__proto__x, undefined);
  assert.equal(saved.detail, "overflow[2J]0;FIXED");
  assert.equal(loadRecord(root, r.id).sampling, "uniform");
  assert.deepEqual(listRecords(root).map((x) => x.id), [r.id]);
});

test("one malformed file never stops the others from loading", () => {
  const { root, failures } = ingot();
  const r = record();
  saveRecord(root, r);
  writeFileSync(join(failures, "prop_broken-0123abcd.json"), "not json");
  writeFileSync(join(failures, "notes.json"), "{}");
  const warnings: string[] = [];
  assert.deepEqual(listRecords(root, (m) => warnings.push(m)).map((x) => x.id), [r.id]);
  assert.equal(warnings.length, 2);
});

test("validateRecord rejects input words that are not hex for every argument", () => {
  const r = record();
  assert.throws(() => validateRecord({ ...r, input: ["0x1"] }), /one lowercase hex word per argument/);
  assert.throws(() => validateRecord({ ...r, input: ["-5", "0x1"] }), /one lowercase hex word per argument/);
  assert.throws(() => validateRecord({ ...r, input: ["0x10000000000000000", "0x1"] }), /does not fit u64/);
  assert.throws(() => validateRecord({ ...r, kind: "sequence", sequence: [] }), /sequence length/);
  assert.throws(() => validateRecord({ ...r, kind: "sequence", sequence: [["0x1", "0x1"]] }), /first sequence step/);
  assert.throws(() => validateRecord({ ...r, args: [{ name: "a; rm", type: "u64" }, r.args[1]] }), /invalid argument/);
  assert.throws(() => validateRecord({ ...r, version: 2 }), /version 2/);
});

/** Probe junction support at the actual test path before running assertions. */
function link(t: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(code ?? "")) throw error;
    t.skip(`temporary filesystem cannot create a Windows junction (${code})`);
    return false;
  }
}

test("a symlinked .fuzzloom is refused for records and for the scratch directory", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "fuzzloom-link-"));
  const victim = join(parent, "victim");
  mkdirSync(join(victim, "tmp"), { recursive: true });
  writeFileSync(join(victim, "tmp", "keep-me.txt"), "important");
  const root = join(parent, "repo");
  mkdirSync(root);
  if (!link(t, victim, join(root, ".fuzzloom"))) return;
  assert.throws(() => workDir(root), /is a symlink/);
  assert.throws(() => listRecords(root), /is a symlink/);
  assert.throws(() => saveRecord(root, record()), /is a symlink/);
  assert.ok(existsSync(join(victim, "tmp", "keep-me.txt")));
  assert.deepEqual(readdirSync(victim), ["tmp"]);
});

test("a symlinked .fuzzloom/tmp is refused too", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "fuzzloom-link-"));
  const victim = join(parent, "victim");
  mkdirSync(victim);
  const root = join(parent, "repo");
  mkdirSync(join(root, ".fuzzloom"), { recursive: true });
  if (!link(t, victim, join(root, ".fuzzloom", "tmp"))) return;
  assert.throws(() => workDir(root), /is a symlink/);
});

test("a fresh ingot with no .fuzzloom yet resolves normally", () => {
  const parent = mkdtempSync(join(tmpdir(), "fuzzloom-fresh-"));
  assert.equal(workDir(parent), join(parent, ".fuzzloom", "tmp"));
});
