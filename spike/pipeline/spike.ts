import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(".");
const FE = process.env.FE_BIN ?? join(process.env.USERPROFILE ?? "", ".fe/bin/fe.exe");


function writeHarness(dir: string, seed: bigint, runs: bigint) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "fe.toml"),
`[ingot]
name = "harness"
version = "0.1.0"

[dependencies]
fuzzloom = { path = "${relative(dir, join(root, "fuzzloom")).replaceAll("\\", "/")}" }
demo = { path = "${relative(dir, join(root, "demo")).replaceAll("\\", "/")}" }
`);
  writeFileSync(join(dir, "src/lib.fe"),
`use fuzzloom::{check_u64, U64Any}
use demo::prop_sat_add_monotone

#[test]
fn fuzz_prop_sat_add_monotone() {
    check_u64(U64Any {}, prop_sat_add_monotone, seed: ${seed}, runs: ${runs})
}
`);
}

type Result = { test: string; status: "PASS" | "FAIL"; payload?: string };

function parse(out: string): Result[] {
  const res: Result[] = [];
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(PASS|FAIL)\s+\[[^\]]+\]\s+(\S+)/);
    if (!m) continue;
    const r: Result = { status: m[1] as any, test: m[2] };
    const p = lines[i + 1]?.match(/Test reverted: (0x[0-9a-f]*)/);
    if (p) r.payload = p[1];
    res.push(r);
  }
  return res;
}

function words(payload: string): { selector: string; words: bigint[] } {
  const hex = payload.slice(2);
  const selector = "0x" + hex.slice(0, 8);
  const body = hex.slice(8);
  const ws: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) ws.push(BigInt("0x" + body.slice(i, i + 64)));
  return { selector, words: ws };
}

for (const seed of [7n, 8n, 99n]) {
  const dir = join(root, ".fuzzloom/tmp/h-" + seed);
  writeHarness(dir, seed, 10000n);
  const t0 = Date.now();
  const r = spawnSync(FE, ["test", "--color", "never", dir], { encoding: "utf8" });
  const results = parse(r.stdout + r.stderr);
  for (const x of results) {
    const d = x.payload ? words(x.payload) : undefined;
    console.log(JSON.stringify({ seed: String(seed), exit: r.status, ms: Date.now() - t0, test: x.test, status: x.status,
      selector: d?.selector, fields: d?.words.map((w) => "0x" + w.toString(16)) }));
  }
}
