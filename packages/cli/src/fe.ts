// The one external dependency: the `fe` binary. Every run goes through
// runHarness, and every outcome is classified as either a result (a payload
// Fuzzloom wrote) or an infrastructure outcome (compile error, out of gas,
// timeout, backend unavailable, unparsed output). Infrastructure outcomes
// are never reported as property failures or backend mismatches.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePayload } from "./abi.ts";
import type { Backend, Outcome } from "./types.ts";

export type FeRun = { outcome: Outcome; output: string; ms: number };
export type BatchRun = { outcomes: Outcome[]; output: string; ms: number };

/** Classifies the text `fe test` printed for a single-test harness. */
export function parseFeOutput(text: string): Outcome {
  const payload = text.match(/Test reverted: (0x[0-9a-fA-F]*)/);
  if (payload) {
    try {
      return decodePayload(payload[1]!);
    } catch (e) {
      // A known selector with a malformed body is not a result we can trust.
      return { kind: "infra", reason: "unparsed", detail: `malformed payload: ${(e as Error).message}` };
    }
  }
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

const RESULT_LINE = /^(PASS|FAIL)\s+\[[^\]]*\]\s+(\S+)\s*$/gm;

/**
 * Classifies the output of a multi-test harness, one outcome per name in
 * `names` (same order). fe prints a `PASS|FAIL [time] name` line per test,
 * in completion order, followed by that test's payload or halt reason. When
 * no test line appears at all (a compile error, an unsupported host), the
 * whole output is classified once and applies to every case. A name with no
 * line of its own is an infrastructure outcome, never a pass.
 */
export function parseBatchOutput(text: string, names: string[]): Outcome[] {
  const marks = [...text.matchAll(RESULT_LINE)];
  if (marks.length === 0) {
    const whole = parseFeOutput(text);
    return names.map(() => whole);
  }
  const blocks = new Map<string, string>();
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    blocks.set(m[2]!, text.slice(m.index, end).split(/\n\s*\ntest result:/)[0]!);
  });
  return names.map((n) => {
    const b = blocks.get(n);
    return b === undefined
      ? { kind: "infra", reason: "unparsed", detail: `fe printed no result for ${n}` }
      : parseFeOutput(b);
  });
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

function capture(cmd: string, args: string[], timeoutMs: number): Promise<{ output: string; error?: string; timedOut: boolean }> {
  return new Promise((done) => {
    let output = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ output, error: String(e), timedOut });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout!.on("data", (d) => { output += d; });
    child.stderr!.on("data", (d) => { output += d; });
    child.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); done({ output, error: `${e.code ?? ""} ${e.message}`.trim(), timedOut }); });
    child.on("close", () => { clearTimeout(timer); done({ output, timedOut }); });
  });
}

/**
 * Runs `fe test` on a harness ingot and classifies one outcome per case
 * name. Asynchronous, so the two backends of a differential round can run
 * at the same time.
 */
export async function runBatch(dir: string, names: string[], backend: Backend, cfg: FeConfig = defaultFeConfig()): Promise<BatchRun> {
  const start = Date.now();
  const feArgs = ["test", "--color", "never", ...(backend === "native" ? ["--backend", "native"] : [])];
  const all = (o: Outcome): BatchRun => ({ outcomes: names.map(() => o), output: "", ms: Date.now() - start });
  let r: Awaited<ReturnType<typeof capture>>;
  try {
    if (viaWsl(backend)) {
      const wdir = toWslPath(cfg, dir);
      const quoted = [cfg.wslBin, ...feArgs, `'${wdir}'`].join(" ");
      const pre = cfg.wslDistro ? ["-d", cfg.wslDistro] : [];
      r = await capture("wsl", [...pre, "--", "bash", "-lc", quoted], cfg.timeoutMs);
    } else {
      r = await capture(cfg.bin, [...feArgs, dir], cfg.timeoutMs);
    }
  } catch (e) {
    return all({ kind: "infra", reason: "backend-unavailable", detail: String(e) });
  }
  const ms = Date.now() - start;
  if (r.timedOut) return { ...all({ kind: "infra", reason: "timeout", detail: `no result within ${cfg.timeoutMs} ms` }), output: r.output, ms };
  if (r.error) return { ...all({ kind: "infra", reason: "backend-unavailable", detail: r.error }), output: r.output, ms };
  return { outcomes: parseBatchOutput(r.output, names), output: r.output, ms };
}

/** Runs a one-case harness (see writeHarness). */
export async function runHarness(dir: string, backend: Backend, cfg: FeConfig = defaultFeConfig()): Promise<FeRun> {
  const r = await runBatch(dir, ["case_0"], backend, cfg);
  return { outcome: r.outcomes[0]!, output: r.output, ms: r.ms };
}

/**
 * The fe version the native backend would use: the same binary on
 * Linux/macOS, fe inside WSL on Windows. Undefined when it cannot run.
 */
export function nativeFeVersion(cfg: FeConfig = defaultFeConfig()): string | undefined {
  if (!viaWsl("native")) return feVersion(cfg) === "unknown" ? undefined : feVersion(cfg);
  const r = wsl(cfg, ["bash", "-lc", `${cfg.wslBin} --version`]);
  const out = String(r.stdout ?? "").trim();
  return r.status === 0 && out.startsWith("fe ") ? out : undefined;
}

/** The fe version string, e.g. "fe 26.6.0 (5b3f96a)". */
export function feVersion(cfg: FeConfig = defaultFeConfig()): string {
  const r = spawnSync(cfg.bin, ["--version"], { encoding: "utf8" });
  return String(r.stdout ?? "").trim() || "unknown";
}
