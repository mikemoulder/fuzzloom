// Discovery of properties and differential targets in a user ingot.
//
// Convention (no configuration):
//   pub fn prop_<name>(args) -> bool   property, 1 to 3 arguments
//   pub fn diff_<name>(args) -> T      differential target, 1 to 3 arguments
//   pub fn seq_<name>(args) -> bool   one stateful step, 1 to 3 arguments
// Arguments and T must be u8..u256, i8..i256 or bool. A target may use
// effects (`uses (name: mut T)`) when the ingot provides a fixture for each
// (see discover). Anything else that
// matches the naming convention is reported as skipped, with the reason,
// so a typo or an unsupported signature is never silently ignored.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { FE_TYPES, type FeType, type Target } from "./types.ts";
import { parseBounds } from "./bounds.ts";

export type Skipped = { name: string; file: string; line: number; reason: string };
export type Discovery = { ingot: string; root: string; targets: Target[]; skipped: Skipped[] };

/** Reads the ingot name from `fe.toml`. */
export function ingotName(root: string): string {
  const toml = join(root, "fe.toml");
  if (!existsSync(toml)) throw new Error(`no fe.toml in ${root}`);
  const text = readFileSync(toml, "utf8");
  const section = text.match(/\[ingot\]([\s\S]*?)(?:\n\[|$)/);
  const name = section?.[1]?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) throw new Error(`${toml} has no [ingot] name`);
  return name;
}

/** Masks comments and literals while preserving offsets and line numbers. */
function maskNonCode(src: string): string {
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[^\r\n]|[^'\\\r\n])'|\/\/[^\n]*|\/\*/g;
  const blocks = /\/\*|\*\//g;
  const out: string[] = [];
  let start = 0;
  for (let m = tokens.exec(src); m; m = tokens.exec(src)) {
    if (m[0] === "/*") {
      blocks.lastIndex = tokens.lastIndex;
      let depth = 1;
      while (depth > 0) {
        const delimiter = blocks.exec(src);
        if (!delimiter) break;
        depth += delimiter[0] === "/*" ? 1 : -1;
      }
      tokens.lastIndex = depth === 0 ? blocks.lastIndex : src.length;
    }
    out.push(src.slice(start, m.index), src.slice(m.index, tokens.lastIndex).replace(/[^\n]/g, " "));
    start = tokens.lastIndex;
  }
  out.push(src.slice(start));
  return out.join("");
}

// Find the name first. A target with an unsupported signature must still
// appear in the inventory even when none of its types can be parsed.
const CANDIDATE = /\bpub\s+fn\s+((?:prop|diff|seq)_\w*)\b/g;
const PARAM = /^(?:(own|mut)\s+)?(?:(\w+)\s+)?(\w+)\s*:\s*(?:(own|mut)\s+)?([\w:]+)$/;

const isFeType = (t: string): t is FeType => (FE_TYPES as readonly string[]).includes(t);

/** An effect as written in a `uses` clause, before its fixture is resolved. */
export type EffectSpec = { type: string; mut: boolean };

const EFFECT_ITEM = /^(?:\w+\s*:\s*)?(mut\s+)?([\w:]+)$/;

/** Parses `uses (a: mut A, b: B)`, `uses (A)` or `uses A`. Undefined when the clause cannot be read. */
export function parseUses(clause: string): EffectSpec[] | undefined {
  const body = clause.trim().replace(/^uses\s*/, "").trim();
  const inner = body.startsWith("(") && body.endsWith(")") ? body.slice(1, -1) : body;
  const items = inner.split(",").map((x) => x.trim()).filter(Boolean);
  const out: EffectSpec[] = [];
  for (const it of items) {
    const m = it.match(EFFECT_ITEM);
    if (!m) return undefined;
    out.push({ type: m[2]!, mut: Boolean(m[1]) });
  }
  return out.length ? out : undefined;
}

/** A target found in one file, with its effects still unresolved. */
export type RawTarget = Target & { uses?: EffectSpec[] };

const FIXTURE = /\bpub\s+fn\s+(fixture_\w+)\s*\(\s*\)\s*->\s*([\w:]+)/g;
const TYPE_DEF = /\bpub\s+(?:struct|enum|trait)\s+(\w+)/g;
const USE_GROUP = /\buse\s+([\w:]+)::\{([^}]*)\}/g;
const USE_ONE = /\buse\s+([\w:]+)::(\w+)\s*(?:\n|$)/g;

