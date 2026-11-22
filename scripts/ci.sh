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

step "Package: pack, install into an empty prefix, run outside the repo"
pkg_tmp="$(mktemp -d)"
trap 'rm -rf "$pkg_tmp"' EXIT
(cd packages/cli && npm pack --silent --pack-destination "$pkg_tmp" >/dev/null)
npm install -g --silent --prefix "$pkg_tmp/prefix" "$pkg_tmp"/fuzzloom-*.tgz
pkg_bin="$pkg_tmp/prefix/bin/fuzzloom"
mkdir -p "$pkg_tmp/project"
cp -r examples/vault-math/fe.toml examples/vault-math/src "$pkg_tmp/project/"
(cd "$pkg_tmp/project" && "$pkg_bin" doctor && "$pkg_bin" list >/dev/null)
"$pkg_bin" doctor "$pkg_tmp/project" | grep -q "lib/node_modules/fuzzloom/ingot" \
  || { echo "the installed CLI did not use its bundled Fe library"; exit 1; }

mkdir -p "$ROOT/reports"

# Each demo runs one command on one example with seed 7 and checks the
# documented summary. The expected exit code is 1 when the example has
# findings and 0 when it has none; 2 would mean an infrastructure error.
demo() {
  local cli="$1" cmd="$2" example="$3" project="$4" want="$5" expect="$6"; shift 6
  local out="$ROOT/reports/$example-$cmd" code
  set +e
  (cd "$project" && "$cli" "$cmd" --seed 7 --junit "$out-junit.xml" "$@") | tee "$out.txt"
  code=${PIPESTATUS[0]}
  set -e
  [ "$code" -eq "$want" ] || { echo "expected exit $want, got $code"; exit 1; }
  grep -q "$expect" "$out.txt" || { echo "missing: $expect"; exit 1; }
}

step "Demo: fuzz vault-math, seed 7"
demo "$pkg_bin" fuzz vault-math "$pkg_tmp/project" 1 "3 passed, 4 failed, 0 infrastructure errors" --no-corpus

step "Demo: diff vault-math on both backends, seed 7"
demo "$pkg_bin" diff vault-math "$pkg_tmp/project" 1 "3 agreed, 1 diverged, 0 infrastructure errors"
grep -q "first at input 269" reports/vault-math-diff.txt

step "Demo: fuzz token-ledger (effects and declared ranges), seed 7"
demo "$pkg_bin" fuzz token-ledger "$ROOT/examples/token-ledger" 1 "2 passed, 2 failed, 0 infrastructure errors" --no-corpus
grep -q "start = 1668464001" reports/token-ledger-fuzz.txt

step "Demo: diff token-ledger on both backends, seed 7"
demo "$pkg_bin" diff token-ledger "$ROOT/examples/token-ledger" 0 "1 agreed, 0 diverged, 0 infrastructure errors"

step "Demo: fuzz amm-swap (a real first draft that overflows u64), seed 7"
demo "$pkg_bin" fuzz amm-swap "$ROOT/examples/amm-swap" 1 "0 passed, 3 failed, 0 infrastructure errors" --no-corpus
grep -q "reserve_out = 10312385981465" reports/amm-swap-fuzz.txt

step "Published npm release: fuzz on both backends and diff"
# Pin the registry smoke test to a release that exists independently of the
# checkout version, which may be in CI before it is published.
npm install -g --silent --ignore-scripts --prefix "$pkg_tmp/published" fuzzloom@0.1.2
published_bin="$pkg_tmp/published/bin/fuzzloom"
published_project="$pkg_tmp/published-project"
mkdir -p "$published_project"
cp -r examples/vault-math/fe.toml examples/vault-math/src "$published_project/"
for backend in sonatina native; do
  demo "$published_bin" fuzz "published-vault-math-$backend" "$published_project" 1 \
    "3 passed, 4 failed, 0 infrastructure errors" --no-corpus --backend "$backend"
done
demo "$published_bin" diff published-vault-math "$published_project" 1 "3 agreed, 1 diverged, 0 infrastructure errors"
grep -q "first at input 269" reports/published-vault-math-diff.txt

step "CI passed"
