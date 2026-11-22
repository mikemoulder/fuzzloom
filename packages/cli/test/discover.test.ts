import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { declarations, discover, discoverSource, modulePath, parseUses } from "../src/discover.ts";

test("finds single-line and fe-fmt-wrapped signatures", () => {
  const src = `
pub fn prop_one(_ x: u64) -> bool { x == x }

pub fn prop_three(
    _ a: u64,
    _ b: i128,
    _ c: bool,
) -> bool {
    true
}

pub fn diff_mix(_ a: u128, _ b: u128) -> u256 { 0 }
fn prop_private(_ x: u8) -> bool { true }
`;
  const r = discoverSource(src, "lib.fe");
  assert.deepEqual(r.targets.map((t) => [t.name, t.args.map((a) => a.type), t.returns, t.line]), [
    ["prop_one", ["u64"], undefined, 2],
    ["prop_three", ["u64", "i128", "bool"], undefined, 4],
    ["diff_mix", ["u128", "u128"], "u256", 12],
  ]);
  assert.equal(r.skipped.length, 0);
});

test("ignores signatures inside comments and literals, preserving discovery line numbers", () => {
  const src = `// pub fn prop_commented(_ x: u8) -> bool { true }
/* nested /* comment */ pub fn prop_block(_ x: u8) -> bool { true } */
fn message() { let text = "/* pub fn prop_literal(_ x: u8) -> bool { true }" }
pub fn prop_real(_ x: u8) -> bool { true }
/* closing comment below the real target */`;
  assert.deepEqual(discoverSource(src, "f.fe").targets.map((t) => [t.name, t.line]), [["prop_real", 4]]);
});

test("reports unsupported signatures with a reason instead of dropping them", () => {
  const src = `
pub fn prop_addr(_ a: Address) -> bool { true }
pub fn prop_none() -> bool { true }
pub fn prop_four(_ a: u8, _ b: u8, _ c: u8, _ d: u8) -> bool { true }
pub fn prop_ret(_ a: u8) -> u8 { a }
pub fn prop_generic<T>(_ a: T) -> bool { true }
pub fn prop_fx(_ a: u8) -> bool uses (evm: Evm, ) junk { true }
pub fn diff_void(_ a: u8) { }
`;
  const r = discoverSource(src, "f.fe");
  assert.equal(r.targets.length, 0);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
  assert.match(reasons.prop_addr!, /type Address/);
  assert.match(reasons.prop_none!, /0 arguments/);
  assert.match(reasons.prop_four!, /4 arguments/);
  assert.match(reasons.prop_ret!, /must return bool/);
  assert.match(reasons.prop_generic!, /generic/);
  assert.match(reasons.prop_fx!, /cannot read the effect clause/);
  assert.match(reasons.diff_void!, /must return/);
});

test("accepts labelled parameters (they work as positional Fn values)", () => {
  const r = discoverSource("pub fn prop_l(balance: u64, at amount: u64) -> bool { true }", "f.fe");
  assert.deepEqual(r.targets.map((t) => t.args.map((a) => a.name)), [["balance", "amount"]]);
});

test("discovers the vault-math example", () => {
  const d = discover(resolve(import.meta.dirname, "../../../examples/vault-math"));
  assert.equal(d.ingot, "vault_math");
  const props = d.targets.filter((t) => t.kind === "property").map((t) => `${t.name}/${t.args.length}`);
  const diffs = d.targets.filter((t) => t.kind === "differential").map((t) => `${t.name}/${t.args.length}`);
  assert.deepEqual(props, [
    "prop_fee_matches_exact_math/1", "prop_fee_exact_never_exceeds_amount/1", "prop_withdraw_never_overdraws/2",
    "prop_redeem_rounds_toward_vault/3", "prop_deposit_redeem_no_profit/3", "prop_deposit_is_monotone/3",
    "prop_share_price_defined/2",
  ]);
  assert.deepEqual(diffs, ["diff_mul_div/3", "diff_net_position/2", "diff_fee/1", "diff_rounding_mode/1"]);
  assert.equal(d.skipped.length, 0);
});

test("parses effect clauses: named, unnamed, mut, several, bare", () => {
  assert.deepEqual(parseUses("uses (ledger: mut Ledger, cfg: Config)"), [{ type: "Ledger", mut: true }, { type: "Config", mut: false }]);
  assert.deepEqual(parseUses("uses (Clock)"), [{ type: "Clock", mut: false }]);
  assert.deepEqual(parseUses("uses mut Store"), [{ type: "Store", mut: true }]);
  assert.deepEqual(parseUses("uses (c: std::evm::Ctx)"), [{ type: "std::evm::Ctx", mut: false }]);
  assert.equal(parseUses("uses (a: b: C)"), undefined);
});

