# Changelog

All notable changes to Fuzzloom. The project follows [semantic versioning](https://semver.org); while the version is 0.x, minor versions may change behaviour.

## Unreleased

### Security

Found in a security audit of the CLI, each confirmed with a working exploit, fixed, and covered by a regression test that replays it:

- A saved failure whose `id` contained `../` made `replay` and `reproduce` write a JSON file anywhere, with any content (for example a neighbouring project's `package.json` with an install script). Records are now validated, must match their file name, and are rebuilt from known fields before saving.
- A project shipping `.fuzzloom` as a symlink made Fuzzloom write outside it, and a run with no properties deleted the `tmp` directory the link pointed at. Symlinked `.fuzzloom`, `.fuzzloom/tmp` and `.fuzzloom/failures` are now refused.
- On Windows, a quote in the project path broke out of the command Fuzzloom ran inside WSL for the native backend, and could run commands there. WSL is now invoked with `-e` and the path as a separate argument, so paths with quotes also work.
- A malformed file in `.fuzzloom/failures` no longer aborts `fuzz` and `replay`; it is skipped with a warning. Text from records is stripped of control characters before it is printed.

### Examples

- `amm-swap`: a Uniswap v2 style swap quote, exactly as first drafted in a live session. Nothing planted: `fuzz` finds a real `u64` overflow on the first run, and the README records a `u128` fix that `replay` accepted but a fresh campaign rejected. CI asserts its seed-7 result.

## 0.1.0 (2026-11-17)

First release, published to npm as [`fuzzloom`](https://www.npmjs.com/package/fuzzloom).

### Fe library (`ingots/fuzzloom`)

- xorshift64\* generator with splitmix64 per-property seed derivation and unbiased masked rejection sampling.
- `Word` encoding for `u8` to `u256`, `i8` to `i256` (zigzag) and `bool`; properties of 1 to 3 arguments.
- Boundary-biased generation (one draw in four from the edges) and correlated multi-argument draws (one in eight).
- Shrinking: an exact small-value sweep, greedy power-of-two descent and joint moves (floor, gcd or halving, equal offsets), with a stated local-minimum guarantee.
- Prefix-consistent campaigns, so the input of an abort can be recovered from outside.
- Mutation campaigns around a saved input, within bounds and prefix-consistent.
- Differential digests and up to 256 checkpoints per pass (`DynArray` payload).
- Bounded variants of every entry point for declared input ranges.
- Properties and targets may use effects; the wrappers forward the callable's effect row.

### CLI (`fuzzloom`)

- Commands: `doctor`, `list`, `fuzz`, `diff`, `reproduce`, `replay`.
- Zero-configuration discovery of `prop_*` and `diff_*` functions anywhere under `src/`, with every unsupported function reported with its reason.
- Effects provided by `fixture_*()` functions, fresh for every evaluation.
- `/// fuzzloom: <arg> in <lo>..=<hi>` input ranges.
- Batched rounds, with sonatina and native running at the same time.
- Abort recovery by k-ary search, with the width chosen from a measured cost model.
- Shrinking by replay with single and joint moves, floor-aware.
- Differential search by checkpoint rounds: the first divergence in 100,000 inputs in 8 single-test `fe` runs.
- Saved failures in `.fuzzloom/failures/`. `replay` reports `FIXED`, `FAILS` or `REGRESSED`, and saved failures seed mutation campaigns.
- Strict outcome classification: compile errors, out-of-gas, timeouts, a missing backend and unreadable output are infrastructure errors (exit code 2), never findings.
- Terminal, `--json` and `--junit` output.
- Native backend through WSL on Windows.

### Examples

- `vault-math`: four planted bugs and four differential targets, including a `#[cfg(target)]` divergence.
- `token-ledger`: effects, fixtures and a declared range, two planted bugs.
