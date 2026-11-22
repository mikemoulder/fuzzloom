#!/usr/bin/env bash
# Use the installed CLI in a fresh ingot backed by somebody else's Fe code.
set -euo pipefail
cli="${1:?pass the path to an installed fuzzloom executable}"
revision=345d5088de986fe54b23a6aaa3a33e1c349d0960
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git init --quiet "$tmp/keccak"
git -C "$tmp/keccak" fetch --quiet --depth 1 https://github.com/fe-lang/keccak.git "$revision"
git -C "$tmp/keccak" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$tmp/keccak" rev-parse HEAD)" = "$revision"
mkdir -p "$tmp/project/src"
cat > "$tmp/project/fe.toml" <<'EOF'
[ingot]
name = "keccak_consumer"
version = "0.1.0"

[dependencies]
keccak = { path = "../keccak" }
EOF
cat > "$tmp/project/src/lib.fe" <<'EOF'
use keccak::{Keccak256, keccak256_word}

/// fuzzloom: split in 1..=2
pub fn prop_streaming_known_answer(_ split: u8) -> bool {
    let abc: [u8; 3] = [97, 98, 99]
    var state = Keccak256::new()
    let at: usize = split.downcast_truncate()
    state.update(abc, offset: 0, len: at)
    state.update(abc, offset: at, len: 3 - at)
    state.finish_word() == 0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
}

pub fn diff_hash_byte(_ value: u8) -> u256 {
    keccak256_word([value])
}
EOF

echo "External ingot: fe-lang/keccak@$revision"
inventory="$("$cli" list "$tmp/project" --json)"
node -e 'const d = JSON.parse(process.argv[1]); if (d.skipped.length || d.targets.length !== 2) process.exit(1)' "$inventory"
for backend in sonatina native; do
  "$cli" fuzz "$tmp/project" --backend "$backend" --seed 7 --runs 32 | tee "$tmp/fuzz-$backend.txt"
  grep -Fq '1 passed, 0 failed, 0 infrastructure errors' "$tmp/fuzz-$backend.txt"
done
"$cli" diff "$tmp/project" --seed 7 --runs 128 | tee "$tmp/diff.txt"
grep -Fq '1 agreed, 0 diverged, 0 infrastructure errors' "$tmp/diff.txt"
