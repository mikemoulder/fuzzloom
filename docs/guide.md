# Fuzzloom guide

From a first property to a regression suite in CI. For how Fuzzloom works inside, see [architecture.md](architecture.md); for exact guarantees, see [algorithms.md](algorithms.md).

1. [Install and check](#1-install-and-check)
2. [Your first property](#2-your-first-property)
3. [Reading the results](#3-reading-the-results)
4. [Seeds and reproducibility](#4-seeds-and-reproducibility)
5. [Properties with effects](#5-properties-with-effects)
6. [Restricting input ranges](#6-restricting-input-ranges)
7. [Differential targets](#7-differential-targets)
8. [Saved failures as a regression suite](#8-saved-failures-as-a-regression-suite)
9. [Running in CI](#9-running-in-ci)
10. [Configuration](#10-configuration)
11. [Troubleshooting](#11-troubleshooting)
12. [Writing good properties](#12-writing-good-properties)

## 1. Install and check

Fuzzloom needs:
- [fe 26.6](https://fe-lang.org/getting-started/installation/) (`feup` installs it);
- Node 22.18 or newer;
- for `diff` and `--backend native`, fe's native backend. That backend runs on Linux and macOS. On Windows, install fe inside WSL as well, and Fuzzloom runs native tests there automatically.

No install step is needed beyond `npx`:

```bash
cd my-ingot
npx fuzzloom doctor
```

`doctor` checks each requirement and prints a fix for anything missing. It exits 2 if a required piece is missing. A missing native backend is only a warning, because only `diff` and `--backend native` need it.

## 2. Your first property

A property is a public function whose name starts with `prop_` and which returns `bool`. It states something that must be true for every input. Put it anywhere under your ingot's `src/`:

```fe
/// Fee charged on `amount`, rounded down: 30 basis points.
pub fn fee(_ amount: u64) -> u64 {
    amount.wrapping_mul(30) / 10000
}

/// The fee matches exact arithmetic for every amount.
pub fn prop_fee_matches_exact_math(_ amount: u64) -> bool {
    let exact: u128 = (amount as u128) * 30 / 10000
    (fee(amount) as u128) == exact
}
```

```bash
npx fuzzloom list            # confirm Fuzzloom sees it
npx fuzzloom fuzz --seed 7
```

```text
FAIL  prop_fee_matches_exact_math(u64)  counterexample at input 2
      amount = 614891469123651721
      shrunk from 4762291152399575021 in 1414 evaluations
      reproduce: fuzzloom reproduce prop_fee_matches_exact_math-0e05b819
```

`614891469123651721` is `u64::MAX / 30 + 1`, the smallest amount for which `amount * 30` wraps. The shrinker found the exact threshold, not just some large failing value.

**What can be an argument:** 1 to 3 arguments, each `u8`, `u16`, `u32`, `u64`, `u128`, `u256`, `i8`, `i16`, `i32`, `i64`, `i128`, `i256` or `bool`. Arguments may be positional (`_ amount: u64`) or labelled (`amount: u64`). A `prop_` function that does not fit is listed as skipped by `list` and `doctor`, with the reason:

```text
  skip  prop_addr  src/lib.fe:12  parameter "a" has type Address; supported: u8, u16, ...
```

## 3. Reading the results

`fuzz` prints one block per property:

| Status | Meaning | What to do |
|---|---|---|
| `PASS` | No input failed. The next line says what the campaign exercised: how many argument draws were edge values, how many inputs were correlated, and which argument bounds were reached | Nothing. If a bound was never reached, consider an [input range](#6-restricting-input-ranges) |
| `FAIL` | The property returned `false`. Shows the shrunk input, the original input and the shrink effort | Fix the code, or the property if the property is wrong |
| `ABORT` | The property panicked or reverted (overflow, division by zero, an `assert!`). The input was recovered by searching on the run count, then shrunk by replay | Same as `FAIL`. The panic reason is shown, such as `arithmetic overflow or underflow (Panic 0x11)` |
| `INFRA` | Something outside your property went wrong: a compile error, out of gas, a timeout, a missing backend, unreadable output | See [Troubleshooting](#11-troubleshooting). This is never a finding |

```text
ABORT prop_share_price_defined(u64, u64)  division or modulo by zero (Panic 0x12)  at input 13
      total_assets = 0
      total_supply = 0
      input recovered by k-ary search on the run count (Fe cannot catch an abort, so the payload carried none)
      shrunk by replay from 3770623262857372628, 0 in 1 fe runs (7 replays); 6 fe runs in total
```

A shrink that ran out of budget says `(budget reached, may not be minimal)`. The input shown still fails; it may just not be the smallest.

**Exit codes:** `0` all passed, `1` at least one `FAIL`, `ABORT` or `DIVERGE`, `2` at least one `INFRA`.

## 4. Seeds and reproducibility

Every run has a base seed. Without `--seed`, Fuzzloom picks one at random and prints it. Each property draws from its own stream, derived from the base seed and the property's name. The same seed, runs and code give the same inputs on every machine and on both backends. To repeat a differential run's checkpoint comparisons as well as its inputs, pass both the reported `--seed` and `--digest-key`.

To dig into one failure, `reproduce` replays the saved input directly, without generating anything:

```bash
npx fuzzloom reproduce prop_fee_matches_exact_math-0e05b819
```

## 5. Properties with effects

Fe passes state and context into functions as effects (`uses`). Fuzzloom supports this pattern directly. For each effect type a target uses, provide a public function whose name starts with `fixture_` and which returns that type:

```fe
pub struct Ledger { pub alice: u128, pub bob: u128, pub fees: u128 }

pub fn fixture_ledger() -> Ledger {
    Ledger { alice: 1000000, bob: 0, fees: 0 }
}

pub fn prop_overdraft_changes_nothing(_ amount: u128) -> bool
uses (ledger: mut Ledger, policy: FeePolicy) {
    let alice = ledger.alice
    if amount <= alice { return true }
    !transfer(amount, to_bob: true) && ledger.alice == alice
}
```

**How the fixture is found.**
1. Fuzzloom first looks for exactly one `pub fn fixture_*()` that returns the effect's type.
2. If there is none, it looks for exactly one fixture named after the type in snake case. For `uses (clock: Clock)` that is `fixture_clock`.

The second rule is for **trait** effects. The fixture returns any type that implements the trait:

```fe
pub trait Clock { fn now(self) -> u64 }
pub struct FixedClock { pub at: u64 }
impl Clock for FixedClock { fn now(self) -> u64 { self.at } }

pub fn fixture_clock() -> FixedClock { FixedClock { at: 1700000000 } }
```

**Fresh state every time.** A `prop_*` evaluation builds every effect from its fixture again. Evaluations never see each other's changes, so failure replay and shrink trials start from the same state. To check behavior across several calls that share a fixture, use [stateful sequences](#stateful-sequences).

**When a target is skipped.** A target whose effect has no fixture, or several, is skipped with the reason:

```text
  skip  prop_two   src/lib.fe:4  uses L, and more than one fixture builds it (fixture_a, fixture_b)
  skip  prop_none  src/lib.fe:5  uses Wallet, but the ingot has no `pub fn fixture_wallet() -> Wallet` to build it
```

**Where the types live.** The effect type must be defined in your ingot, or imported with a `use` line in the file that defines the target. `fuzzloom list` shows what each target uses and which fixture builds it:

```text
  prop  prop_transfer_conserves_supply(amount: u128, to_bob: bool)  src/lib.fe:54
        uses mut Ledger <- fixture_ledger(), FeePolicy <- fixture_policy()
```

### Stateful sequences

Starting in CLI version 0.1.3, name a step `pub fn seq_<name>(...) -> bool` and supply its usual `fixture_*()` functions. Arguments and range annotations follow the same rules as properties. The step performs one operation and returns the invariant result after that operation. All steps in a trace share the same effects. A new trace or shrink attempt starts with fresh fixtures.

```bash
node packages/cli/src/index.ts sequence examples/receipt-ledger --strict --seed 7 --runs 32
node scripts/check-sequence-workflow.mjs
```

The first command shrinks a four-step receipt failure to two posts of receipt 0. With `--steps 1`, all 32 traces pass. The second command verifies on both backends that the saved trace fails at step 2, passes after the fix, and regresses when the bug is restored. `reproduce` and `replay` use the saved actions in order. A panic during a sequence is an infrastructure outcome.

In an Fe test, `find_sequence` generates sequences of one to eight steps. Each step carries up to three bounded input words, so the first can select a command and the remaining words can provide its arguments. Provide an evaluator that creates a fresh fixture and calls `run_steps` inside its `with` block. The step function performs the operation and returns the invariant result after the operation.

```fe
fn evaluate_receipts(_ steps: Sequence) -> u64 {
    var ledger = ReceiptLedger { seen: 0, balance: 0, model: 0 }
    with (ReceiptLedger = ledger) { run_steps(steps, post_receipt) }
}

let result = find_sequence(
    evaluate_receipts,
    bounds: Bounds::full(3, 0, 0),
    arity: 1,
    max_steps: 8,
    seed: 7,
    runs: 20,
    budget: 100,
)
```

The Fe report contains the original sequence, the shrunk failure, and the 1-based failing step. Completed shrinking leaves no failing candidate among the tested contiguous power-of-two deletions or the floor and halfway moves on individual words and equal words in the same argument position. A panic from a step propagates through the test.

## 6. Restricting input ranges

By default every argument ranges over its whole type. When a bug only exists in a narrow, meaningful region, declare it with a doc-comment line above the function:

```fe
/// Vesting never releases more than the grant.
/// fuzzloom: start in 1668464000..=1700000000
pub fn prop_vested_never_exceeds_total(_ total: u128, start: u64) -> bool uses (clock: Clock) {
    vested(total, start) <= total
}
```

- `..=` includes the upper end and `..` excludes it. Values are written in the argument's type, in decimal or hex, and may contain underscores (`1_000_000`).
- The range applies everywhere: the campaign, abort recovery, mutation campaigns and differential digests. Shrinking stops at the lower end of the range instead of at zero.
- **Signed arguments:** the range must be centred on zero, `-k..=k` or `-(k+1)..=k`. Signed values are stored zigzag-encoded (0, -1, 1, -2, 2, ...), and only such ranges are one contiguous block. A range like `10..=20` on an `i64` is rejected with that explanation rather than silently approximated.
- Any malformed annotation skips the target with the reason, so a typo never widens a range without you noticing:

```text
  skip  prop_x  src/lib.fe:9  the range of "amount" does not fit u8
  skip  prop_y  src/lib.fe:14 the annotation names "amout", which is not an argument
```

In `examples/token-ledger`, this annotation turns a vesting overflow that 10,000 uniform inputs never reach into a failure at the first input.

## 7. Differential targets

A differential target is a public function whose name starts with `diff_` and which returns one of the supported types. It must return the same value on sonatina and native for every input:

```fe
pub fn diff_mul_div(_ a: u128, _ b: u128, _ d: u128) -> u256 {
    if d == 0 { return 0 }
    (a as u256) * (b as u256) / (d as u256)
}
```

```bash
npx fuzzloom diff --seed 7          # 100,000 inputs per target by default
```

```text
AGREE   diff_mul_div(u128, u128, u128) -> u256  100000 inputs, identical digests on sonatina and native
DIVERGE diff_rounding_mode(u64) -> u64  first at input 269, found in 3 search rounds, 8 fe runs in total
      x = 15398200176277126999
      sonatina returns 1539820017627712699
      native   returns 1539820017627712700
```

Targets may use effects and declared ranges exactly as properties do. `diff` needs the native backend; `doctor` tells you whether it is available.

**Choosing targets.** Good candidates are arithmetic helpers, encoding and decoding, rounding, anything with `#[cfg(...)]` branches, and anything that leans on wrapping or widening casts. Logic that only makes sense inside a deployed contract, such as anything calling `Evm` effects, does not compile on the native backend and cannot be a differential target.

**What a divergence means.** The two backends computed different values for the same Fe code and the same input. Either the code depends on something backend-specific (`#[cfg(target)]`, or behaviour your code relies on but the language leaves open), or one backend has a bug. Either way, the input and both outputs are what you need to file it.

## 8. Saved failures as a regression suite

Every `FAIL`, `ABORT` and `DIVERGE` is saved to `.fuzzloom/failures/<target>-<hash>.json`. The record holds the shrunk input, the original input, the seed, the iteration, the backend and the fe version, plus a human-readable value per argument. **Commit this directory.** It is a regression suite that grows on its own.

```bash
npx fuzzloom replay                 # re-check every saved failure
```

```text
FIXED  prop_withdraw_never_overdraws-2c81bbb3  now passes
FAILS  prop_fee_matches_exact_math-0e05b819    still fails
```

`replay` marks a record `fixed` when it passes. A record that was fixed and fails again is reported as `REGRESSED`. `--only <text>` limits replay to records whose target name contains the text.

**Mutation around saved failures.** On every later `fuzz`, each saved property or abort failure (open or fixed, up to the 8 most recent per property) also seeds a **mutation campaign**. The campaign runs thousands of small variations of the saved input: steps, bit flips, edge values, copies between arguments. A fix that only special-cases the saved input is caught there, because its neighbours still fail. A finding from a mutation campaign says which record it came from:

```text
FAIL  prop_x(u256)  counterexample at mutant 37 of saved failure prop_x-1a2b3c4d
```

`--no-corpus` turns mutation campaigns off for one run.

## 9. Running in CI

Exit codes make Fuzzloom a normal CI step: `1` fails the build on a finding, and `2` fails it on an infrastructure problem. Pin a seed for a deterministic check, or leave it random to explore further on every run. The seed is printed either way. `--junit` writes a report that test dashboards understand. Findings become `<failure>` and infrastructure problems become `<error>`, so a dashboard never shows out-of-gas as a broken property.

Starting in CLI version 0.1.3, add `--strict` to `fuzz`, `diff`, or `sequence` to turn skipped candidates in the selected command and `--only` scope into JUnit errors and exit 2 before any campaigns run. Campaign JSON includes selected, runnable, skipped, run and completed target counts. For fuzz and sequence, the input count stops at each reported first finding or the end of the successful campaign. For diff, it counts the input pairs in completed campaigns. It excludes auxiliary search rounds, mutation trials outside the reported outcome, and infrastructure outcomes.

GitHub Actions, on Linux so the native backend is available:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: "22" }
- name: Install Fe
  run: |
    curl -fsSL https://raw.githubusercontent.com/argotorg/fe/master/feup/feup.sh | bash -s -- --version v26.6.0
    echo "$HOME/.fe/bin" >> "$GITHUB_PATH"
- run: npx -y fuzzloom doctor
- run: npx -y fuzzloom replay --junit reports/replay.xml     # saved failures stay fixed
- run: npx -y fuzzloom fuzz --junit reports/fuzz.xml          # new inputs every run
- run: npx -y fuzzloom diff --junit reports/diff.xml          # sonatina against native
```

Fuzzloom's own pipeline, [`scripts/ci.sh`](../scripts/ci.sh), is a complete working example. It runs on CircleCI.

## 10. Configuration

Everything is a command-line option or an environment variable. There is no config file.

| Variable | Default | Purpose |
|---|---|---|
| `FE_BIN` | `~/.fe/bin/fe` (or `fe.exe`), else `fe` on `PATH` | The fe binary for sonatina, and for native on Linux and macOS |
| `FE_WSL_DISTRO` | the default WSL distro | Windows: the distro that runs native tests |
| `FE_WSL_BIN` | `~/.fe/bin/fe` | Windows: fe inside WSL |
| `FUZZLOOM_TIMEOUT_MS` | `600000` | Per `fe` invocation; a run past it is reported as `timeout` |
| `FUZZLOOM_INGOT` | the bundled copy | Use a different checkout of the Fe library |
| `NO_COLOR` | unset | Plain output |

## 11. Troubleshooting

**`INFRA ... out-of-gas`.** `fe test` caps each EVM test at 10^9 gas. Lower `--runs`, simplify the property, or run with `--backend native`, which has no gas.

**`INFRA ... compile`.** The generated harness did not compile. The first diagnostic is shown, and the generated ingot is kept in `.fuzzloom/tmp/` with its path printed. Usually the property's ingot itself fails `fe check`, or an effect type is not reachable. Run `npx fuzzloom doctor` and `fe check` on your ingot first.

**`Native backend: fe not runnable in WSL`.** Install fe inside your WSL distro (`feup` works there too), or point `FE_WSL_DISTRO` and `FE_WSL_BIN` at it. Only `diff` and `--backend native` need it.

**A property you wrote is missing from `list`.** It is either not `pub`, not named `prop_`/`diff_`, or skipped. Skipped functions are listed with the reason.

**`fe fmt --check` complains about `.fuzzloom/tmp`.** Generated harnesses are removed at the end of every command, and kept only after an infrastructure error. Delete the directory, or fix the infrastructure error and rerun.

## 12. Writing good properties

- **State the rule, not an example.** `fee(amount) <= amount` and "exact math agrees" catch whole classes of bugs. `fee(10000) == 30` catches one.
- **Compare against a reference.** A slow, obviously correct version (wider types, a loop) is the strongest oracle there is. `prop_fee_matches_exact_math` compares against `u128` arithmetic.
- **Round trips and inverses.** `decode(encode(x)) == x`, `redeem(deposit(x)) <= x`.
- **Conservation.** A transfer neither creates nor destroys tokens.
- **Monotonicity.** Depositing more never yields fewer shares; a schedule that started later has vested no more.
- **Guard preconditions by returning `true`.** If an input is outside the function's contract, `if amount > balance { return true }` keeps it from being reported. Prefer an [input range](#6-restricting-input-ranges) when the region is contiguous, so no runs are wasted.
- **Let aborts be findings.** A property does not need to catch overflow. An abort is reported with its input recovered, which is usually exactly the bug.
