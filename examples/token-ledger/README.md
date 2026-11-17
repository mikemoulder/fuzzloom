# token-ledger

A two-account token with transfer fees and a vesting schedule, written the way Fe makes contract logic testable: the ledger state, the fee policy and the clock arrive as **effects** (`uses`). The same functions can run in a contract handler, and Fuzzloom drives them with fixtures.

```fe
pub fn prop_transfer_conserves_supply(_ amount: u128, to_bob: bool) -> bool
uses (ledger: mut Ledger, policy: FeePolicy) {
    let before = supply()
    transfer(amount, to_bob)
    supply() == before
}

pub fn fixture_ledger() -> Ledger { Ledger { alice: 1000000, bob: 0, fees: 0 } }
pub fn fixture_policy() -> FeePolicy { FeePolicy { bps: 25, min_fee: 5 } }
```

For each effect, Fuzzloom finds the `pub fn fixture_*()` that builds it. For a trait effect like `Clock`, it finds `fixture_clock()`, which returns the concrete `FixedClock`. Every evaluation gets fresh fixture values, so evaluations are independent and a saved failure replays exactly.

## Planted bugs

Both are marked `PLANTED BUG` in the source with the fix next to them. Both pass the three hand-written tests at the bottom of `src/lib.fe`.

| Property | Bug | Result with `fuzzloom fuzz --seed 7` |
|---|---|---|
| `prop_transfer_conserves_supply` | the minimum fee is not capped at the amount, so a transfer smaller than the fee underflows | aborts with `Panic(0x11)`; the input is recovered and shrunk to `amount = 0, to_bob = false` |
| `prop_vested_never_exceeds_total` | `total * elapsed` is computed in `u128` and overflows for grants above about 1.08e31 | aborts with `Panic(0x11)` at the first input; shrunk to `total = 15829941688929438697355903228009`, `start = 1668464001` |

The vesting bug is only reachable when the schedule started within the year before the fixture clock. A uniform `u64` start almost never lands in that window, so the property declares its range in a doc comment:

```fe
/// fuzzloom: start in 1668464000..=1700000000
pub fn prop_vested_never_exceeds_total(_ total: u128, start: u64) -> bool uses (clock: Clock) { ... }
```

Generation, input recovery, mutation and shrinking all stay inside that range. The shrunk `start` sits just above its lower end, not at 0. The shrunk `total` is a local minimum of the shrinker's moves, about 1.5 times the exact overflow threshold. It is not the threshold itself.

The two correct properties pass 10,000 inputs each. The differential target `diff_fee_quote`, which also uses an effect, gives identical digests on sonatina and native over 100,000 inputs.

With both fixes applied, `fuzzloom replay` reports both saved failures `FIXED`. A new `fuzz` run then passes all four properties, including the mutation campaigns around the two saved failures.

## Running it

```bash
fe test examples/token-ledger                                     # the hand-written tests: all pass
fuzzloom list examples/token-ledger                               # targets, their effects and fixtures
fuzzloom fuzz examples/token-ledger --seed 7
fuzzloom diff examples/token-ledger --seed 7                      # needs the native backend (Linux, macOS or WSL)
fuzzloom replay examples/token-ledger
```

From a source checkout, use `node packages/cli/src/index.ts` in place of `fuzzloom`.