test("labels are kept for direct calls: positional, named, explicit", () => {
  const r = discoverSource("pub fn prop_l(_ a: u8, balance: u64, at amount: u64) -> bool uses (x: X) { true }", "f.fe");
  assert.deepEqual(r.targets[0]!.args.map((a) => a.label), [null, "balance", "at"]);
});

test("module paths follow the file layout", () => {
  assert.equal(modulePath("ing", "/r/src", "/r/src/lib.fe"), "ing");
  assert.equal(modulePath("ing", "/r/src", "/r/src/policy.fe"), "ing::policy");
  assert.equal(modulePath("ing", "/r/src", "/r/src/a/b.fe"), "ing::a::b");
});

test("declarations: fixtures, public types and use imports", () => {
  const src = [
    "use ingot::p::{A, B}",
    "use std::x::Y",
    "pub struct S { }",
    "pub trait T { }",
    "pub fn fixture_s() -> S { S { } }",
    "fn fixture_hidden() -> S { S { } }",
  ].join(String.fromCharCode(10));
  const d = declarations(src);
  assert.deepEqual(d.fixtures, [{ name: "fixture_s", returns: "S" }]);
  assert.deepEqual(d.types, ["S", "T"]);
  assert.equal(d.uses.get("B"), "ingot::p::B");
  assert.equal(d.uses.get("Y"), "std::x::Y");
});

const NL = String.fromCharCode(10);

function ingot(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "fuzzloom-"));
  writeFileSync(join(root, "fe.toml"), ['[ingot]', 'name = "fx"', 'version = "0.1.0"', ""].join(NL));
  for (const [f, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "src", f)), { recursive: true });
    writeFileSync(join(root, "src", f), lines.join(NL));
  }
  return root;
}

test("effects resolve to fixtures by return type, or by name for a trait", () => {
  const d = discover(ingot({
    "lib.fe": [
      "use ingot::m::{Clock}",
      "pub struct L { }",
      "pub fn fixture_l() -> L { L { } }",
      "pub fn prop_a(_ x: u8) -> bool uses (l: mut L, c: Clock) { true }",
    ],
    "m.fe": ["pub trait Clock { }", "pub struct Fixed { }", "pub fn fixture_clock() -> Fixed { Fixed { } }"],
  }));
  assert.equal(d.skipped.length, 0, JSON.stringify(d.skipped));
  const t = d.targets[0]!;
  assert.deepEqual(t.effects, [{ type: "L", mut: true, fixture: "fixture_l" }, { type: "Clock", mut: false, fixture: "fixture_clock" }]);
  assert.deepEqual(t.imports, ["fx::prop_a", "fx::L", "fx::fixture_l", "fx::m::Clock", "fx::m::fixture_clock"]);
});

test("unresolvable effects are skipped with the reason", () => {
  const d = discover(ingot({
    "lib.fe": [
      "pub struct L { }",
      "pub fn fixture_a() -> L { L { } }",
      "pub fn fixture_b() -> L { L { } }",
      "pub fn prop_two(_ x: u8) -> bool uses (l: L) { true }",
      "pub fn prop_none(_ x: u8) -> bool uses (w: Wallet) { true }",
    ],
  }));
  const reasons = Object.fromEntries(d.skipped.map((s) => [s.name, s.reason]));
  assert.match(reasons.prop_two!, /more than one fixture builds it [(]fixture_a, fixture_b[)]/);
  assert.match(reasons.prop_none!, /no `pub fn fixture_wallet[(][)] -> Wallet`/);
  assert.equal(d.targets.length, 0);
});

test("targets in submodules are imported by their module path", () => {
  const d = discover(ingot({ "lib.fe": ["pub fn prop_root(_ x: u8) -> bool { true }"], "a/b.fe": ["pub fn prop_deep(_ x: u8) -> bool { true }"] }));
  assert.deepEqual(d.targets.map((t) => t.imports), [["fx::a::b::prop_deep"], ["fx::prop_root"]]);
});

test("discovers the token-ledger example with its effects", () => {
  const d = discover(resolve(import.meta.dirname, "../../../examples/token-ledger"));
  assert.equal(d.skipped.length, 0, JSON.stringify(d.skipped));
  const byName = Object.fromEntries(d.targets.map((t) => [t.name, t]));
  assert.deepEqual(byName.prop_transfer_conserves_supply!.effects!.map((e) => `${e.type}:${e.fixture}`), ["Ledger:fixture_ledger", "FeePolicy:fixture_policy"]);
  assert.deepEqual(byName.prop_vested_never_exceeds_total!.effects!.map((e) => e.fixture), ["fixture_clock"]);
  assert.ok(byName.prop_vested_never_exceeds_total!.imports!.includes("token_ledger::policy::Clock"));
  assert.equal(byName.diff_fee_quote!.kind, "differential");
});
