# Security policy

Fuzzloom is a developer tool. It reads your Fe sources, writes generated test ingots under `.fuzzloom/` inside your project, and runs the `fe` binary you have installed. It makes no network requests of its own, holds no keys and moves no funds.

## What counts as a security issue

- Fuzzloom executing code other than your ingot, the bundled Fe library and the harnesses it generates.
- Generated harnesses or records being written outside the project's `.fuzzloom/` directory.
- A result being reported as passing when the run actually failed, timed out or could not be read. Fuzzloom is meant to fail closed, and a silent false pass undermines everything built on it.

## Running Fuzzloom on a project you do not control

A project's `.fuzzloom/` directory, including its saved failures, is treated as untrusted input:

- **Saved failures are validated before use.** A record's id must have the form Fuzzloom generates and match its file name, every field is checked, and a record is rebuilt from its known fields before it is written back. A record that fails validation is skipped with a warning, so one bad file never stops a run.
- **Symlinks are refused.** If `.fuzzloom`, `.fuzzloom/tmp` or `.fuzzloom/failures` is a symlink (or a Windows junction), Fuzzloom stops with an error before writing or deleting anything, so neither generated files nor the cleanup of `.fuzzloom/tmp` can reach outside the project.
- **No shell sees your paths.** `fe` runs with an argument list, and on Windows the native backend runs through `wsl -e` with the project path as a separate argument, so quotes, `$` or `;` in a path are never parsed as shell syntax.

Each of these is covered by a regression test that replays the attack it prevents (`packages/cli/test/store.test.ts` and `fe.test.ts`).

## Reporting

Please report security issues privately, through GitHub's **Report a vulnerability** button on the repository's Security tab, rather than in a public issue. Include the command, the fe version and how to reproduce it. You should get a response within a few days.

## Scope

Bugs in Fe itself, or in code under test, are out of scope here. If Fuzzloom finds one, please report it to that project. A divergence between Fe's backends is worth reporting to the [Fe project](https://github.com/argotorg/fe) with the input and both outputs Fuzzloom printed.
