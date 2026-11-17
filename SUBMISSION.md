# Fuzzloom

**Pitch:** Fuzzloom is property-based testing and fuzzing for Fe. It tries thousands of generated inputs on every property inside Fe, shrinks each failure to a small counterexample, saves it for replay, and pins the first input on which the EVM (sonatina) and native backends disagree.

- Website and docs: https://fuzzloom.pages.dev
- Repository: https://github.com/MikeMoulder/fuzzloom
- npm: https://www.npmjs.com/package/fuzzloom (`npx fuzzloom`)

## The problem

Fe developers test with hand-picked examples. Smart-contract bugs live in the inputs nobody picked: the top of `u64`, an amount exactly one above a balance, a supply of zero.

Fe also compiles one program for two very different machines, the sonatina EVM backend and the native backend. They are meant to agree on every input, and nothing checked that they do.

Fe had no property-based testing tool we could find, and porting one is not enough. On the EVM backend a test can only report through a revert, a panic carries no input, and every test is capped at 10^9 gas. A fuzzer for Fe has to be designed around those constraints.

## Approach

Everything was built during the contest:

- **A Fe library of testing algorithms** (`ingots/fuzzloom`): a seeded xorshift64\* generator with unbiased range sampling, boundary-biased and correlated input generation, a shrinker with a stated local-minimum guarantee, mutation campaigns around saved inputs, and order-sensitive digests with up to 256 checkpoints per test for backend comparison. It runs inside `fe test`, on both backends.
- **A TypeScript CLI** (`packages/cli`, published to npm), with these commands:
  - `doctor`, `list`, `fuzz`, `diff`, `reproduce` and `replay`.
  - It discovers `prop_*` and `diff_*` functions with no configuration.
  - It generates test harnesses, runs `fe test` in batched rounds (both backends at the same time) and decodes results by ABI selector.
  - It recovers the input of an abort by k-ary search on the run count, and shrinks it by replay.
  - It saves every failure as a regression record.
  - It reports through the terminal, `--json` and JUnit XML.
- **Three examples:**
  - `vault-math`: four planted bugs and a `#[cfg(target)]` backend divergence.
  - `token-ledger`: effects, fixtures and a declared input range, two planted bugs.
  - `amm-swap`: nothing planted. A swap quote written in a live session, exactly as first drafted, and tested with the published `npx fuzzloom`.
- **A website** with the docs generated from the repository's markdown, plus `llms.txt`.

Measured results, all reproducible with `--seed 7` and asserted by CI on every push:

| Example | Result |
|---|---|
| vault-math, `fuzz` | 4 of 4 planted bugs found and shrunk, including an off-by-one that only lies on `amount == balance + 1` (shrunk to `(0, 1)`) and a division by zero whose input was recovered from a panic and shrunk to `(0, 0)` |
| vault-math, `diff` | the planted divergence pinned at input 269 of 100,000, with both outputs, in 8 single-test `fe` runs |
| token-ledger, `fuzz` | both planted bugs found: a fee underflow (shrunk to `amount = 0`) and a `u128` overflow reachable only through the declared range |
| amm-swap, `fuzz` | a real first draft: all 3 properties abort because `amount_in * 997 * reserve_out` overflows `u64`, recovered and shrunk to `(2358, 1, 10312385981465)`. A first fix in `u128` passed `replay` but failed the fresh campaign (the numerator needs 138 bits); with `u256` all 3 pass and `diff` agrees on both backends |
| An unplanted bug | the vault model's first version had the ERC-4626 first-depositor issue, found by the round-trip property |

## Fe highlight

**Effects pass straight through generic code.** A property is any `Fn` returning `bool`. The wrapper forwards the callable's effect row, so the library never needs to know which effects a user's code has:

```fe
impl<A: Word, F: Fn(A) -> bool> Property for Prop1<A, F> {
    uses E = F::E

    fn holds(self, _ x: Input) -> bool uses E {
        (self.f)(A::from_word(x.w0))
    }
}
```

A user's property can then declare state and context as effects:

```fe
pub fn prop_transfer_conserves_supply(_ amount: u128, to_bob: bool) -> bool
uses (ledger: mut Ledger, policy: FeePolicy) { ... }
pub fn fixture_ledger() -> Ledger { Ledger { alice: 1000000, bob: 0, fees: 0 } }
```

Fuzzloom generates a harness that builds every effect fresh from its fixture and provides it with a `with` block. Each input therefore gets fresh state, and a saved failure replays exactly, on both backends:

```fe
check(prop2(|a0: u128, a1: bool| {
    var e0 = fixture_ledger()
    var e1 = fixture_policy()
    with (Ledger = e0, FeePolicy = e1) { prop_transfer_conserves_supply(a0, to_bob: a1) }
}), seed: derive_seed(7, 0x141e458f861379f9), runs: 10000)
```

Two more Fe-specific pieces:
- **Revert payloads as the result channel.** Every library entry point ends with one ABI-encoded `#[error]`, and the CLI decodes it by selector.
- **Checkpoint digests.** They travel in a `DynArray<u256>` payload, built from a `MemVec`, which encodes identically on sonatina and native.

## Architecture

