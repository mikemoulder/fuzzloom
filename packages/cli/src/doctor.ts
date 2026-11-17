// `fuzzloom doctor`: checks everything a first run needs and says how to fix
// what is missing. Required checks fail the command (exit 2); the native
// backend is only needed by `diff` (and `--backend native`), so a missing one
// is a warning.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { discover } from "./discover.ts";
import { defaultFeConfig, feVersion, nativeFeVersion, type FeConfig } from "./fe.ts";
import { libraryIngot } from "./harness.ts";

/** The Fe release the library and harness generator are written against. */
export const SUPPORTED_FE = "26.6";

export type Check = { name: string; level: "ok" | "warn" | "fail"; detail: string; fix?: string };

const supported = (v: string) => new RegExp(`^fe ${SUPPORTED_FE.replace(".", "\\.")}\\.`).test(v);

export function checks(projectRoot: string | undefined, cfg: FeConfig = defaultFeConfig()): Check[] {
  const out: Check[] = [];

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  out.push(major > 22 || (major === 22 && minor >= 18)
    ? { name: "Node", level: "ok", detail: `v${process.versions.node}` }
    : { name: "Node", level: "fail", detail: `v${process.versions.node}`, fix: "install Node 22.18 or newer" });

  const v = feVersion(cfg);
  if (v === "unknown") {
    out.push({ name: "fe", level: "fail", detail: `not found (${cfg.bin})`, fix: "install with feup (https://fe-lang.org/getting-started/installation/), or set FE_BIN" });
  } else if (!supported(v)) {
    out.push({ name: "fe", level: "warn", detail: `${v} at ${cfg.bin}`, fix: `Fuzzloom is built and tested against fe ${SUPPORTED_FE}.x; other versions may not compile its harnesses` });
  } else {
    out.push({ name: "fe", level: "ok", detail: `${v} at ${cfg.bin}` });
  }

  let lib: string | undefined;
  try {
    lib = libraryIngot();
    out.push({ name: "Fe library", level: "ok", detail: lib });
  } catch (e) {
    out.push({ name: "Fe library", level: "fail", detail: (e as Error).message, fix: "reinstall fuzzloom, or set FUZZLOOM_INGOT to an ingots/fuzzloom checkout" });
  }

  // The library must compile with this fe: catches version drift before a
  // whole campaign fails with a compile error.
  if (lib && v !== "unknown") {
    const r = spawnSync(cfg.bin, ["check", lib], { encoding: "utf8" });
    out.push(r.status === 0
      ? { name: "Library compiles", level: "ok", detail: "fe check passed" }
      : { name: "Library compiles", level: "fail", detail: String(r.stdout ?? r.stderr ?? "").trim().split("\n").slice(0, 4).join(" "), fix: `use fe ${SUPPORTED_FE}.x` });
  }

  const nv = nativeFeVersion(cfg);
  const where = process.platform === "win32" ? `WSL${cfg.wslDistro ? ` (${cfg.wslDistro})` : ""}` : "this machine";
  out.push(nv
    ? { name: "Native backend", level: supported(nv) ? "ok" : "warn", detail: `${nv} in ${where}` }
    : {
      name: "Native backend", level: "warn", detail: `fe not runnable in ${where}`,
      fix: process.platform === "win32"
        ? "diff needs fe's native backend, which runs on Linux/macOS: install fe inside WSL (set FE_WSL_DISTRO / FE_WSL_BIN if needed)"
        : "install fe; diff needs the native backend",
    });

  if (projectRoot) {
    if (!existsSync(join(projectRoot, "fe.toml"))) {
      out.push({ name: "Project", level: "fail", detail: `no fe.toml in ${projectRoot}`, fix: "run doctor inside (or pass the path of) a Fe ingot" });
    } else {
      try {
        const d = discover(projectRoot);
        const props = d.targets.filter((t) => t.kind === "property").length;
        const diffs = d.targets.length - props;
        out.push({
          name: "Project", level: d.targets.length ? "ok" : "warn",
          detail: `ingot ${d.ingot}: ${props} prop_* and ${diffs} diff_* functions, ${d.skipped.length} skipped`,
          ...(d.targets.length ? {} : { fix: "write `pub fn prop_<name>(args) -> bool` (or diff_<name>) in the ingot's src/" }),
        });
        for (const s of d.skipped) out.push({ name: `  skipped ${s.name}`, level: "warn", detail: `${s.file}:${s.line} ${s.reason}` });
      } catch (e) {
        out.push({ name: "Project", level: "fail", detail: (e as Error).message });
      }
    }
  }
  return out;
}
