import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { discover, discoverSource } from "../src/discover.ts";

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

test("ignores signatures inside comments", () => {
  const src = `// pub fn prop_commented(_ x: u8) -> bool { true }
/* pub fn prop_block(_ x: u8) -> bool { true } */
pub fn prop_real(_ x: u8) -> bool { true }`;
  assert.deepEqual(discoverSource(src, "f.fe").targets.map((t) => [t.name, t.line]), [["prop_real", 3]]);
});

test("reports unsupported signatures with a reason instead of dropping them", () => {
  const src = `
pub fn prop_addr(_ a: Address) -> bool { true }
pub fn prop_none() -> bool { true }
pub fn prop_four(_ a: u8, _ b: u8, _ c: u8, _ d: u8) -> bool { true }
pub fn prop_ret(_ a: u8) -> u8 { a }
pub fn prop_generic<T>(_ a: T) -> bool { true }
pub fn prop_fx(_ a: u8) -> bool uses (evm: Evm) { true }
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
  assert.match(reasons.prop_fx!, /effects/);
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
