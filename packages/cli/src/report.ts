// Terminal and JSON reporting.

import { describe } from "./abi.ts";
import type { PropertyResult } from "./engine.ts";
import type { Target, Words } from "./types.ts";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = paint(31), green = paint(32), yellow = paint(33), dim = paint(2), bold = paint(1);

export function values(t: Target, w: Words): string[] {
  const width = Math.max(...t.args.map((a) => a.name.length));
  return t.args.map((a, i) => `${a.name.padEnd(width)} = ${describe(w[i]!, a.type)}`);
}

function extremesText(t: Target, mask: bigint): string {
  const total = t.args.length * 2;
  let hit = 0;
  for (let i = 0; i < total; i++) if ((mask >> BigInt(i)) & 1n) hit++;
  return hit === total ? `all ${total} argument bounds reached` : `${hit} of ${total} argument bounds reached`;
}

/** Human-readable lines for one property result. `id` is the saved record id. */
export function formatResult(r: PropertyResult, id?: string): string[] {
  const t = r.target;
  const sig = `${t.name}(${t.args.map((a) => a.type).join(", ")})`;
  switch (r.status) {
    case "passed": {
      const draws = r.runs * BigInt(t.args.length);
      const corr = t.args.length > 1 ? `, ${r.stats.correlated} correlated inputs` : "";
      return [
        `${green("PASS")}  ${sig}  ${dim(`${r.runs} inputs`)}`,
        dim(`      ${r.stats.edgeArgs} of ${draws} argument draws were edge values${corr}, ${extremesText(t, r.stats.extremes)}`),
      ];
    }
    case "failed":
      return [
        `${red("FAIL")}  ${sig}  ${dim(`counterexample at input ${r.iteration + 1n}`)}`,
        ...values(t, r.input).map((l) => `      ${bold(l)}`),
        dim(`      shrunk from ${t.args.map((a, i) => describe(r.original[i]!, a.type)).join(", ")} in ${r.shrinkAttempts} evaluations${r.shrinkComplete ? "" : " (budget reached, may not be minimal)"}`),
        ...(id ? [dim(`      reproduce: fuzzloom reproduce ${id}`)] : []),
      ];
    case "aborted":
      return [
        `${red("ABORT")} ${sig}  ${r.abort}  ${dim(`at input ${r.iteration + 1n}`)}`,
        ...values(t, r.input).map((l) => `      ${bold(l)}`),
        dim(r.shrinkAborted
          ? "      the property returns false here; in-Fe shrinking stopped because a smaller candidate aborted"
          : "      input recovered by k-ary search on the run count (Fe cannot catch an abort, so the payload carried none)"),
        dim(`      shrunk by replay from ${t.args.map((a, i) => describe(r.original[i]!, a.type)).join(", ")} in ${r.shrinkRounds} fe runs (${r.shrinkReplays} replays)${r.shrinkComplete ? "" : " (round budget reached, may not be minimal)"}; ${r.feRuns} fe runs in total`),
        ...(id ? [dim(`      reproduce: fuzzloom reproduce ${id}`)] : []),
      ];
    case "infra":
      return [
        `${yellow("INFRA")} ${sig}  ${r.reason}`,
        ...r.detail.split("\n").slice(0, 6).map((l) => dim(`      ${l}`)),
        ...(r.reason === "out-of-gas" ? [dim("      fe test caps EVM tests at 1e9 gas; lower --runs or use --backend native")] : []),
      ];
  }
}

/** JSON-safe copy (bigints become decimal strings). */
export function toJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
