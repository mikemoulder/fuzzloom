// Copies the Fe library ingot (and the license) into this package, so an
// installed CLI carries the exact library it generates harnesses against.
// Run by `npm pack` / `npm publish` through the prepack script.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const source = resolve(here, "../../../ingots/fuzzloom");
const target = resolve(here, "../ingot");
if (!existsSync(resolve(source, "fe.toml"))) throw new Error(`no Fe library at ${source}`);
rmSync(target, { recursive: true, force: true });
cpSync(resolve(source, "fe.toml"), resolve(target, "fe.toml"));
cpSync(resolve(source, "src"), resolve(target, "src"), { recursive: true });
cpSync(resolve(here, "../../../LICENSE"), resolve(here, "../LICENSE"));
console.log(`bundled ${source} -> ${target}`);
