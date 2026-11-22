import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checks } from "../src/doctor.ts";
import { defaultFeConfig } from "../src/fe.ts";

const missing = { ...defaultFeConfig(), bin: join(tmpdir(), "no-such-fe"), wslBin: "/no/such/fe" };

test("a missing fe fails with an install hint, and a missing native backend only warns", () => {
  const cs = checks(undefined, missing);
  const fe = cs.find((c) => c.name === "fe")!;
  assert.equal(fe.level, "fail");
  assert.match(fe.fix ?? "", /feup/);
  assert.equal(cs.find((c) => c.name === "Native backend")!.level, "warn");
  assert.ok(!cs.some((c) => c.name === "Library compiles"), "no compile check without fe");
});

test("a directory without fe.toml is not a project", () => {
  const cs = checks(mkdtempSync(join(tmpdir(), "fuzzloom-")), missing);
  assert.equal(cs.find((c) => c.name === "Project")!.level, "fail");
});

test("the example project reports its targets", () => {
  const vault = checks(resolve(import.meta.dirname, "../../../examples/vault-math"), missing);
  assert.match(vault.find((c) => c.name === "Project")!.detail, /7 prop_\*, 4 diff_\*, 0 seq_\* functions, 0 skipped/);
  const receipts = checks(resolve(import.meta.dirname, "../../../examples/receipt-ledger"), missing);
  assert.match(receipts.find((c) => c.name === "Project")!.detail, /0 prop_\*, 0 diff_\*, 1 seq_\* functions, 0 skipped/);
});
