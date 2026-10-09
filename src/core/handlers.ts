import * as fs from "fs";
import * as path from "path";
import { Client } from "./clients";
import { findFiles } from "./files";
import { isWebResourceCandidate, resolveWebResourceName } from "./solutions";
import { maskJs } from "./codeanalysis";

/**
 * The local file for a web resource name, from (in order): a solution .data.xml that
 * records that name, any file the extension would push under that name, or a file
 * with the same base name.
 */
export function findWebResourceFile(client: Client, name: string): string | undefined {
  const wanted = name.toLowerCase();

  for (const dataXml of findFiles(client.dir, (n) => n.toLowerCase().endsWith(".data.xml"))) {
    const match = /<Name>([^<]+)<\/Name>/.exec(fs.readFileSync(dataXml, "utf8"));
    const file = dataXml.slice(0, -".data.xml".length);
    if (match && match[1].trim().toLowerCase() === wanted && fs.existsSync(file)) return file;
  }

  const candidates = findFiles(client.dir, (_n, full) => isWebResourceCandidate(full, client));
  const exact = candidates.find((f) => resolveWebResourceName(f, client)?.name.toLowerCase() === wanted);
  if (exact) return exact;

  const base = path.posix.basename(wanted);
  return candidates.find((f) => path.basename(f).toLowerCase() === base);
}

export interface FunctionLocation {
  line: number;
  character: number;
  length: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a handler function is defined. Handles the usual web resource styles:
 *   function onLoad(ctx) {...}
 *   this.onLoad = function (ctx) {...}      Acme.Account.onLoad = function ...
 *   onLoad: function (ctx) {...}           onLoad(ctx) { ... }   (object or class method)
 *   const onLoad = (ctx) => {...}          onLoad = async function ...
 * A namespaced handler ("Acme.Account.onLoad") matches its full assignment first,
 * then its last segment. A plain call like onLoad(ctx); never counts as a definition.
 */
export function findFunction(source: string, functionName: string): FunctionLocation | undefined {
  // Only real code: a name in a comment or a string isn't a definition.
  const text = maskJs(source).codeOnly;
  const full = functionName.trim();
  const last = full.split(".").pop() ?? full;
  const n = esc(last);
  const patterns: RegExp[] = [];
  if (full.includes(".")) patterns.push(new RegExp(`(?<![\\w.])${esc(full)}\\s*=\\s*(?:async\\s+)?(?:function\\b|\\()`, "m"));
  patterns.push(
    new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*\\(`, "m"),
    new RegExp(`(?<![\\w])(?:[\\w$]+\\.)*${n}\\s*[:=]\\s*(?:async\\s+)?function\\b`, "m"),
    new RegExp(`(?<![\\w])${n}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*=>`, "m"),
    new RegExp(`^[ \\t]*(?:async\\s+|static\\s+)*${n}\\s*\\([^)]*\\)\\s*\\{`, "m")
  );
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    // Point at the function's name within the match.
    const offset = locateName(m.index, m[0], last);
    return toPosition(text, offset >= 0 ? offset : m.index, last.length);
  }
  return undefined;
}

function locateName(start: number, match: string, name: string): number {
  const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
  const m = re.exec(match);
  return m ? start + m.index : -1;
}

function toPosition(text: string, offset: number, length: number): FunctionLocation {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  const character = offset - (before.lastIndexOf("\n") + 1);
  return { line, character, length };
}
