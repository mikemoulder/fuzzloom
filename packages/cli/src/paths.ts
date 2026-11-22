// Paths Fuzzloom writes to or deletes inside a user's ingot.
//
// The ingot may come from a repository you do not control. If `.fuzzloom`
// (or anything under it) were a symlink, writes and the recursive cleanup of
// `.fuzzloom/tmp` would land wherever it points. So every path Fuzzloom
// writes under the ingot is checked component by component below the ingot
// root: no component may be a symlink (or a Windows junction, which Node
// reports as one). The root itself may be a symlink: the user chose it.

import { lstatSync } from "node:fs";
import { join } from "node:path";

/** `join(root, ...parts)` after checking that no existing component below `root` is a symlink. */
export function safeDir(root: string, ...parts: string[]): string {
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || /[\\/]/.test(part)) throw new Error(`unsafe path component ${JSON.stringify(part)}`);
  }
  let p = root;
  for (let i = 0; i < parts.length; i++) {
    p = join(p, parts[i]!);
    let link: boolean;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return join(p, ...parts.slice(i + 1)); // the rest does not exist yet; it will be created as real directories
    }
    if (link) throw new Error(`refusing to use ${p}: it is a symlink, and Fuzzloom only writes inside the ingot`);
  }
  return p;
}
