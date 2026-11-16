# vault-math

Share accounting for a tokenized vault (ERC-4626 style), with four planted bugs. Every hand-written test in the file passes. Fuzzloom finds all four, and shrinks each to a minimal input you can read.

## The planted bugs

| Property | Arguments | Bug | Fuzzloom result (seed 7, 10,000 runs) |
|---|---|---|---|
| `prop_fee_matches_exact_math` | `amount: u64` | fee multiplication wraps above `u64::MAX / 30` | shrunk to `614891469123651721`, exactly the first amount that wraps |
| `prop_withdraw_never_overdraws` | `balance: u128, amount: u128` | off by one: allows `amount == balance + 1` | found at iteration 41, shrunk to `(0, 1)` |
| `prop_redeem_rounds_toward_vault` | `shares, total_assets, total_supply: u64` | redeem rounds up, in favour of the user | shrunk to `(1, 0, 1)`: redeeming 1 share of an empty vault pays 1 |
| `prop_share_price_defined` | `total_assets, total_supply: u64` | no guard for zero supply | aborts with `Panic(0x12)` (division by zero) |

Each bug is marked `PLANTED BUG` in `src/lib.fe` with its fix next to it. With all four fixes applied, all seven properties pass 10,000 runs.

How each one gets found:

- **Wrapping fee:** boundary-biased generation reaches the top of `u64`. Shrinking then walks down to the exact threshold, because the failure is monotone above it.
- **Off-by-one withdraw:** the only failing inputs are on the line `amount == balance + 1`. Independent random draws essentially never land there. Correlated generation does (one multi-argument draw in eight). The joint shrink move then walks down the line to `(0, 1)`.
- **Rounding direction:** a three-argument property stating the EIP-4626 rule directly: redeem never pays more than the exact pro-rata amount.
- **Division by zero:** the property aborts instead of returning false, so the payload carries no input. Fuzzloom recovers it by bisecting on the run count, then replaying (see `spike/panic-recovery`).

## Properties that pass

These hold for all 10,000 generated inputs. A pass reports what it exercised, so it is a measured claim and not just a run count:

| Property | Edge-value argument draws | Correlated inputs | Argument extremes reached |
|---|---|---|---|
| `prop_fee_exact_never_exceeds_amount` | 2,471 of 10,000 | n/a (one argument) | both bounds |
| `prop_deposit_redeem_no_profit` | 7,489 of 30,000 | 1,237 | all six bounds |
| `prop_deposit_is_monotone` | 7,489 of 30,000 | 1,237 | all six bounds |

## A bug we did not plant

The first version of this example minted shares 1:1 whenever the share supply was zero. The round-trip property failed with the shrunk input `(assets 1, total_assets 1, total_supply 0)`: a vault holding donated assets but no shares lets the first depositor redeem the donation. That is the known ERC-4626 first-depositor issue. The model now uses virtual shares and assets (an offset of one, as in OpenZeppelin's ERC4626).

## Differential targets

`diff_*` functions are digested over 100,000 generated inputs on both backends:

| Target | sonatina vs native |
|---|---|
| `diff_mul_div` (u256 a * b / d) | agree |
| `diff_net_position` (i128 wrapping) | agree |
| `diff_fee` | agree |
| `diff_rounding_mode` | **differ** (planted: a rounding bias gated on `#[cfg(target)]`) |

`diff_fee` agrees even though `fee` is buggy, because it is wrong the same way on both backends.

A note on gas: `fe test` caps a test at 1e9 gas on the EVM backend. An earlier build of the sampler ran out of gas at 62,513 runs for `diff_net_position`. A naive comparison would have reported that as a backend mismatch. Fuzzloom treats out-of-gas as an infrastructure result, never as a divergence. After an optimisation, the same digest fits about 290,000 runs. Differential testing finds divergence between targets. Property testing finds wrong behaviour. They catch different bugs.

## Running it

```bash
fe test examples/vault-math       # the hand-written tests: all pass
```

The Fuzzloom CLI (in progress) discovers the `prop_*` and `diff_*` functions and runs them. Until then, the results above came from harnesses generated the same way the CLI will generate them.
