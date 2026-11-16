// The one external dependency: the `fe` binary. Every run goes through
// runHarness, and every outcome is classified as either a result (a payload
// Fuzzloom wrote) or an infrastructure outcome (compile error, out of gas,
// timeout, backend unavailable, unparsed output). Infrastructure outcomes
// are never reported as property failures or backend mismatches.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePayload } from "./abi.ts";
import type { Backend, Outcome } from "./types.ts";

export type FeRun = { outcome: Outcome; output: string; ms: number };

/** Classifies the text `fe test` printed for a single-test harness. */
export function parseFeOutput(text: string): Outcome {
  const payload = text.match(/Test reverted: (0x[0-9a-fA-F]*)/);
  if (payload) return decodePayload(payload[1]!);
  if (/OutOfGas/.test(text)) {
    return { kind: "infra", reason: "out-of-gas", detail: firstLine(text, /OutOfGas[^\n]*/) };
  }
  if (/native test execution supports/.test(text)) {
    return { kind: "infra", reason: "backend-unavailable", detail: firstLine(text, /native test execution supports[^\n]*/) };
  }
  if (/Compilation errors|::compile\b|error\[\d+-\d+\]|Invalid fe\.toml/.test(text)) {
    return { kind: "infra", reason: "compile", detail: compileSummary(text) };
  }
  if (/timed out|time limit|wall-time/i.test(text)) {
    return { kind: "infra", reason: "timeout", detail: firstLine(text, /[^\n]*(timed out|time limit|wall-time)[^\n]*/i) };
  }
  if (/^\s*PASS\b/m.test(text)) {
    return { kind: "infra", reason: "unparsed", detail: "the harness test returned without a payload" };
  }
  return { kind: "infra", reason: "unparsed", detail: text.trim().split("\n").slice(0, 6).join("\n") };
}

function firstLine(text: string, re: RegExp): string {
  return text.match(re)?.[0]?.trim() ?? "";
}

function compileSummary(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /error(\[\d+-\d+\])?:|Invalid fe\.toml|•/.test(l));
  return (at >= 0 ? lines.slice(at, at + 8) : lines.slice(0, 8)).join("\n").trim();
}

export type FeConfig = {
  /** Path to fe for the sonatina backend (and native on Linux/macOS). */
  bin: string;
  /** On Windows, run the native backend inside this WSL distro (undefined = default distro). */
  wslDistro?: string;
  /** fe inside WSL. */
  wslBin: string;
  timeoutMs: number;
};

export function defaultFeConfig(): FeConfig {
  const exe = process.platform === "win32" ? "fe.exe" : "fe";
  const local = join(homedir(), ".fe", "bin", exe);
  return {
    bin: process.env.FE_BIN ?? (existsSync(local) ? local : exe),
    wslDistro: process.env.FE_WSL_DISTRO,
    wslBin: process.env.FE_WSL_BIN ?? "~/.fe/bin/fe",
    timeoutMs: Number(process.env.FUZZLOOM_TIMEOUT_MS ?? 600_000),
  };
}

const viaWsl = (backend: Backend) => backend === "native" && process.platform === "win32";

function wsl(cfg: FeConfig, args: string[]): ReturnType<typeof spawnSync> {
  const pre = cfg.wslDistro ? ["-d", cfg.wslDistro] : [];
  return spawnSync("wsl", [...pre, "--", ...args], { encoding: "utf8", timeout: cfg.timeoutMs });
}

/** Converts a Windows path for use inside WSL. */
function toWslPath(cfg: FeConfig, p: string): string {
  const r = wsl(cfg, ["wslpath", "-a", p.split("\\").join("/")]);
  const out = String(r.stdout ?? "").trim();
  if (r.status !== 0 || !out) throw new Error(`wslpath failed for ${p}: ${String(r.stderr ?? "")}`);
  return out;
}

/** Runs `fe test` on a harness ingot directory and classifies the result. */
export function runHarness(dir: string, backend: Backend, cfg: FeConfig = defaultFeConfig()): FeRun {
  const start = Date.now();
  const feArgs = ["test", "--color", "never", ...(backend === "native" ? ["--backend", "native"] : [])];
  let r: ReturnType<typeof spawnSync>;
  try {
    if (viaWsl(backend)) {
      const wdir = toWslPath(cfg, dir);
      const quoted = [cfg.wslBin, ...feArgs, `'${wdir}'`].join(" ");
      r = wsl(cfg, ["bash", "-lc", quoted]);
    } else {
      r = spawnSync(cfg.bin, [...feArgs, dir], { encoding: "utf8", timeout: cfg.timeoutMs });
    }
  } catch (e) {
    return { outcome: { kind: "infra", reason: "backend-unavailable", detail: String(e) }, output: "", ms: Date.now() - start };
  }
  const ms = Date.now() - start;
  const output = String(r.stdout ?? "") + String(r.stderr ?? "");
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === "ETIMEDOUT") return { outcome: { kind: "infra", reason: "timeout", detail: `no result within ${cfg.timeoutMs} ms` }, output, ms };
    return { outcome: { kind: "infra", reason: "backend-unavailable", detail: `${err.code ?? ""} ${err.message}`.trim() }, output, ms };
  }
  return { outcome: parseFeOutput(output), output, ms };
}

/** The fe version string, e.g. "fe 26.6.0 (5b3f96a)". */
export function feVersion(cfg: FeConfig = defaultFeConfig()): string {
  const r = spawnSync(cfg.bin, ["--version"], { encoding: "utf8" });
  return String(r.stdout ?? "").trim() || "unknown";
}