/** Fixtures, public types and `use` imports declared in one source text. */
export function declarations(src: string): { fixtures: { name: string; returns: string }[]; types: string[]; uses: Map<string, string> } {
  const clean = maskNonCode(src);
  const fixtures = [...clean.matchAll(FIXTURE)].map((m) => ({ name: m[1]!, returns: m[2]! }));
  const types = [...clean.matchAll(TYPE_DEF)].map((m) => m[1]!);
  const uses = new Map<string, string>();
  for (const m of clean.matchAll(USE_GROUP)) {
    for (const item of m[2]!.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (/^\w+$/.test(item)) uses.set(item, `${m[1]}::${item}`);
    }
  }
  for (const m of clean.matchAll(USE_ONE)) uses.set(m[2]!, `${m[1]}::${m[2]}`);
  return { fixtures, types, uses };
}

/** The doc-comment and attribute lines directly above 1-based line `line`. */
function docAbove(src: string, line: number): string[] {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  for (let i = line - 2; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (l.startsWith("///") || l.startsWith("#[")) out.unshift(l);
    else break;
  }
  return out;
}

/** Finds targets in one source text. */
export function discoverSource(src: string, file: string): { targets: RawTarget[]; skipped: Skipped[] } {
  const clean = maskNonCode(src);
  const targets: RawTarget[] = [];
  const skipped: Skipped[] = [];
  const candidates = [...clean.matchAll(CANDIDATE)];
  let line = 1;
  let braceDepth = 0;
  let scanned = 0;
  for (const [i, m] of candidates.entries()) {
    const name = m[1]!;
    for (; scanned < m.index; scanned++) {
      if (clean[scanned] === "\n") line++;
      if (clean[scanned] === "{") braceDepth++;
      if (clean[scanned] === "}") braceDepth--;
    }
    const kind = name.startsWith("prop_") ? "property" : name.startsWith("seq_") ? "sequence" : "differential";
    const skip = (reason: string) => skipped.push({ name, file, line, reason });
    if (braceDepth !== 0) { skip("target must be a module-level function"); continue; }
    const head = clean.slice(m.index + m[0].length, candidates[i + 1]?.index).trimStart();
    if (head.startsWith("<")) { skip("generic functions are not supported; wrap it in a concrete function"); continue; }
    if (!head.startsWith("(")) { skip("cannot read the parameter list"); continue; }
    let depth = 1;
    let end = 1;
    for (; end < head.length && depth > 0; end++) {
      if (head[end] === "(") depth++;
      if (head[end] === ")") depth--;
      if (head[end] === "{" || head[end] === "}") break;
    }
    if (depth !== 0) { skip("cannot read the parameter list"); continue; }
    const params = head.slice(1, end - 1);
    const body = head.indexOf("{", end);
    if (body === -1) { skip("missing function body"); continue; }
    const suffix = head.slice(end, body).trim();
    const signature = /^(?:->\s*(.*?))?(?:\b(uses\b.*))?$/s.exec(suffix);
    if (!signature) { skip("cannot read the return type or effect clause"); continue; }
    const ret = signature[1]?.trim();
    const usesClause = signature[2];
    const uses = usesClause ? parseUses(usesClause) : undefined;
    if (usesClause && !uses) { skip(`cannot read the effect clause "${usesClause.trim()}"`); continue; }
    if (/[([<]/.test(params)) { skip(`cannot parse parameter list "${params.trim()}"; use scalar arguments`); continue; }
    const parts = params.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length < 1 || parts.length > 3) { skip(`takes ${parts.length} arguments; Fuzzloom supports 1 to 3`); continue; }
    const args: Target["args"] = [];
    let bad = "";
    for (const p of parts) {
      const pm = p.match(PARAM);
      if (!pm) { bad = `cannot parse parameter "${p}"`; break; }
      const [, prefixMode, label, argName = "", suffixMode, type = ""] = pm;
      const mode = prefixMode ?? suffixMode;
      if (mode) { bad = `parameter "${argName}" is passed as ${mode}; use a plain value parameter`; break; }
      if (!isFeType(type)) { bad = `parameter "${argName}" has type ${type}; supported: ${FE_TYPES.join(", ")}`; break; }
      // Labels matter only when Fuzzloom calls the function directly (an
      // effectful target, wrapped in a closure); a function item passed as an
      // Fn value is called positionally (verified against fe 26.6.0).
      args.push({ name: argName, type, label: label === "_" ? null : (label ?? argName) });
    }
    if (bad) { skip(bad); continue; }
    const bounds = parseBounds(docAbove(src, line), args);
    if (typeof bounds === "string") { skip(bounds); continue; }
    const extra = { ...(uses ? { uses } : {}), ...(bounds.length ? { bounds } : {}) };
    if (kind !== "differential") {
      if (ret !== "bool") { skip(`${kind === "sequence" ? "sequence steps" : "properties"} must return bool, found ${ret || "nothing"}`); continue; }
      targets.push({ kind, name, args, file, line, ...extra });
    } else {
      if (!ret || !isFeType(ret)) { skip(`differential targets must return an integer or bool, found ${ret ?? "nothing"}`); continue; }
      targets.push({ kind, name, args, returns: ret, file, line, ...extra });
    }
  }
  return { targets, skipped };
}

function feFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...feFiles(p));
    else if (e.endsWith(".fe")) out.push(p);
  }
  return out.sort();
}

