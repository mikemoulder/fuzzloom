#!/usr/bin/env bash
# The whole CI pipeline, in one place. Every CI service (GitHub Actions,
# CircleCI) runs exactly this, and anyone can run it on Linux or macOS:
#
#   bash scripts/ci.sh
#
# Steps: install Fe 26.6.0 if missing, format check, every Fe test on the
# sonatina (EVM) and native backends, CLI typecheck and tests, then the
# seeded vault-math demo, asserting it reproduces the documented findings.
# JUnit reports land in reports/. Needs bash, curl, git, Node >= 22.18.
set -euo pipefail

FE_VERSION="26.6.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.fe/bin:$PATH"

step() { printf '\n=== %s\n' "$*"; }

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) echo "scripts/ci.sh needs Linux or macOS (fe's native backend does not run on Windows; use WSL)"; exit 2 ;;
esac

step "Fe $FE_VERSION"
if ! fe --version 2>/dev/null | grep -q "^fe $FE_VERSION"; then
  # Release downloads occasionally reset mid-transfer; retry before failing.
  for attempt in 1 2 3; do
    # The progress bar is dropped from the log; success is judged by fe itself.
    curl -fsSL https://raw.githubusercontent.com/argotorg/fe/master/feup/feup.sh \
      | bash -s -- --version "v$FE_VERSION" 2>&1 | grep -v '%' || true
    fe --version >/dev/null 2>&1 && break
    echo "Fe install attempt $attempt failed"
    [ "$attempt" -lt 3 ] && sleep 5
  done
fi
fe --version | grep "^fe $FE_VERSION"

step "Format"
fe fmt --check ingots/fuzzloom

step "Fe tests on sonatina (EVM) and native"
bash scripts/test-both.sh

step "Node $(node --version)"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
  || { echo "Node >= 22.18 is required (TypeScript runs without a build step)"; exit 2; }
npm ci --no-audit --no-fund

step "CLI typecheck"
npm run typecheck

step "CLI tests (unit, and integration through fe on both backends)"
npm test

mkdir -p reports

# Exit code 1 means findings, which the demo must have; 2 would mean an
# infrastructure error. Each demo also checks its documented summary.
demo() {
  local name="$1" expect="$2"; shift 2
  local code
  set +e
  node packages/cli/src/index.ts "$name" examples/vault-math --seed 7 --junit "reports/$name-junit.xml" "$@" \
    | tee "reports/$name.txt"
  code=${PIPESTATUS[0]}
  set -e
  [ "$code" -eq 1 ] || { echo "expected exit 1 (findings), got $code"; exit 1; }
  grep -q "$expect" "reports/$name.txt" || { echo "missing: $expect"; exit 1; }
}

step "Demo: fuzz vault-math, seed 7"
demo fuzz "3 passed, 4 failed, 0 infrastructure errors" --no-corpus

step "Demo: diff vault-math on both backends, seed 7"
demo diff "3 agreed, 1 diverged, 0 infrastructure errors"
grep -q "first at input 269" reports/diff.txt

step "CI passed"
