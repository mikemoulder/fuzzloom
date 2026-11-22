// Failure records under <ingot>/.fuzzloom/failures/<id>.json.
//
// A record stores the input words themselves, so reproducing a failure
// never depends on regenerating it from the campaign stream. The format is
// versioned; records with an unknown version are rejected, not guessed at.

//
// Records may come from a repository you do not control, so nothing in one is
// trusted. An id must look like one this CLI generates and match its file
// name (it becomes a path), every field is checked, and a record is rebuilt
// from its known fields before it is written back: no key from a record file
// ever reaches the disk unchecked.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, valueToWord, wordToValue } from "./abi.ts";
import { fnv1a64 } from "./harness.ts";
import { safeDir } from "./paths.ts";
import { FE_TYPES, type Backend, type FeType, type Target, type Words } from "./types.ts";

export const RECORD_VERSION = 1;

/** A record id as recordId generates it: the target name, a dash, 8 hex digits. */
const ID = /^\w{1,200}-[0-9a-f]{8}$/;
const NAME = /^\w{1,200}$/;
const HEX = /^0x[0-9a-f]{1,64}$/;
const KINDS = ["property", "abort", "differential"] as const;
const BACKENDS = ["sonatina", "native", "both"] as const;

export const isRecordId = (id: string): boolean => ID.test(id);

function assertId(id: string): void {
  if (!ID.test(id)) throw new Error(`invalid failure id ${JSON.stringify(id).slice(0, 80)}: ids look like prop_name-0123abcd`);
}

/** Printable text only: control characters (terminal escapes included) are dropped. */
const text = (v: unknown, max = 2000): string => String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, max);

export type FailureRecord = {
  version: number;
  id: string;
  kind: "property" | "abort" | "differential";
  target: string;
  args: { name: string; type: string }[];
  /** Input words, hex, one per argument. */
  input: string[];
  /** Human-readable values, one per argument. */
  values: string[];
  /** First failing input before shrinking, when known. */
  original?: string[];
  iteration: string;
  base_seed: string;
  runs: string;
  sampling?: "uniform";
  backend: Backend | "both";
  detail?: string;
  /** The saved failure whose mutation campaign found this one. */
  seeded_by?: string;
  fe_version: string;
  status: "open" | "fixed";
  created_at: string;
  updated_at: string;
};

export function failuresDir(userRoot: string): string {
  return safeDir(userRoot, ".fuzzloom", "failures");
}

/**
 * The record as this CLI would write it, or an error naming what is wrong.
 * Only known fields survive; strings are length-capped and stripped of
 * control characters; the input words must be hex and match the arguments.
 */
export function validateRecord(raw: unknown, expectId?: string): FailureRecord {
  const r = raw as Record<string, unknown>;
  const bad = (what: string): never => { throw new Error(`invalid failure record${expectId ? ` ${expectId}` : ""}: ${what}`); };
  if (!r || typeof r !== "object" || Array.isArray(r)) bad("not a JSON object");
  if (r.version !== RECORD_VERSION) bad(`version ${text(r.version, 20)}; this CLI reads version ${RECORD_VERSION}`);
  if (typeof r.id !== "string" || !ID.test(r.id)) bad("its id is not a valid failure id");
  if (expectId !== undefined && r.id !== expectId) bad(`its id ${JSON.stringify(r.id)} does not match its file name`);
  if (!KINDS.includes(r.kind as never)) bad("unknown kind");
  if (typeof r.target !== "string" || !NAME.test(r.target)) bad("invalid target name");
  if (!Array.isArray(r.args) || r.args.length < 1 || r.args.length > 3) bad("args must list 1 to 3 arguments");
  const args = (r.args as unknown[]).map((a) => {
    const x = a as Record<string, unknown>;
    if (!x || typeof x.name !== "string" || !NAME.test(x.name) || !FE_TYPES.includes(x.type as never)) bad("invalid argument");
    return { name: x.name as string, type: x.type as FeType };
  });
  const words = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || v.length !== args.length || !v.every((h) => typeof h === "string" && h.length <= 66 && HEX.test(h))) {
      bad(`${what} must be one lowercase hex word per argument`);
    }
    for (const [i, h] of (v as string[]).entries()) {
      const word = BigInt(h);
      const type = args[i]!.type;
      try {
        if (valueToWord(wordToValue(word, type), type) === word) continue;
      } catch {
        // The decoded value does not fit its recorded argument type.
      }
      bad(`${what} word ${i + 1} does not fit ${type}`);
    }
    return v as string[];
  };
  const input = words(r.input, "input");
  const values = Array.isArray(r.values) ? (r.values as unknown[]).slice(0, args.length).map((v) => text(v, 200)) : [];
  if (!BACKENDS.includes(r.backend as never)) bad("unknown backend");
  if (r.status !== "open" && r.status !== "fixed") bad("unknown status");
  return {
    version: RECORD_VERSION,
    id: r.id as string,
    kind: r.kind as FailureRecord["kind"],
    target: r.target as string,
    args,
    input,
    values,
    ...(r.original !== undefined ? { original: words(r.original, "original") } : {}),
    iteration: text(r.iteration ?? "", 80),
    base_seed: text(r.base_seed ?? "", 80),
    runs: text(r.runs ?? "", 80),
    ...(r.sampling === "uniform" ? { sampling: "uniform" as const } : {}),
    backend: r.backend as FailureRecord["backend"],
    ...(r.detail !== undefined ? { detail: text(r.detail, 500) } : {}),
    ...(r.seeded_by !== undefined ? (typeof r.seeded_by === "string" && ID.test(r.seeded_by) ? { seeded_by: r.seeded_by } : bad("invalid seeded_by")) : {}),
    fe_version: text(r.fe_version ?? "", 80),
    status: r.status as FailureRecord["status"],
    created_at: text(r.created_at ?? "", 40),
    updated_at: text(r.updated_at ?? "", 40),
  };
}

