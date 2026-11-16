// Discovery of properties and differential targets in a user ingot.
//
// Convention (no configuration):
//   pub fn prop_<name>(args) -> bool   property, 1 to 3 arguments
//   pub fn diff_<name>(args) -> T      differential target, 1 to 3 arguments
// Arguments and T must be u8..u256, i8..i256 or bool. Anything else that
// matches the naming convention is reported as skipped, with the reason,
// so a typo or an unsupported signature is never silently ignored.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { FE_TYPES, type FeType, type Target } from "./types.ts";

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

/** Blanks out comments while keeping offsets (so line numbers stay right). */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
            .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const SIGNATURE = /\bpub\s+fn\s+((?:prop|diff)_\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?:->\s*([\w:]+))?\s*(uses\b[^{]*)?\{/g;
const PARAM = /^(?:(own|mut)\s+)?(?:(\w+)\s+)?(\w+)\s*:\s*(?:(own|mut)\s+)?([\w:]+)$/;

const isFeType = (t: string): t is FeType => (FE_TYPES as readonly string[]).includes(t);

/** Finds targets in one source text. */
export function discoverSource(src: string, file: string): { targets: Target[]; skipped: Skipped[] } {
  const clean = stripComments(src);
  const targets: Target[] = [];
  const skipped: Skipped[] = [];
  for (const m of clean.matchAll(SIGNATURE)) {
    const [, name = "", generics, params = "", ret, uses] = m;
    const line = clean.slice(0, m.index).split("\n").length;
    const kind = name.startsWith("prop_") ? "property" : "differential";
    const skip = (reason: string) => skipped.push({ name, file, line, reason });
    if (generics) { skip("generic functions are not supported; wrap it in a concrete function"); continue; }
    if (uses) { skip("functions with effects (uses ...) are not supported yet"); continue; }
    const parts = params.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length < 1 || parts.length > 3) { skip(`takes ${parts.length} arguments; Fuzzloom supports 1 to 3`); continue; }
    const args: Target["args"] = [];
    let bad = "";
    for (const p of parts) {
      const pm = p.match(PARAM);
      if (!pm) { bad = `cannot parse parameter "${p}"`; break; }
      const [, , label, argName = "", mode, type = ""] = pm;
      if (mode) { bad = `parameter "${argName}" is passed as ${mode}; use a plain value parameter`; break; }
      // Labels (`_ x`, `x`, or `label x`) do not matter: a function item is
      // passed as an Fn value and called positionally either way (verified
      // against fe 26.6.0).
      void label;
      if (!isFeType(type)) { bad = `parameter "${argName}" has type ${type}; supported: ${FE_TYPES.join(", ")}`; break; }
      args.push({ name: argName, type });
    }
    if (bad) { skip(bad); continue; }
    if (kind === "property") {
      if (ret !== "bool") { skip(`properties must return bool, found ${ret ?? "nothing"}`); continue; }
      targets.push({ kind, name, args, file, line });
    } else {
      if (!ret || !isFeType(ret)) { skip(`differential targets must return an integer or bool, found ${ret ?? "nothing"}`); continue; }
      targets.push({ kind, name, args, returns: ret, file, line });
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

/** Finds every target in the ingot rooted at `root`. */
export function discover(root: string): Discovery {
  const ingot = ingotName(root);
  const src = join(root, "src");
  if (!existsSync(src)) throw new Error(`no src/ directory in ${root}`);
  const targets: Target[] = [];
  const skipped: Skipped[] = [];
  for (const f of feFiles(src)) {
    const r = discoverSource(readFileSync(f, "utf8"), relative(root, f).split("\\").join("/"));
    targets.push(...r.targets);
    skipped.push(...r.skipped);
  }
  const seen = new Map<string, Target>();
  for (const t of targets) {
    const prev = seen.get(t.name);
    if (prev) throw new Error(`${t.name} is defined in both ${prev.file} and ${t.file}`);
    seen.set(t.name, t);
  }
  return { ingot, root, targets, skipped };
}
