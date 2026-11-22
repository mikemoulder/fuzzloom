// Compare Fe's real integer operators across backends using generated targets.
// Each row names the operation, type, run count and result. Explicit edge
// evaluations also compare traps, which cannot be accumulated in a digest.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../packages/cli/src/discover.ts";
import { runCases, runDiffs } from "../packages/cli/src/engine.ts";
import { defaultFeConfig, feVersion } from "../packages/cli/src/fe.ts";
import { toJson } from "../packages/cli/src/report.ts";

const widths = [8, 16, 32, 64, 128, 256];
const runs = BigInt(process.argv[2] ?? 100000);
const seed = 7n;
const key = (1n << 127n) - 3n;
const root = mkdtempSync(join(tmpdir(), "fuzzloom-integers-"));
const fe = defaultFeConfig();
const rows = [];
const edges = [];

function matrix(type, width, signed) {
  const min = signed ? -(1n << BigInt(width - 1)) : 0n;
  const max = (1n << BigInt(width - Number(signed))) - 1n;
  const shifted = signed ? "(b & " + type + "::max())" : "b";
  const exceptional = signed ? ` || (a == ${type}::min() && b == -1)` : "";
  const binary = [
    ["add", "a.wrapping_add(b)"],
    ["sub", "a.wrapping_sub(b)"],
    ["mul", "a.wrapping_mul(b)"],
    ["shl", `a << ${shifted}`, [0n, BigInt(width - 1), BigInt(width), BigInt(width + 1), max].filter((n) => n <= max)],
    ["shr", `a >> ${shifted}`, [0n, BigInt(width - 1), BigInt(width), BigInt(width + 1), max].filter((n) => n <= max)],
    ["div", `if b == 0${exceptional} { 0 } else { a / b }`, [0n, 1n, ...(signed ? [-1n] : [])], "a / b"],
    ["rem", `if b == 0${exceptional} { 0 } else { a % b }`, [0n, 1n, ...(signed ? [-1n] : [])], "a % b"],
    ["pow", "(a & 3) ** (b & 3)", [0n, 1n, 3n]],
  ];
  const encode = (value) => signed ? (value < 0 ? -value * 2n - 1n : 2n * value) : value;
  const functions = [];
  for (const [op, body, rhs, raw] of binary) {
    const name = `diff_${op}_${type}`;
    functions.push(`pub fn ${name}(_ a: ${type}, _ b: ${type}) -> ${type} { ${body} }`);
    if (rhs) {
      const edgeName = raw ? `diff_edge_${op}_${type}` : name;
      if (raw) functions.push(`pub fn ${edgeName}(_ a: ${type}, _ b: ${type}) -> ${type} { ${raw} }`);
      for (const a of new Set([min, min + 1n, 0n, max])) {
        for (const b of new Set(rhs)) edges.push({ name: edgeName, values: [a, b], words: [encode(a), encode(b), 0n] });
      }
    }
  }
  const widest = signed ? "i256" : "u256";
  if (width < 256) {
    functions.push(`pub fn diff_widen_${type}(_ a: ${type}) -> ${widest} { a as ${widest} }`);
    functions.push(`pub fn diff_truncate_${type}(_ a: ${widest}) -> ${type} { a.downcast_truncate() }`);
  }
  return functions.join("\n");
}

function observed(outcome) {
  if (outcome.kind === "evaluated") return { output: outcome.output };
  if (outcome.kind === "panic") return { panic: outcome.code };
  if (outcome.kind === "revert") return { revert: outcome.message };
  throw new Error(JSON.stringify(toJson(outcome)));
}

try {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "fe.toml"), '[ingot]\nname = "integer_semantics"\nversion = "0.1.0"\n');
  writeFileSync(join(root, "src/lib.fe"), widths.flatMap((width) =>
    [matrix(`u${width}`, width, false), matrix(`i${width}`, width, true)]).join("\n"));
  const d = discover(root);
  if (d.skipped.length) throw new Error(JSON.stringify(d.skipped));
  const ctx = { userRoot: root, ingot: d.ingot, backend: "sonatina", fe };
  const targets = new Map(d.targets.map((t) => [t.name, t]));
  const edgeRows = [];
  for (const width of widths) {
    const group = d.targets.filter((t) => !t.name.startsWith("diff_edge_") && new RegExp(`_[ui]${width}$`).test(t.name));
    for (const result of await runDiffs(ctx, group, seed, runs, key)) rows.push(result);
    const groupEdges = edges.filter((e) => new RegExp(`_[ui]${width}$`).test(e.name));
    const cases = groupEdges.map((e) => ({ target: targets.get(e.name), call: { mode: "evaluate", input: e.words } }));
    const [s, n] = await Promise.all([
      runCases(ctx, cases, `edges-${width}`, "sonatina"),
      runCases(ctx, cases, `edges-${width}`, "native"),
    ]);
    for (const [i, edge] of groupEdges.entries()) {
      try {
        const sonatina = observed(s[i]);
        const native = observed(n[i]);
        const matches = JSON.stringify(toJson(sonatina)) === JSON.stringify(toJson(native));
        edgeRows.push({ operation: edge.name, input: edge.values, status: matches ? "agreed" : "diverged", sonatina, native });
      } catch (error) {
        edgeRows.push({ operation: edge.name, input: edge.values, status: "infra", detail: String(error) });
      }
    }
    process.stderr.write(`Compared ${width}-bit types (${group.length} campaigns, ${groupEdges.length} explicit edge cases)\n`);
  }
  console.log(JSON.stringify(toJson({ fe: feVersion(fe), seed, key, runs, campaigns: rows, edges: edgeRows }), null, 2));
  const statuses = [...rows, ...edgeRows].map((row) => row.status);
  process.exitCode = statuses.includes("infra") ? 2 : statuses.includes("diverged") ? 1 : 0;
} finally {
  rmSync(root, { recursive: true, force: true });
}
