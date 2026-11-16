#!/usr/bin/env bash
# Run the workspace tests on both Fe backends.
# On Linux/macOS both run natively. On Windows (Git Bash), sonatina runs with
# fe.exe and the native backend runs inside WSL (set FE_WSL_DISTRO to override).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARGS=("$@")
status=0

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    FE_WIN="${FE_BIN:-$HOME/.fe/bin/fe.exe}"
    DISTRO="${FE_WSL_DISTRO:-Ubuntu-24.04}"
    WSL_ROOT="$(wsl -d "$DISTRO" -- wslpath -a "$(cygpath -w "$ROOT")" | tr -d '\r')"
    echo "== sonatina (EVM)"
    (cd "$ROOT" && "$FE_WIN" test --color never "${ARGS[@]}") || status=1
    echo "== native (WSL $DISTRO)"
    wsl -d "$DISTRO" -- bash -lc "cd '$WSL_ROOT' && ~/.fe/bin/fe test --backend native --color never ${ARGS[*]}" || status=1
    ;;
  *)
    FE="${FE_BIN:-fe}"
    echo "== sonatina (EVM)"
    (cd "$ROOT" && "$FE" test --color never "${ARGS[@]}") || status=1
    echo "== native"
    (cd "$ROOT" && "$FE" test --backend native --color never "${ARGS[@]}") || status=1
    ;;
esac
exit $status
