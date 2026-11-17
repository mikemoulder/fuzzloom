# fuzzloom

Property-based testing, fuzzing and EVM/native differential testing for [Fe](https://fe-lang.org).

Write properties as ordinary Fe functions. Fuzzloom generates inputs with a deterministic, boundary-biased generator written in Fe. It shrinks failures to small counterexamples, saves them for replay, and checks that a function behaves the same on Fe's EVM (sonatina) and native backends.

```bash
npx fuzzloom doctor          # check fe, the native backend and your project
npx fuzzloom fuzz            # run every prop_* property in the current ingot
npx fuzzloom diff            # compare every diff_* target on sonatina and native
npx fuzzloom replay          # re-run saved failures as regression checks
```

## Writing properties

```fe
/// fuzzloom: amount in 1..=1000000
pub fn prop_transfer_conserves_supply(_ amount: u128, to_bob: bool) -> bool
uses (ledger: mut Ledger, policy: FeePolicy) {
    let before = supply()
    transfer(amount, to_bob)
    supply() == before
}

pub fn fixture_ledger() -> Ledger { Ledger { alice: 1000000, bob: 0, fees: 0 } }
pub fn fixture_policy() -> FeePolicy { FeePolicy { bps: 25, min_fee: 5 } }
```

- `pub fn prop_<name>(args) -> bool` is a property. `pub fn diff_<name>(args) -> T` is a differential target.
- Arguments: 1 to 3 of `u8` to `u256`, `i8` to `i256`, or `bool`.
- Effects (`uses`) are provided by a `pub fn fixture_*()` per effect type, fresh for every evaluation.
- `/// fuzzloom: <arg> in <lo>..=<hi>` restricts an argument's range.
- A function that matches the naming convention but cannot be tested is listed with the reason, never silently skipped.

## Requirements

- Node 22.18 or newer.
- [fe 26.6](https://fe-lang.org/getting-started/installation/).
- `diff` and `--backend native` need fe's native backend, which runs on Linux and macOS. On Windows, Fuzzloom uses fe inside WSL.

Fuzzing finds bugs. It does not prove their absence.

Documentation: https://fuzzloom.pages.dev/docs/ · Source and examples: https://github.com/MikeMoulder/fuzzloom (Apache-2.0).
