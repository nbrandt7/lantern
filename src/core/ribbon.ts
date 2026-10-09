import * as fs from "fs";
import { findFiles } from "./files";
import { findSolutionFolders } from "./solutions";

export interface RibbonUse {
  /** Function name as written in the command, e.g. "Acme.Account.approve". */
  fn: string;
  /** "command" runs it on click; "enable rule" / "display rule" decide whether the button shows. */
  kind: "command" | "enable rule" | "display rule";
  /** The command or rule ID it belongs to. */
  where: string;
}

const cache = new Map<string, { at: number; result: Map<string, RibbonUse[]> }>();
const CACHE_MS = 30_000;

/**
 * JavaScript functions the command bar (ribbon) calls, from the RibbonDiffXml in the
 * client's pulled solutions, by library name (lowercase). These run without any form
 * event handler, so they're invisible to form-based checks. Cached briefly, since live
 * warnings ask on every edit.
 */
export function scanRibbonFunctions(clientDir: string, fresh = false): Map<string, RibbonUse[]> {
  const hit = cache.get(clientDir);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const out = new Map<string, RibbonUse[]>();
  const files = findSolutionFolders(clientDir).flatMap((folder) => findFiles(folder, (n) => n.toLowerCase().endsWith(".xml")));
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!/JavaScriptFunction|CustomRule/.test(text)) continue;
    for (const use of ribbonUses(text)) {
      const list = out.get(use.library) ?? [];
      if (!list.some((x) => x.fn === use.fn && x.where === use.where && x.kind === use.kind)) list.push({ fn: use.fn, kind: use.kind, where: use.where });
      out.set(use.library, list);
    }
  }
  cache.set(clientDir, { at: Date.now(), result: out });
  return out;
}

/**
 * Function references in one RibbonDiffXml text, each with the element that encloses it:
 * a CommandDefinition (runs on click), or an EnableRule/DisplayRule definition. A
 * self-closing <EnableRule Id="..." /> inside a command is a reference, not an enclosure.
 */
export function ribbonUses(text: string): Array<RibbonUse & { library: string }> {
  // Open/close spans of the elements that can own a function, in one pass.
  const spans: Array<{ kind: string; id: string; start: number; end: number }> = [];
  const stack: Array<{ kind: string; id: string; start: number }> = [];
  const tag = /<(\/?)(CommandDefinition|EnableRule|DisplayRule)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(text))) {
    const [, closing, kind, attrs, selfClosing] = m;
    if (selfClosing) continue;
    if (!closing) stack.push({ kind, id: /\bId\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? "", start: m.index });
    else {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].kind !== kind) continue;
        spans.push({ ...stack[k], end: m.index });
        stack.splice(k, 1);
        break;
      }
    }
  }
  const owner = (at: number) =>
    spans.filter((sp) => sp.start < at && at < sp.end).sort((a, b) => b.start - a.start)[0];

  const uses: Array<RibbonUse & { library: string }> = [];
  const fnRe = /<(JavaScriptFunction|CustomRule)\b([^>]*)>/g;
  while ((m = fnRe.exec(text))) {
    const attrs = m[2];
    const fn = /FunctionName\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    const lib = /Library\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    // Library="isNaN" and similar are the built-in no-op trick, not a web resource.
    if (!fn || !lib || !/^\$webresource:/i.test(lib)) continue;
    const o = owner(m.index);
    const kind: RibbonUse["kind"] = m[1] === "JavaScriptFunction" ? "command" : o?.kind === "DisplayRule" ? "display rule" : "enable rule";
    uses.push({ fn, kind, where: o?.id ?? "", library: lib.replace(/^\$webresource:/i, "").toLowerCase() });
  }
  return uses;
}

/** "command bar: Mscrm.Account.Approve" labels for a function in a library. */
export function ribbonLabels(uses: RibbonUse[] | undefined, fn: string): string[] {
  const last = fn.split(".").pop();
  return (uses ?? [])
    .filter((u) => u.fn === fn || u.fn.split(".").pop() === last)
    .map((u) => `command bar ${u.kind} ${u.where}`.trim());
}
