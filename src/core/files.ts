import * as fs from "fs";
import * as path from "path";

/** Folders never searched for solutions, projects, or web resources. */
export const SKIP_DIRS = new Set([
  "node_modules", "bin", "obj", "dist", "out", ".git", ".vs", ".vscode",
  "typings", "typings.tmp", ".pull-backup",
]);

/** Never copied, compared, or overwritten by a pull. */
export const PULL_IGNORE = new Set([
  ".git", "bin", "obj", "node_modules", ".vs", "typings", "typings.tmp", ".pull-backup",
  "jsconfig.json", "client.json",
]);

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every file under dir that matches test, skipping build output and tooling folders. */
export function findFiles(dir: string, test: (name: string, fullPath: string) => boolean): string[] {
  const found: string[] = [];
  if (!isDirectory(dir)) return found;
  const walk = (current: string): void => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && test(e.name, full)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

/** Relative paths of every file under root, skipping PULL_IGNORE. */
export function listFiles(root: string): string[] {
  const files: string[] = [];
  if (!isDirectory(root)) return files;
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (PULL_IGNORE.has(e.name)) continue;
      const child = path.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) files.push(child);
    }
  };
  walk("");
  return files;
}

export function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, filter: (src) => src === from || !PULL_IGNORE.has(path.basename(src)) });
}

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** Treats CRLF and LF as equal for text so line-ending churn doesn't show up as a change. */
export function sameContent(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  if (isBinary(a) || isBinary(b)) return false;
  return a.toString("utf8").replace(/\r\n/g, "\n") === b.toString("utf8").replace(/\r\n/g, "\n");
}

/** Walks up from start until test passes or root is reached. */
export function findUp(start: string, test: (dir: string) => boolean, stopAt?: string): string | undefined {
  let current = start;
  for (;;) {
    if (test(current)) return current;
    const parent = path.dirname(current);
    if (parent === current || (stopAt && !isInside(parent, stopAt))) return undefined;
    current = parent;
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