/** The Fe module path of a source file: src/lib.fe is the ingot root, src/a/b.fe is `<ingot>::a::b`. */
export function modulePath(ingot: string, srcDir: string, file: string): string {
  const rel = relative(srcDir, file).split("\\").join("/").replace(/\.fe$/, "");
  return rel === "lib" ? ingot : `${ingot}::${rel.split("/").join("::")}`;
}

const snake = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * Finds every target in the ingot rooted at `root`. A target with effects
 * needs, for each effect type T, exactly one `pub fn fixture_*() -> T` in the
 * ingot, or else exactly one `pub fn fixture_<t_in_snake_case>()` (for a trait
 * effect implemented by a concrete type). T must be defined in the ingot or
 * imported by a `use` in the target's file. Otherwise the target is skipped
 * with the reason.
 */
export function discover(root: string): Discovery {
  const ingot = ingotName(root);
  const src = join(root, "src");
  if (!existsSync(src)) throw new Error(`no src/ directory in ${root}`);
  const raw: { t: RawTarget; mod: string; fileUses: Map<string, string> }[] = [];
  const skipped: Skipped[] = [];
  const fixtures: { name: string; returns: string; path: string }[] = [];
  const types = new Map<string, string>();
  const local = (p: string) => p.replace(/^ingot::/, `${ingot}::`);
  for (const f of feFiles(src)) {
    const text = readFileSync(f, "utf8");
    const mod = modulePath(ingot, src, f);
    const d = declarations(text);
    for (const fx of d.fixtures) fixtures.push({ ...fx, path: `${mod}::${fx.name}` });
    for (const ty of d.types) if (!types.has(ty)) types.set(ty, `${mod}::${ty}`);
    const fileUses = new Map([...d.uses].map(([k, v]) => [k, local(v)]));
    const r = discoverSource(text, relative(root, f).split("\\").join("/"));
    for (const t of r.targets) raw.push({ t, mod, fileUses });
    skipped.push(...r.skipped);
  }
  const targets: Target[] = [];
  for (const { t: { uses, ...t }, mod, fileUses } of raw) {
    const imports = [`${mod}::${t.name}`];
    if (!uses) {
      targets.push({ ...t, imports });
      continue;
    }
    const effects: Target["effects"] = [];
    let reason = "";
    for (const u of uses) {
      const short = u.type.split("::").pop()!;
      let fx = fixtures.filter((x) => x.returns.split("::").pop() === short);
      if (fx.length === 0) fx = fixtures.filter((x) => x.name === `fixture_${snake(short)}`);
      if (fx.length !== 1) {
        reason = fx.length === 0
          ? `uses ${u.type}, but the ingot has no \`pub fn fixture_${snake(short)}() -> ${short}\` to build it`
          : `uses ${u.type}, and more than one fixture builds it (${fx.map((x) => x.name).join(", ")})`;
        break;
      }
      if (!u.type.includes("::")) {
        const typePath = types.get(short) ?? fileUses.get(short);
        if (!typePath) { reason = `uses ${u.type}, which is neither defined in the ingot nor imported in ${t.file}`; break; }
        imports.push(typePath);
      }
      imports.push(fx[0]!.path);
      effects.push({ type: u.type, mut: u.mut, fixture: fx[0]!.name });
    }
    if (reason) skipped.push({ name: t.name, file: t.file, line: t.line, reason });
    else targets.push({ ...t, imports, effects });
  }
  const seen = new Map<string, Target>();
  for (const t of targets) {
    const prev = seen.get(t.name);
    if (prev) throw new Error(`${t.name} is defined in both ${prev.file} and ${t.file}`);
    seen.set(t.name, t);
  }
  return { ingot, root, targets, skipped };
}
