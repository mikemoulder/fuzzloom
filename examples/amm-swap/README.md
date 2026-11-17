# amm-swap

The quote of a constant-product pool (x * y = k) with a 0.3% swap fee, the formula a Uniswap v2 style pair uses. Unlike the other two examples, nothing here was planted. This is a first draft exactly as it was written in a live session, and its bug was found by Fuzzloom on the first run.

## The session

The draft computes the quote in `u64`. Both hand-written tests pass. Three properties state what any AMM quote must satisfy:

| Property | Statement |
|---|---|
| `prop_swap_never_drains_pool` | a swap never pays out the whole output reserve |
| `prop_swap_keeps_k` | after a swap, `reserve_in * reserve_out` never shrinks |
| `prop_more_in_never_less_out` | paying more never buys less |

**1. The draft, `u64` math.** `fuzzloom fuzz --seed 7` (10,000 inputs per property): 0 passed, 3 failed. All three abort with `Panic 0x11`, because Fe's arithmetic is checked and `amount_in * 997 * reserve_out` overflows `u64`. An abort carries no input, so each one was recovered by k-ary search on the run count, then shrunk by replay:

| Property | Shrunk input `(amount_in, reserve_in, reserve_out)` |
|---|---|
| `prop_swap_never_drains_pool` | `(346542353, 3, 112557045)`, reported as "round budget reached, may not be minimal" |
| `prop_swap_keeps_k` | `(2358, 1, 10312385981465)` |
| `prop_more_in_never_less_out` | `(268431361, 1, 134217457)` |

The second line is a small trade: 2,358 units into a pool holding 10^13 units of the output token. For scale, with 18 decimals 10^13 units is 0.00001 of a token, and against any reserve above about 1.85 × 10^16 units even a 1-unit swap overflows (997 × reserve passes `u64::MAX`).

**2. First fix, `u128` math.** `fuzzloom replay` reported all three saved failures `FIXED`. The fresh campaign that followed failed all three properties again, now only on huge inputs, for example `(744223889797177505, 1, 576460752224809602)`. `amount_in * 997` needs up to 74 bits and the numerator up to 138, past `u128`. Replaying the saved failures alone would have missed this.

**3. The fix, `u256` math**, as Uniswap v2 does with `uint256` (written next to the bug in `src/lib.fe`):

- `replay`: all 6 saved failures (3 from the draft, 3 from the `u128` attempt) `FIXED`.
- `fuzz --seed 7`: 3 passed, 0 failed. Per property, about 7,400 of 30,000 argument draws were edge values, about 1,250 inputs were correlated, all 6 argument bounds were reached, and 2 mutation campaigns of 10,000 mutants around the saved failures also passed.
- `diff --seed 7` on the fixed quote (a `diff_amount_out` target): `AGREE`, 100,000 inputs, identical digests on sonatina and native.

A passing campaign is evidence, not proof: it means those inputs, with the coverage reported above, found nothing.

## Running it

```bash
node packages/cli/src/index.ts fuzz examples/amm-swap --seed 7   # 0 passed, 3 failed: the overflow
```

Apply the `u256` fix written above `get_amount_out`, then:

```bash
node packages/cli/src/index.ts replay examples/amm-swap          # the saved failures report FIXED
node packages/cli/src/index.ts fuzz examples/amm-swap --seed 7   # 3 passed
```

In your own ingot the same commands are `npx fuzzloom fuzz`, `npx fuzzloom replay` and so on. This session used the published `fuzzloom@0.1.0` from npm, in a project outside this repository.