```text
your ingot (prop_*, diff_*, fixture_*, /// fuzzloom: ranges)
        |  discovered by
        v
packages/cli  discover -> engine (rounds, k-ary search, replay shrinking) -> harness generator
        |  writes a throwaway ingot importing your ingot and ingots/fuzzloom, runs
        v
fe test  (sonatina and native, concurrently)  -> PASS/FAIL + revert payload per test
        |  decoded by selector (abi.ts), classified (fe.ts)
        v
results, .fuzzloom/failures/*.json, terminal / --json / --junit
```

- `ingots/fuzzloom` holds every algorithm: `rng`, `word`, `input`, `gen`, `bias`, `draw`, `property`, `shrink`, `check`, `mutate`, `diff`, `payload`.
- The CLI only searches for what Fe cannot report back: the input of an abort, shrinking by replay, and comparing two backends.
- Details: [docs/architecture.md](docs/architecture.md). Every guarantee and limit, with the test that enforces it: [docs/algorithms.md](docs/algorithms.md).

## Build and test

```sh
fe --version   # fe 26.6.0 (5b3f96a)
fe check       # the library and the three examples type-check
fe test        # 94 tests on sonatina; add --backend native on Linux/macOS for the same 94
fe build       # prints "No contracts found to build": Fuzzloom is a library and a CLI, it has no contracts
```

The CLI needs Node 22.18 or newer:

```sh
npm ci
npm run typecheck && npm test                              # 67 CLI tests, including integration through real fe
node packages/cli/src/index.ts fuzz examples/vault-math --seed 7
bash scripts/ci.sh                                         # the whole pipeline, as CI runs it
```

- **Native backend:** needed by `diff` and `--backend native`. It runs on Linux and macOS; on Windows, Fuzzloom runs it inside WSL.
- **Install Fe:** `curl -fsSL https://raw.githubusercontent.com/argotorg/fe/master/feup/feup.sh | bash -s -- --version v26.6.0`.
- **CI:** `scripts/ci.sh` runs on CircleCI. It installs Fe, checks formatting, runs both test suites on both backends, packs the npm package and runs it outside the repository, and asserts the three examples' seed-7 results.

## Demo

Reproducible from a clean checkout. No install step is needed, since the CLI has no runtime dependencies and Node 22.18 runs its TypeScript directly:

```sh
node packages/cli/src/index.ts doctor examples/vault-math
node packages/cli/src/index.ts fuzz examples/vault-math --seed 7    # 3 passed, 4 failed (the four planted bugs)
node packages/cli/src/index.ts diff examples/vault-math --seed 7    # 3 agreed, 1 diverged at input 269
node packages/cli/src/index.ts fuzz examples/token-ledger --seed 7  # 2 passed, 2 failed (effects and a declared range)
node packages/cli/src/index.ts fuzz examples/amm-swap --seed 7      # 0 passed, 3 failed (a real u64 overflow, found live)
```

In your own ingot, outside this repository, the same commands are `npx fuzzloom doctor`, `npx fuzzloom fuzz` and so on.

The website shows the same runs: https://fuzzloom.pages.dev. Each example's README lists its measured results and the fixes that turn the saved failures `FIXED` under `npx fuzzloom replay`.

## Limitations

- **Fuzzing is not a proof.** A passing campaign means 10,000 well-chosen inputs found nothing, and the report says what they exercised.
- **Inputs:** integers and `bool` only, 1 to 3 arguments per property. No structs, arrays, addresses or strings yet.
- **No sequences of calls:** each input gets fresh fixtures by design, which keeps replay exact.
- **No coverage guidance:** generation is boundary-biased and correlated, and mutation is seeded from saved failures.
- **`diff` compares shared logic, not deployed contracts**, because a deployment has no native counterpart.
- **Both shrinkers reach a stated local minimum, not the global one.**
- **Verified on Linux, and on Windows with WSL.** macOS uses the same code paths but was not run.
- **Known compiler crash:** an `Fn` impl with a forwarded effect row, called through a generic `Fn` bound, crashes fe 26.6 (`error[16-0004]`). The library avoids that shape. A minimal reproduction is in `spike/compiler-bugs/`; it has not been filed upstream yet.

## Declaration

- **Pre-existing work:** none. The repository starts at [7f90342](https://github.com/MikeMoulder/fuzzloom/commit/7f90342) on 16 November 2026, and every line was written during the contest.
- **Third-party code:**
  - The repository contains no third-party code. Its Keccak-256 (`packages/cli/src/keccak.ts`) was written for the project from the published constants.
  - The CLI has no runtime dependencies. Its development dependencies are TypeScript and `@types/node`.
  - The website ([fuzzloom-site](https://github.com/MikeMoulder/fuzzloom-site), a separate repository) uses the [taste-skill](https://github.com/Leonxlnx/taste-skill) design kit (MIT, its licence included), SVG Logos icons (CC0) and Google Fonts.
- **AI assistance:**
  - The project was built with Claude Code, Anthropic's coding agent, using Claude models. It wrote most of the code, tests and documentation in this repository and the website's, working in the repository under the author's direction.
  - The author chose the project and its scope, set the working rules, made the product decisions, and handled the accounts: GitHub, npm publishing, Cloudflare and contest registration.
  - Every result reported here comes from runs in the repository, and CI reruns the examples on every push.

## Team

Mike Moulder ([@MikeMoulder](https://github.com/MikeMoulder)).

## License

Apache License 2.0 ([LICENSE](LICENSE)).
