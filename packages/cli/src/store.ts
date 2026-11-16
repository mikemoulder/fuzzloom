// Failure records under <ingot>/.fuzzloom/failures/<id>.json.
//
// A record stores the input words themselves, so reproducing a failure
// never depends on regenerating it from the campaign stream. The format is
// versioned; records with an unknown version are rejected, not guessed at.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "./abi.ts";
import { fnv1a64 } from "./harness.ts";
import type { Backend, Target, Words } from "./types.ts";

export const RECORD_VERSION = 1;

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
  backend: Backend | "both";
  detail?: string;
  fe_version: string;
  status: "open" | "fixed";
  created_at: string;
  updated_at: string;
};

export function failuresDir(userRoot: string): string {
  return join(userRoot, ".fuzzloom", "failures");
}

const hexWord = (w: bigint) => "0x" + w.toString(16);

export function recordId(target: string, input: Words, arity: number): string {
  const key = target + ":" + input.slice(0, arity).map(hexWord).join(",");
  return `${target}-${fnv1a64(key).toString(16).padStart(16, "0").slice(0, 8)}`;
}

export function makeRecord(o: {
  kind: FailureRecord["kind"]; target: Target; input: Words; original?: Words; iteration: bigint;
  base: bigint; runs: bigint; backend: FailureRecord["backend"]; detail?: string; feVersion: string;
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
    backend: o.backend,
    ...(o.detail ? { detail: o.detail } : {}),
    fe_version: o.feVersion,
    status: "open",
    created_at: now,
    updated_at: now,
  };
}

/** Saves a record, keeping the creation time of an existing one with the same id. */
export function saveRecord(userRoot: string, r: FailureRecord): string {
  const dir = failuresDir(userRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${r.id}.json`);
  if (existsSync(path)) {
    const prev = JSON.parse(readFileSync(path, "utf8")) as FailureRecord;
    r = { ...r, created_at: prev.created_at };
  }
  writeFileSync(path, JSON.stringify(r, null, 2) + "\n");
  return path;
}

export function loadRecord(userRoot: string, id: string): FailureRecord {
  const path = join(failuresDir(userRoot), `${id}.json`);
  if (!existsSync(path)) throw new Error(`no failure record ${id} in ${failuresDir(userRoot)}`);
  const r = JSON.parse(readFileSync(path, "utf8")) as FailureRecord;
  if (r.version !== RECORD_VERSION) throw new Error(`record ${id} has version ${r.version}; this CLI reads version ${RECORD_VERSION}`);
  return r;
}

export function listRecords(userRoot: string): FailureRecord[] {
  const dir = failuresDir(userRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => loadRecord(userRoot, f.slice(0, -5)));
}

export function recordWords(r: FailureRecord): Words {
  const w = r.input.map((h) => BigInt(h));
  return [w[0] ?? 0n, w[1] ?? 0n, w[2] ?? 0n];
}
