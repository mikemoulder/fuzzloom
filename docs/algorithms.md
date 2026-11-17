# Algorithms and their guarantees

Every non-trivial algorithm in Fuzzloom states what it guarantees and where it stops, and has a test that fails if the guarantee breaks. This page collects them. Each section names its source and the tests that enforce it. Fe tests run on both the sonatina (EVM) and native backends; CLI tests run under Node.

1. [Random numbers](#1-random-numbers)
2. [Input encoding](#2-input-encoding)
3. [Input generation](#3-input-generation)
4. [Shrinking inside Fe](#4-shrinking-inside-fe)
5. [Recovering the input of an abort](#5-recovering-the-input-of-an-abort)
6. [Shrinking by replay](#6-shrinking-by-replay)
7. [Differential digests and checkpoints](#7-differential-digests-and-checkpoints)
8. [Mutation around saved failures](#8-mutation-around-saved-failures)
9. [Choosing the search width](#9-choosing-the-search-width)
10. [Classifying outcomes](#10-classifying-outcomes)

## 1. Random numbers

**Source:** [`ingots/fuzzloom/src/rng.fe`](../ingots/fuzzloom/src/rng.fe)

**Generator.** xorshift64\* (Vigna, 2014): one 64-bit state word, shifts and one multiplication. It is small and fast on both backends, and fully specified in the source, so a seed replays the same stream everywhere. A zero seed is remapped so the state is never stuck at zero.

**Per-property seeds.** `derive_seed(base, id) = splitmix64(base ^ splitmix64(id))`, where the CLI passes the 64-bit FNV-1a hash of the property name as `id`. Without this, every property in a run would draw the same stream and share its blind spots. A mutation campaign derives its seed from the property name together with the saved input.

**Uniform ranges.** `below_or_eq(max)` draws uniformly from `0..=max` by masked rejection sampling. It draws a value of `bit_len(max)` bits and accepts it when it is at most `max`, otherwise draws again. Each draw succeeds with probability above 1/2, so the expected number of draws is below 2. A full-width maximum such as `2^256 - 1` takes the mask path and never rejects. Maxima below 2^64 use one 64-bit draw per attempt.

| Guarantee | Test |
|---|---|
| Same seed, same stream; different seeds diverge; a zero seed is not stuck | `same_seed_same_stream`, `different_seeds_diverge`, `zero_seed_is_not_stuck` |
| The stream matches a recorded reference | `known_answer_vector`, `splitmix64_matches_reference_vectors` |
| No modulo bias. A range of about 2/3 of 2^256 is sampled uniformly, where reduction modulo `max + 1` would favour the lower third | `below_or_eq_is_unbiased_for_non_power_of_two_ranges` |
| Results never exceed `max`, including full-width maxima | `below_or_eq_respects_bound`, `below_or_eq_handles_full_width_maxima`, `full_width_maxima_use_the_exact_mask_path` |
| Derived seeds differ per property and per base seed | `derived_seeds_differ_per_property_and_base` |

**Limit:** not cryptographic. That is fine for test generation and wrong for anything else.

## 2. Input encoding

**Source:** [`word.fe`](../ingots/fuzzloom/src/word.fe), [`input.fe`](../ingots/fuzzloom/src/input.fe)

Generation, shrinking, payloads and records all work on `u256` words, so one generic runner serves every type. Unsigned integers map to themselves and `bool` maps to 0 and 1. Signed integers use **zigzag** encoding: 0, -1, 1, -2, 2 map to words 0, 1, 2, 3, 4. Word order then follows magnitude, so shrinking toward word 0 shrinks toward zero from both sides. The generic range edges also land on the signed edges: the top word is `MIN`, and the word below it is `MAX`.

An input is up to three words. Words past the property's arity are always zero. `Bounds` gives every argument an inclusive word range, and its lower end is also the shrink floor.

| Guarantee | Test |
|---|---|
| Every type round-trips at its maximum; every `i8` round-trips | `round_trips_at_the_type_maximum`, `signed_round_trip_every_i8`, `signed_round_trip_wide_values` |
| Zigzag order is magnitude order; extremes sit at the top words | `zigzag_orders_by_magnitude`, `zigzag_extremes_sit_at_the_top_words` |

**Consequence:** a contiguous signed range is only expressible as a contiguous word range when it is centred on zero. That is why `/// fuzzloom:` annotations on signed arguments must be `-k..=k` or `-(k+1)..=k`.

## 3. Input generation

**Source:** [`gen.fe`](../ingots/fuzzloom/src/gen.fe), [`bias.fe`](../ingots/fuzzloom/src/bias.fe), [`draw.fe`](../ingots/fuzzloom/src/draw.fe)

**Boundary bias.** Defects cluster at edges, so one argument draw in four (`Biased::of`, `every: 4`) comes from the edge table instead of the uniform range: `lo`, `hi`, `lo + 1`, `hi - 1`, the midpoint, and `lo + 2^k - 1`, `lo + 2^k`, `lo + 2^k + 1` for a random `k` that keeps the value in range.

**Correlation.** For two or more arguments, one draw in eight (`CORRELATE_EVERY`) sets argument 1 to argument 0, one above it, or one below it. If that value does not fit argument 1's bounds, the inverse relation is applied to argument 0 instead, so arguments of very different widths still correlate. Whole bug classes live on that diagonal: transfer to self, `amount == balance`, off-by-one between two inputs. Two independent 128-bit draws essentially never land on it.

**Determinism.** The input at iteration `i` is a pure function of (bounds, arity, seed, i). Every campaign, every recovery and every digest draws through the same `draw` function.

**Statistics.** A passing campaign reports how many argument draws were edge values, how many inputs were correlated, and a bitmask of which argument bounds were reached. A pass is therefore a measured claim, not just a run count.

| Guarantee | Test |
|---|---|
| Every draw respects every argument's bounds; unused words stay zero | `draws_respect_bounds_per_argument`, `unused_arguments_stay_zero`, `edges_stay_in_range` |
| Edges reach full-width extremes, and bias finds the top of `u64` far more often than uniform draws | `edges_hit_full_width_extremes`, `biased_finds_top_of_u64_far_more_than_uniform` |
| Correlation hits the diagonal, including across widths, and finds off-by-one bugs | `correlation_hits_the_diagonal_of_wide_arguments`, `correlation_works_across_argument_widths`, `correlated_generation_finds_off_by_one_between_arguments` |
| `generated_at(i)` reproduces the stream; tracking statistics does not change it | `generated_at_replays_the_stream`, `tracking_does_not_change_the_stream` |
| The statistics measure what was exercised | `stats_measure_what_the_campaign_exercised`, `passing_campaign_reports_what_it_exercised` |

**Limit:** the edge table is a fixed set of patterns, not learned from the code under test. Only the first two arguments are correlated.

## 4. Shrinking inside Fe

**Source:** [`shrink.fe`](../ingots/fuzzloom/src/shrink.fe)

When a property returns `false`, the campaign shrinks the failing input in the same test, within a budget of 5,000 evaluations (`SHRINK_BUDGET`).

**One argument**, in two phases, neither needing the failure to be monotone:

1. **Sweep:** try `lo, lo + 1, ..., lo + 255` (`SWEEP = 256`) and take the first that fails. Small counterexamples are the most readable, and this finds them exactly.
2. **Greedy descent:** from the best failing word, try the floor, then `best - 2^k` for `k` from the top bit of the distance down to 0. The first candidate that still fails becomes the new best, and the scan restarts. Exact powers of two matter. Steps of `best / 2^j` can all share a parity, which under zigzag means they all share a sign, and the descent would stall on the first input.

**Several arguments**, in rounds until a round changes nothing. Each round shrinks one coordinate at a time with the others fixed. It then tries three **joint moves**:
- all arguments to the floor;
- all distances divided by their gcd, or halved;
- all lowered by the same `2^k`.

Joint moves escape relations such as `a == b`, `b == a + 1` and `b == 2a`, where every single-coordinate move passes.

**Guarantee, when `complete` is true:** the result fails, and none of these passes, so the result is a local minimum under those moves:
- replacing one argument's word `w_i` by `w_i - 2^k >= lo_i`, with the others fixed;
- lowering every argument by the same `2^k`;
- dividing every distance by the gcd or by 2.

When the budget runs out, `complete` is false and the result is the best failing input found, which still fails.

| Guarantee | Test |
|---|---|
| A threshold failure shrinks to the exact threshold; everything-fails shrinks to the floor | `shrinks_threshold_failure_to_the_threshold`, `shrinks_to_floor_when_everything_fails` |
| Non-monotone failures are handled; a passing value is never returned | `handles_non_monotone_failures`, `never_returns_a_passing_value` |
| A complete result is a verified local minimum, checked by trying every move | `complete_result_is_a_verified_local_minimum`, `three_argument_result_is_a_coordinate_wise_local_minimum`, `complete_result_is_minimal_under_scaling_moves` |
| Joint moves escape diagonals and proportional relations | `joint_move_escapes_a_diagonal`, `proportional_relations_shrink_to_smallest_ratio` |
| The budget is respected; power-of-two steps cross parity (sign) | `respects_budget`, `power_of_two_steps_cross_parity` |

**Limit:** a local minimum, not necessarily the global one.

## 5. Recovering the input of an abort

**Source:** [`check.fe`](../ingots/fuzzloom/src/check.fe), [`packages/cli/src/engine.ts`](../packages/cli/src/engine.ts) (`recoverAbort`, `searchFirst`)

Fe cannot catch a panic or a revert. A property that overflows or divides by zero ends the test with a raw `Panic` payload and no input. Fuzzloom recovers the input anyway.

**Prefix consistency.** The campaign stream is deterministic and the campaign stops at its first failure. So a campaign of `k` runs aborts exactly when `k` is past the first aborting iteration. It cannot instead return a counterexample: the first failing input and its shrink are the same for every such `k`, so that shrink would abort too. "Aborts at `k` runs" is therefore false, then true, as `k` grows.

**k-ary search.** `searchFirst(lo, hi, width, probe)` finds the smallest `k` with a monotone predicate known true at `hi`. Each round probes up to `width` run counts in one batched `fe` run. The probes form the arithmetic progression `hi - s, hi - 2s, ...` with `s = floor((hi - lo) / (width + 1)) + 1`. Every gap between probes, and the gap below the lowest, then holds at most `floor((hi - lo) / (width + 1))` undecided values.

**Guarantee:** the exact smallest aborting run count, in at most `ceil(log_(width+1)(runs))` rounds. One more round asks for `input_at(iteration)`, which evaluates nothing and cannot abort, and `replay_at(iteration)` together. An abort from the replay means the property itself aborts on that input. A plain `false` means the property fails normally and the in-Fe shrinker hit an aborting candidate. Both cases are reported as such.

| Guarantee | Test |
|---|---|
| Failures are prefix-consistent in the campaign (and in mutation campaigns) | `prefix_consistent_failures`, `mutation_campaign_failures_are_prefix_consistent` |
| `generated_at` recovers the failing input | `generated_at_recovers_the_failing_input` |
| `searchFirst` returns the exact minimum within the round bound, swept over widths 1, 2, 7, 21 and 64, sizes up to 10,000 and dense answer positions | CLI: `searchFirst finds the exact minimum within the stated round bound` |
| The probes are evenly spaced and every gap meets the bound | CLI: `probePoints is an evenly spaced progression whose gaps meet the roundsFor bound` |

**Limit:** the property must be deterministic. Fixtures make effectful properties deterministic by building fresh state for every evaluation.

## 6. Shrinking by replay

**Source:** `shrinkByReplay`, `shrinkCandidates`, `jointCandidates` in [`engine.ts`](../packages/cli/src/engine.ts)

An aborting input cannot be shrunk inside Fe, because the abort ends the test. The CLI shrinks it by replaying candidates, all of one round in a single `fe` run. Candidates act on each argument's distance from its floor: the lower end of a declared range, else 0.

- **Single moves:** set one argument's distance to 0, or shift it right by 1, 2, 4, 8, and so on.
- **Joint moves**, offered when at least two distances are nonzero:
  - set every distance to 0;
  - divide every distance by their gcd `g`, and by each of 2, 3, 5 and 7 that divides `g`, or halve them all when `g` is 1;
  - subtract the same `d` from every distance, for `d` in `m`, 1, `m >> s` and `m - (m >> s)`, where `m` is the smallest distance.

Each round accepts the reproducing candidate with the fewest total bits, then the smallest sum. "Reproducing" demands the same failure: the same panic code or revert message for an abort. Shrinking therefore cannot slide onto a different bug.

**Guarantee, when complete:** no candidate move from the result reproduces, which makes it a local minimum under those moves. No candidate ever leaves the declared range. At most 8 rounds by default.

| Guarantee | Test |
|---|---|
| The result is a local minimum, checked by enumerating every move | CLI: `reaches the stated local minimum and never accepts a non-reproducing candidate` |
| Diagonal (`b == a + 1`) and proportional (`b == 2a`) failures that stall single moves are walked down | CLI: `joint moves walk a diagonal failure ...`, `joint moves follow a proportional failure ...` |
| The documented limit: `(96, 192)` for `b == 2a, a >= 3` ends at `(4, 8)`, a local minimum, not the global `(3, 6)` | CLI: same test |
| No candidate goes below a declared floor | CLI: `replay shrinking never leaves the declared range` |

## 7. Differential digests and checkpoints

**Source:** [`diff.fe`](../ingots/fuzzloom/src/diff.fe), `runDiffs` and `localiseDivergence` in [`engine.ts`](../packages/cli/src/engine.ts)

**Digest.** `fold(acc, out) = ((acc ^ out) * 0x100000001B3 + 0xCBF29CE484222325) mod 2^256`, starting from the offset, over a target's outputs on the campaign stream. The fold is order-sensitive, so the digest after `k` inputs is the same whatever the total run count. That makes "digests differ after `k` inputs" monotone in `k`.

**Checkpoints.** `checkpoints_within(t, bounds, seed, first, step, count)` folds once. It returns the digest after `first + j * step` inputs for every `j < count` (at most 256), as a `DynArray<u256>` payload. Fixed-size arrays are not allowed in Fe custom errors, so the payload uses `DynArray`, built with `MemVec`, which encodes identically on both backends.

**Search.** The first round asks each target for checkpoints at the first search round's probes, plus the full run count. If every checkpoint matches, the target agrees. Any mismatch is a proven divergence, so a fold collision at the final digest cannot hide one. Later rounds use the same arithmetic-progression probes as section 5, so one checkpoint test answers a whole round. A final round regenerates the first diverging input and evaluates it on both backends.

| Guarantee | Test |
|---|---|
| Each checkpoint equals the digest at its run count exactly | `every_checkpoint_equals_the_digest_at_its_run_count` |
| Checkpoints agree before the first differing output and differ from it on | `checkpoints_locate_the_first_differing_output` |
| The digest is the fold of exactly the generated inputs | `digest_is_the_fold_of_the_generated_inputs` |
| A single differing output changes the digest; seed and run count matter | `digest_detects_a_single_differing_output`, `digest_depends_on_seed_and_runs` |
| Both backends compute the same fold, generator and PRNG: one recorded constant checked on each | `known_answer_digest_matches_on_every_backend` |
| The real `Checkpoints` payload decodes and matches separate digest tests on both backends | CLI: `integration: real checkpoints equal separate digests, on both backends` |

**Limit:** the fold is a checksum, not a cryptographic hash. It detects a single differing output with overwhelming probability, but it is not designed against an adversary.

## 8. Mutation around saved failures

**Source:** [`mutate.fe`](../ingots/fuzzloom/src/mutate.fe)

A mutation campaign explores the neighbourhood of one saved input instead of the whole input space. Each mutant starts from the saved input, clamped into bounds, and stacks 1 to 4 operators (`MAX_STACK`):
- a small step up or down;
- a single bit flip;
- an edge value;
- halving or doubling the distance from the floor;
- a copy of another argument, plus or minus one;
- a fresh uniform draw.

Mutants never accumulate, so every one stays near the saved input. `fuzz` adds one mutation campaign per saved failure, up to 8 per property, to its first round.

**Why:** after a fix, the exact saved input passes. A fix that special-cases only that input leaves its neighbours failing. A fresh campaign almost never lands there again; a mutation campaign does.

| Guarantee | Test |
|---|---|
| Every mutant is within bounds, even from a corpus outside them; words past the arity stay zero | `mutants_stay_within_bounds`, `arguments_past_arity_stay_zero` |
| `mutated_at(i)` reproduces the stream, and failures are prefix-consistent | `mutated_at_reproduces_the_stream`, `mutation_campaign_failures_are_prefix_consistent` |
| It finds a 7-value incomplete-fix window around a `u256` corpus that a fresh 2,000-run campaign misses | `mutation_finds_an_incomplete_fix_that_fresh_campaigns_miss` |
| The copy operator reaches correlated neighbours | `copy_operator_reaches_correlated_neighbours` |

**Limit:** value-level operators only, with no dictionary of constants taken from the code under test. A seed uses the shrunk input, not the original.

## 9. Choosing the search width

**Source:** `chooseWidth`, `roundsFor` in [`engine.ts`](../packages/cli/src/engine.ts)

Every `fe test` invocation compiles its ingot once, about 2.4 s idle (`COMPILE_MS`), and each additional test costs about 85 ms (`CASE_MS`). `roundsFor(u, k)` is the worst-case number of rounds for `u` undecided values at width `k`. `chooseWidth` picks the `k` that minimises `roundsFor(u, k) * (COMPILE_MS + CASE_MS * k)`, up to 64. For 10,000 runs that is width 21 and 3 rounds, where plain bisection takes 14 steps. Differential search does not need this trade-off: one checkpoint test answers a whole round at width 256.

| Guarantee | Test |
|---|---|
| Bisection is the width-1 case (14 rounds for 10,000); width 21 needs 3 | CLI: `roundsFor and chooseWidth ...` |
| The first differential round fits one checkpoint test and leaves at most 39 of 10,000 run counts | CLI: `the first diff round fits one checkpoint case ...` |

**Limit:** the constants were measured on one machine. Under load the compile cost grows faster than the per-test cost, which shifts the best width by about 10%.

## 10. Classifying outcomes

**Source:** [`packages/cli/src/fe.ts`](../packages/cli/src/fe.ts), [`abi.ts`](../packages/cli/src/abi.ts)

`fe test` prints `PASS|FAIL [time] name` per test, in completion order, followed by that test's revert payload or halt reason. The CLI splits the output per test name and decodes each payload by its selector. Selectors are computed with keccak-256 from the signatures, never hardcoded.

| Outcome | Classified as |
|---|---|
| A Fuzzloom payload | a result |
| `Panic(uint256)` or `Error(string)` | an abort from the user's code |
| An `OutOfGas` halt | infrastructure: `out-of-gas` |
| A compile error | infrastructure: `compile`, applied to every test in that ingot |
| No result line for a test, `PASS` without a payload, an unknown selector, or a truncated payload | infrastructure: `unparsed` |
| A timeout or a missing native backend | infrastructure: `timeout`, `backend-unavailable` |

**Guarantee:** an infrastructure outcome is never reported as a failing property or a backend mismatch, and it stays attached to its own test.

| Guarantee | Test |
|---|---|
| Per-name parsing in completion order; out-of-gas stays on its own test; a missing name or a payload-less `PASS` is `unparsed` | CLI: `batch` tests in `fe.test.ts` |
| A compile error applies to every test | CLI: `batch output with a compile error applies it to every case` |
| A known selector with a truncated body is infrastructure, not a crash | CLI: `a known selector with a truncated body is infra, not a crash` |
