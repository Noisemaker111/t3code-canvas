import * as NodeFS from "node:fs";

/** Size on disk, or 0 for a path that is not there. */
export function fileBytes(path: string): number {
  try {
    return NodeFS.statSync(path).size;
  } catch {
    return 0;
  }
}
