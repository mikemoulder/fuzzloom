# vault-math

Share accounting for a tokenized vault (ERC-4626 style), with four planted bugs. Every hand-written test in the file passes. Fuzzloom finds all four, and shrinks each to a minimal input you can read.

## The planted bugs

| Property | Arguments | Bug | `fuzzloom fuzz --seed 7` (10,000 inputs each) |
|---|---|---|---|
| `prop_fee_matches_exact_math` | `amount: u64` | fee multiplication wraps above `u64::MAX / 30` | found at input 2, shrunk to `614891469123651721`, exactly the first amount that wraps |
| `prop_withdraw_never_overdraws` | `balance: u128, amount: u128` | off by one: allows `amount == balance + 1` | found at input 19, shrunk to `(0, 1)` |
| `prop_redeem_rounds_toward_vault` | `shares, total_assets, total_supply: u64` | redeem rounds up, in favour of the user | found at input 1, shrunk to `(1, 0, 1)`: redeeming 1 share of an empty vault pays 1 |
| `prop_share_price_defined` | `total_assets, total_supply: u64` | no guard for zero supply | aborts with `Panic(0x12)` at input 13; input recovered by bisection and shrunk by replay to `(0, 0)` |

Each bug is marked `PLANTED BUG` in `src/lib.fe` with its fix next to it. With all four fixes applied, all seven properties pass 10,000 runs.

How each one gets found:

- **Wrapping fee:** boundary-biased generation reaches the top of `u64`. Shrinking then walks down to the exact threshold, because the failure is monotone above it.
- **Off-by-one withdraw:** the only failing inputs are on the line `amount == balance + 1`. Independent random draws essentially never land there. Correlated generation does (one multi-argument draw in eight). The joint shrink move then walks down the line to `(0, 1)`.
- **Rounding direction:** a three-argument property stating the EIP-4626 rule directly: redeem never pays more than the exact pro-rata amount.
- **Division by zero:** the property aborts instead of returning false, so the payload carries no input. Fuzzloom recovers it by bisecting on the run count (16 `fe` runs), confirms it by replay, then shrinks it by replay to `(0, 0)`.

## Properties that pass

These hold for all 10,000 generated inputs. A pass reports what it exercised, so it is a measured claim and not just a run count:

| Property | Edge-value argument draws | Correlated inputs | Argument extremes reached |
|---|---|---|---|
| `prop_fee_exact_never_exceeds_amount` | 2,483 of 10,000 | n/a (one argument) | both bounds |
| `prop_deposit_redeem_no_profit` | 7,490 of 30,000 | 1,286 | all six bounds |
| `prop_deposit_is_monotone` | 7,565 of 30,000 | 1,330 | all six bounds |

## A bug we did not plant

The first version of this example minted shares 1:1 whenever the share supply was zero. The round-trip property failed with the shrunk input `(assets 1, total_assets 1, total_supply 0)`: a vault holding donated assets but no shares lets the first depositor redeem the donation. That is the known ERC-4626 first-depositor issue. The model now uses virtual shares and assets (an offset of one, as in OpenZeppelin's ERC4626).

## Differential targets

`fuzzloom diff --seed 7` digests each `diff_*` function over 100,000 generated inputs on both backends:

| Target | sonatina vs native |
|---|---|
| `diff_mul_div` (u256 a * b / d) | agree |
| `diff_net_position` (i128 wrapping) | agree |
| `diff_fee` | agree |
| `diff_rounding_mode` | **diverges** at input 269: for `x = 15398200176277126999`, sonatina returns `1539820017627712699` and native returns `1539820017627712700` (planted: a rounding bias gated on `#[cfg(target)]`) |

`diff_fee` agrees even though `fee` is buggy, because it is wrong the same way on both backends.

A note on gas: `fe test` caps a test at 1e9 gas on the EVM backend. An earlier build of the sampler ran out of gas at 62,513 runs for `diff_net_position`. A naive comparison would have reported that as a backend mismatch. Fuzzloom treats out-of-gas as an infrastructure result, never as a divergence. After an optimisation, the same digest fits about 290,000 runs. Differential testing finds divergence between targets. Property testing finds wrong behaviour. They catch different bugs.

## Running it

```bash
fe test examples/vault-math                                    # the hand-written tests: all pass
node packages/cli/src/index.ts list examples/vault-math        # what Fuzzloom found to test
node packages/cli/src/index.ts fuzz examples/vault-math --seed 7
node packages/cli/src/index.ts diff examples/vault-math --seed 7   # needs a native host (Linux, macOS, or WSL)
```

Each failure is saved under `examples/vault-math/.fuzzloom/failures/`. Apply the four fixes, then run:

```bash
node packages/cli/src/index.ts replay examples/vault-math
```

The four property failures are reported `FIXED`. Revert a fix and they come back as `REGRESSED`.

Each property gets its own seed, `derive_seed(7, fnv1a64(name))`, so properties in one run do not share an input stream.
