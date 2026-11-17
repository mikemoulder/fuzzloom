# Contributing to Fuzzloom

Thank you for helping. Fuzzloom is a testing tool, so the bar for its own claims is high. The one rule that outranks the rest:

> **A claim needs a test.** A new algorithm states its guarantee and its limit in a doc comment, and comes with a test that fails when the guarantee breaks. A new result in the README or docs comes from a command anyone can rerun.

## Set up

You need [fe 26.6](https://fe-lang.org/getting-started/installation/) and Node 22.18 or newer. The native backend needs Linux or macOS; on Windows, install fe inside WSL too.

```bash
git clone https://github.com/MikeMoulder/fuzzloom && cd fuzzloom
npm ci
node packages/cli/src/index.ts doctor examples/vault-math
```

## Run the tests

```bash
fe test --color never                       # every Fe test (library and examples) on sonatina
fe test --backend native --color never      # the same on native (Linux/macOS)
bash scripts/test-both.sh                   # both backends; uses WSL for native on Windows
npm run typecheck && npm test               # the CLI: unit tests and integration tests through real fe
bash scripts/ci.sh                          # everything CI runs, including packaging and the three seeded demos
```

A change to the Fe library is verified on **both** backends before it is merged. A change to an example must keep its documented seed-7 results, which `scripts/ci.sh` asserts, or update the example's README and the assertion together.

## Where things live

| Change | Where |
|---|---|
| Generation, shrinking, mutation, digests, payloads | `ingots/fuzzloom/src/*.fe` |
| Discovery, harnesses, searches, output parsing | `packages/cli/src/*.ts` |
| A new payload | `payload.fe` and `abi.ts` together; the field order is a contract |
| Examples | `examples/*`, each with a README of measured results |

See [docs/architecture.md](docs/architecture.md) for how the pieces fit.

## Style

- Fe: `fe fmt`. TypeScript: the existing style, with no runtime dependencies.
- Every infrastructure outcome stays an infrastructure outcome. Never report a compile error, out-of-gas or unreadable output as a finding.
- Do not describe an unimplemented capability as working, and never call fuzzing a proof of correctness.
- No em dashes in docs, comments or commit messages.
- Commits are one coherent, tested step, with a message that says what changed and why (`feat: ...`, `fix: ...`, `docs: ...`).

## Where help is most wanted

- Structured inputs: arrays, addresses, structs.
- Stateful properties: sequences of calls against one fixture.
- Coverage feedback from the native backend.
- More examples from real Fe code, especially ones that find real bugs.

## Reporting bugs

Open an issue with the command, the seed, the fe version (`fe --version`) and the output. If Fuzzloom misclassified something, for example by reporting an infrastructure problem as a finding or the reverse, that is a high-priority bug.
