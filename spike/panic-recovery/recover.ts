// Proves the panic-recovery contract end to end through `fe test`:
// 1. the campaign aborts with a raw Panic payload (no input);
// 2. bisect on `runs` to find the first iteration that aborts;
// 3. input_at recovers the input; replay confirms the property itself panics.
// Usage: node recover.ts [native]   (native needs Linux/macOS, or run inside WSL)
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const here = resolve(import.meta.dirname);
const lib = resolve(here, "../../ingots/fuzzloom");
const target = resolve(here, "target");
const native = process.argv[2] === "native";
const FE = process.env.FE_BIN ?? (process.platform === "win32" ? join(process.env.USERPROFILE ?? "", ".fe/bin/fe.exe") : join(process.env.HOME ?? "", ".fe/bin/fe"));
const SEED = 2024n, RUNS = 50000n;
let feCalls = 0;

function harness(body: string): string {
  const dir = join(here, ".tmp");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  const rel = (p: string) => relative(dir, p).split("\\").join("/");
  writeFileSync(join(dir, "fe.toml"), `[ingot]\nname = "h"\nversion = "0.1.0"\n\n[dependencies]\nfuzzloom = { path = "${rel(lib)}" }\ntarget = { path = "${rel(target)}" }\n`);
  writeFileSync(join(dir, "src/lib.fe"), `use fuzzloom::{check, input_at, replay, prop2, bounds_of, Input}\nuse target::prop_rate_bounded\n\n#[test]\nfn h() {\n    ${body}\n}\n`);
  const args = ["test", "--color", "never", ...(native ? ["--backend", "native"] : []), dir];
  feCalls++;
  const r = spawnSync(FE, args, { encoding: "utf8" });
  const m = (r.stdout + r.stderr).match(/Test reverted: (0x[0-9a-f]*)/);
  if (!m) throw new Error("no payload:\n" + r.stdout + r.stderr);
  return m[1];
}
const sel = (p: string) => p.slice(0, 10);
const words = (p: string) => (p.slice(10).match(/.{64}/g) ?? []).map((w) => BigInt("0x" + w));
const PANIC = "0x4e487b71";
const run = (runs: bigint) => harness(`check(prop2(prop_rate_bounded), seed: ${SEED}, runs: ${runs})`);

const full = run(RUNS);
console.log("campaign payload selector:", sel(full), sel(full) === PANIC ? `(Panic 0x${words(full)[0].toString(16)}, input lost)` : "");
if (sel(full) !== PANIC) process.exit(1);

// Smallest runs that aborts = first aborting iteration + 1.
let lo = 1n, hi = RUNS;
while (lo < hi) {
  const mid = (lo + hi) / 2n;
  if (sel(run(mid)) === PANIC) hi = mid; else lo = mid + 1n;
}
const iteration = lo - 1n;
const gen = words(harness(`input_at(prop2(prop_rate_bounded), bounds: bounds_of(prop2(prop_rate_bounded)), seed: ${SEED}, iteration: ${iteration})`));
const [price, qty] = [gen[3], gen[4]];
const rep = harness(`replay(prop2(prop_rate_bounded), input: Input::two(${price}, ${qty}))`);
console.log(JSON.stringify({ backend: native ? "native" : "sonatina", iteration: String(iteration), price: String(price), qty: String(qty),
  divisor_is_zero: (price % 1000n) === 777n, replay: sel(rep) === PANIC ? "panics (property bug)" : sel(rep), fe_calls: feCalls }));
