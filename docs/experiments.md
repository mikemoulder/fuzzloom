# Backend parity and sampling experiments

## Exact 8-bit shift oracle

Run `node scripts/check-shift-oracle.mjs` with Fe 26.6.0 (`5b3f96a`). The BigInt model computes left shift with multiplication and truncation, and arithmetic right shift with division rounded toward negative infinity. It generates exact expected bytes, then Fe compares every computed byte directly. Unsigned cases cover all 256 input bytes and all 256 shift counts. Signed cases cover all 256 input bytes and the 128 nonnegative counts representable by `i8`. Both operators are exercised on both backends.

| Operation | Exact comparisons per backend | Sonatina | Native |
| --- | ---: | --- | --- |
| `u8 <<` | 65,536 | Matched | Matched |
| `u8 >>` | 65,536 | Matched | Matched |
| `i8 <<` | 32,768 | Matched | Matched |
| `i8 >>` | 32,768 | Matched | Matched |
| Corrupted expected byte at input 0, count 0 | 1 | Detected | Detected |

The Fe harness still evaluates counts above the bit width. The expected table reuses row 8 because the reference saturates there. The negative control verifies that a disagreement reports the concrete input, expected byte, and observed byte.

## Published CLI against another Fe project

`bash scripts/check-external-ingot.sh /path/to/fuzzloom` creates a temporary consumer for the pinned [Fe Keccak ingot](https://github.com/fe-lang/keccak/tree/345d5088de986fe54b23a6aaa3a33e1c349d0960). The public npm 0.1.2 package discovered both targets. On Fe 26.6.0, each backend passed 32 streaming checks against the Ethereum Keccak-256 digest of `abc`, and 128 single-byte hash inputs agreed across the backends. The Fuzzloom pipeline includes this check. The upstream library remains an external dependency of this test.

## Fe integer semantics on Fe 26.6.0

`node scripts/check-integer-semantics.mjs` generates and compares Fe functions that call the compiler's actual integer operators. Seed 7 exercised 100,000 boundary-biased inputs per operation and type. All **116 keyed checkpoint campaigns** agreed across Sonatina and native, for **11.6 million input pairs**, and all **762 explicit edge evaluations** agreed. Backend agreement covers the sampled inputs and the reported outcomes.

| Operation | Signed widths | Unsigned widths | Inputs per operation and type | Campaigns agreeing |
| --- | --- | --- | ---: | ---: |
| Wrapping addition | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Wrapping subtraction | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Wrapping multiplication | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Left shift | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Arithmetic or logical right shift | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Division | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Remainder | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Exponentiation | 8, 16, 32, 64, 128, 256 | Same | 100,000 | 12/12 |
| Widen to 256 bits | 8, 16, 32, 64, 128 | Same | 100,000 | 10/10 |
| Truncate from 256 bits | 8, 16, 32, 64, 128 | Same | 100,000 | 10/10 |

For signed shifts the generator masks off the sign bit of the count. Explicit probes include width minus one, width, and width plus one where representable. Exponentiation limits the base and exponent to 0–3 to fit every type. Those campaigns repeatedly exercise a small domain. The division and remainder digests guard zero divisors and signed minimum divided by minus one so a trap cannot discard the checkpoint stream. The explicit evaluations exercise the original operations at those inputs. Both backends returned panic `0x11` for signed minimum divided by minus one at all six widths, and panic `0x12` on 84 division or remainder evaluations with zero divisors. Both returned zero for signed minimum modulo minus one.

The JSON report records the fixed comparison key, every operation and result, and each explicit edge outcome. Matching fingerprints can collide. The operator matrix also does not establish whether two agreeing backends implement the language specification correctly.

## Paired uniform sampling baseline

`node scripts/measure-sampling.mjs sonatina` and `node scripts/measure-sampling.mjs native` ran seeds 1–20 on the six planted failures in vault-math and token-ledger. Each seed and sampler had a budget of 10,000 inputs and used the property's declared bounds. The measurement disables mutation and shrinking. For aborts, it recovers the first failing prefix in batched Fe runs and counts those invocations. The two backends produced identical rows, including the first failure positions and run counts. Each backend used 28 actual Fe invocations across 240 trials. A trial's Fe run count measures participation in shared invocations.

| Target | Biased hits | Biased median first input | Biased Fe runs per trial | Uniform hits | Uniform median first input | Uniform Fe runs per trial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `prop_fee_matches_exact_math` | 20/20 | 1 | 1 | 20/20 | 1 | 1 |
| `prop_withdraw_never_overdraws` | 20/20 | 20.5 | 1 | 0/20 | — | 1 |
| `prop_redeem_rounds_toward_vault` | 20/20 | 1 | 1 | 20/20 | 1 | 1 |
| `prop_share_price_defined` | 20/20 | 18.5 | 2–17 | 0/20 | — | 1 |
| `prop_transfer_conserves_supply` | 20/20 | 4 | 2–11 | 0/20 | — | 1 |
| `prop_vested_never_exceeds_total` | 20/20 | 1 | 2–7 | 20/20 | 1 | 2 |

The [paired results CSV](sampling-results.csv) records each seed, whether it found a failure, the first input when found, and the Fe run count for each sampler. The clearest wins came from inputs requiring a particular edge or a relation across arguments. The vesting defect already had a narrow declared range, and uniform sampling found it at the first input for all 20 seeds.