const hexWord = (w: bigint) => "0x" + w.toString(16);

export function recordId(target: string, input: Words, arity: number): string {
  const key = target + ":" + input.slice(0, arity).map(hexWord).join(",");
  return `${target}-${fnv1a64(key).toString(16).padStart(16, "0").slice(0, 8)}`;
}

export function makeRecord(o: {
  kind: FailureRecord["kind"]; target: Target; input: Words; original?: Words; iteration: bigint;
  base: bigint; runs: bigint; backend: FailureRecord["backend"]; detail?: string; seededBy?: string; feVersion: string;
  sampling?: FailureRecord["sampling"];
}): FailureRecord {
  const n = o.target.args.length;
  const now = new Date().toISOString();
  return {
    version: RECORD_VERSION,
    id: recordId(o.target.name, o.input, n),
    kind: o.kind,
    target: o.target.name,
    args: o.target.args.map((a) => ({ name: a.name, type: a.type })),
    input: o.input.slice(0, n).map(hexWord),
    values: o.target.args.map((a, i) => describe(o.input[i]!, a.type)),
    ...(o.original ? { original: o.original.slice(0, n).map(hexWord) } : {}),
    iteration: o.iteration.toString(),
    base_seed: o.base.toString(),
    runs: o.runs.toString(),
    ...(o.sampling ? { sampling: o.sampling } : {}),
    backend: o.backend,
    ...(o.detail ? { detail: o.detail } : {}),
    ...(o.seededBy ? { seeded_by: o.seededBy } : {}),
    fe_version: o.feVersion,
    status: "open",
    created_at: now,
    updated_at: now,
  };
}

/**
 * Saves a record under its own id, keeping the creation time of an existing
 * one. The record is validated and rebuilt first, so only known fields are
 * written and the path is always `<failures>/<valid id>.json`.
 */
export function saveRecord(userRoot: string, r: FailureRecord): string {
  const clean = validateRecord(r);
  const dir = failuresDir(userRoot);
  mkdirSync(dir, { recursive: true });
  const path = safeDir(userRoot, ".fuzzloom", "failures", `${clean.id}.json`);
  let out = clean;
  if (existsSync(path)) {
    try {
      out = { ...clean, created_at: validateRecord(JSON.parse(readFileSync(path, "utf8")), clean.id).created_at };
    } catch {
      // an unreadable previous record is replaced, not trusted
    }
  }
  // Publish one complete record even when another CLI invocation is reading.
  const tempDir = mkdtempSync(join(dir, ".record-"));
  const temp = join(tempDir, "record.json");
  try {
    writeFileSync(temp, JSON.stringify(out, null, 2) + "\n", { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
    rmdirSync(tempDir);
  }
  return path;
}

export function loadRecord(userRoot: string, id: string): FailureRecord {
  assertId(id);
  const path = safeDir(userRoot, ".fuzzloom", "failures", `${id}.json`);
  if (!existsSync(path)) throw new Error(`no failure record ${id} in ${failuresDir(userRoot)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`invalid failure record ${id}: not valid JSON (${(e as Error).message.slice(0, 80)})`);
  }
  return validateRecord(raw, id);
}

/**
 * Every valid record, by file name. A file that is not a valid record is
 * skipped and reported through `warn`, so one bad file never stops a run.
 */
export function listRecords(userRoot: string, warn: (msg: string) => void = (m) => console.error(m)): FailureRecord[] {
  const dir = failuresDir(userRoot);
  if (!existsSync(dir)) return [];
  const out: FailureRecord[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const id = f.slice(0, -5);
    if (!ID.test(id)) { warn(`skipping ${text(JSON.stringify(f), 120)} in ${dir}: not a failure record name`); continue; }
    try {
      out.push(loadRecord(userRoot, id));
    } catch (e) {
      warn(`skipping ${id}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function recordWords(r: FailureRecord): Words {
  const w = r.input.filter((h) => HEX.test(h)).map((h) => BigInt(h));
  return [w[0] ?? 0n, w[1] ?? 0n, w[2] ?? 0n];
}
