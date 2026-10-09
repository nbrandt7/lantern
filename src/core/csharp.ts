import * as fs from "fs";
import * as path from "path";
import { findFiles, isDirectory } from "./files";
import { lineOf } from "./codeanalysis";

/**
 * A light C# reader: the classes in a project's source files with the full names
 * Dataverse stores for plug-in types (Namespace.Outer+Inner), their base types,
 * and which of them are plug-ins or workflow activities. It reads text, so it
 * works before anything is built; the built DLL stays the source of truth when
 * pushing.
 */

export interface CsType {
  /** Metadata-style name: generic arity as `1, nesting as +. */
  name: string;
  fullName: string;
  kind: "class" | "struct" | "interface" | "record" | "enum";
  file: string;
  offset: number;
  line: number;
  column: number;
  /** Simple names of the base class and interfaces, without generic arguments or namespaces. */
  bases: string[];
  modifiers: string[];
  /** Public all the way out, so it's visible outside the assembly. */
  exported: boolean;
}

export interface CsPluginClass extends CsType {
  pluginKind: "plugin" | "workflow";
}

const TYPE_KEYWORDS = new Set(["class", "struct", "interface", "record", "enum"]);
const MODIFIERS = new Set(["public", "internal", "private", "protected", "abstract", "sealed", "static", "partial", "unsafe", "new", "readonly", "ref", "file"]);
const WORKFLOW_BASES = new Set(["Activity", "CodeActivity", "NativeActivity", "AsyncCodeActivity"]);

/** Blanks comments, strings and char literals (same length, so offsets stay exact). */
export function maskCSharp(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "#" && /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i))) {
      // preprocessor line (#region, #if ...)
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    // string literal, with any $ and @ prefix (holes in interpolated strings can hold more strings and braces)
    let j = i;
    while (text[j] === "$" || text[j] === "@") j++;
    if (text[j] === '"' && (j === i || /[$@]/.test(c))) {
      const stop = skipString(text, i);
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'") {
      let k = i + 1;
      while (k < text.length && text[k] !== "'" && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      blank(i, k + 1);
      i = k + 1;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) {
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Index just past a string literal that starts at `i` (at its $/@ prefix or quote). */
function skipString(text: string, i: number): number {
  let j = i;
  let verbatim = false;
  let interpolated = false;
  while (text[j] === "$" || text[j] === "@") {
    if (text[j] === "@") verbatim = true;
    else interpolated = true;
    j++;
  }
  if (text.startsWith('"""', j)) {
    let quotes = 0;
    while (text[j + quotes] === '"') quotes++;
    const close = text.indexOf('"'.repeat(quotes), j + quotes);
    return close < 0 ? text.length : close + quotes;
  }
  let k = j + 1;
  while (k < text.length) {
    const ch = text[k];
    if (interpolated && ch === "{") {
      if (text[k + 1] === "{") {
        k += 2;
        continue;
      }
      k = skipHole(text, k + 1, !verbatim);
      continue;
    }
    if (verbatim) {
      if (ch === '"') {
        if (text[k + 1] === '"') {
          k += 2;
          continue;
        }
        return k + 1;
      }
    } else {
      if (ch === "\\") {
        k += 2;
        continue;
      }
      if (ch === '"') return k + 1;
      if (ch === "\n") return k;
    }
    k++;
  }
  return k;
}

/**
 * Index just past the "}" that closes an interpolation hole starting at `k`. In a
 * regular (non-verbatim) string a line break ends it, so a half-typed $"{x
 * doesn't swallow the rest of the file.
 */
function skipHole(text: string, k: number, singleLine: boolean): number {
  let depth = 0;
  while (k < text.length) {
    const ch = text[k];
    if (singleLine && ch === "\n") return k;
    if (ch === '"' || ((ch === "$" || ch === "@") && /^[$@]*"/.test(text.slice(k + 1, k + 4)))) {
      k = skipString(text, k);
      continue;
    }
    if (ch === "'") {
      k++;
      while (k < text.length && text[k] !== "'" && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      k++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "}") {
      if (depth === 0) return k + 1;
      depth--;
    }
    k++;
  }
  return k;
}

/** Every type declared in one C# file. */
export function csharpTypes(source: string, file = ""): CsType[] {
  const text = maskCSharp(source);
  const types: CsType[] = [];
  type Scope = { depth: number; ns?: string; type?: CsType };
  const stack: Scope[] = [];
  let fileNamespace = "";
  let depth = 0;
  let pending: { ns?: string; type?: CsType } | undefined;
  const word = /[A-Za-z_][A-Za-z0-9_]*/y;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      depth++;
      if (pending) {
        stack.push({ depth, ...pending });
        pending = undefined;
      }
      i++;
      continue;
    }
    if (c === "}") {
      while (stack.length && stack[stack.length - 1].depth === depth) stack.pop();
      depth--;
      i++;
      continue;
    }
    if (c === ";" && pending) {
      // "namespace X;" (file-scoped) or "record R(int A);" with no body
      if (pending.ns !== undefined && !stack.length) fileNamespace = pending.ns;
      pending = undefined;
      i++;
      continue;
    }
    if (!/[A-Za-z_@]/.test(c) || (i > 0 && /[A-Za-z0-9_.]/.test(text[i - 1]))) {
      i++;
      continue;
    }
    word.lastIndex = c === "@" ? i + 1 : i;
    const m = word.exec(text);
    if (!m) {
      i++;
      continue;
    }
    const kw = m[0];
    const after = word.lastIndex;
    if (kw === "namespace") {
      const name = /^\s*([A-Za-z_][\w.]*)/.exec(text.slice(after));
      if (name) {
        pending = { ns: name[1] };
        i = after + name[0].length;
        continue;
      }
    }
    if (TYPE_KEYWORDS.has(kw)) {
      // "record class R" / "record struct R"
      let rest = text.slice(after);
      let kind = kw as CsType["kind"];
      const recordOf = kw === "record" ? /^\s+(class|struct)\b/.exec(rest) : null;
      if (recordOf) rest = rest.slice(recordOf[0].length);
      const decl = /^\s+([A-Za-z_]\w*)\s*(<[^>{;]*>)?/.exec(rest);
      // A declaration starts a statement: only modifiers and attributes may come before it.
      // That rules out "where T : class" and variables named record ("foreach (var record in ...)").
      const { modifiers, start } = modifiersBefore(text, i);
      let p = start;
      while (p > 0 && /\s/.test(text[p - 1])) p--;
      if (decl && (p === 0 || /[;{}]/.test(text[p - 1]))) {
        const head = after + (recordOf ? recordOf[0].length : 0) + decl[0].length;
        let k = head;
        let angle = 0;
        while (k < text.length && !(angle === 0 && (text[k] === "{" || text[k] === ";"))) {
          if (text[k] === "<") angle++;
          else if (text[k] === ">") angle--;
          k++;
        }
        const header = text.slice(head, k);
        const baseList = /^[^:]*?(?:\([^)]*\))?\s*:\s*([\s\S]*?)(?:\bwhere\b|$)/.exec(header);
        const bases = baseList ? splitTopLevel(baseList[1]).map(simpleName).filter(Boolean) : [];
        const arity = decl[2] ? splitTopLevel(decl[2].slice(1, -1)).length : 0;
        const name = arity ? `${decl[1]}\`${arity}` : decl[1];
        const outer = [...stack].reverse().find((s) => s.type)?.type;
        const ns = [fileNamespace, ...stack.filter((s) => s.ns !== undefined).map((s) => s.ns!)].filter(Boolean).join(".");
        const fullName = outer ? `${outer.fullName}+${name}` : ns ? `${ns}.${name}` : name;
        const isPublic = modifiers.includes("public");
        const type: CsType = {
          name,
          fullName,
          kind: recordOf ? "record" : kind,
          file,
          offset: i + (after - i) + (recordOf ? recordOf[0].length : 0) + decl[0].indexOf(decl[1]),
          line: 0,
          column: 0,
          bases,
          modifiers,
          exported: outer ? isPublic && outer.exported : isPublic,
        };
        type.line = lineOf(source, type.offset);
        type.column = type.offset - (source.lastIndexOf("\n", type.offset - 1) + 1);
        types.push(type);
        pending = { type };
        i = k;
        continue;
      }
    }
    i = after;
  }
  return types;
}

function modifiersBefore(text: string, at: number): { modifiers: string[]; start: number } {
  const modifiers: string[] = [];
  let j = at;
  for (;;) {
    let k = j;
    while (k > 0 && /\s/.test(text[k - 1])) k--;
    // attribute lists: [Something(...)]
    if (text[k - 1] === "]") {
      let depth = 0;
      let a = k - 1;
      for (; a >= 0; a--) {
        if (text[a] === "]") depth++;
        else if (text[a] === "[" && --depth === 0) break;
      }
      if (a < 0) return { modifiers, start: j };
      j = a;
      continue;
    }
    const m = /([A-Za-z_]\w*)$/.exec(text.slice(Math.max(0, k - 40), k));
    if (!m || !MODIFIERS.has(m[1])) return { modifiers, start: j };
    modifiers.unshift(m[1]);
    j = k - m[1].length;
  }
}

function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, k));
      start = k + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** "Microsoft.Xrm.Sdk.IPlugin" -> "IPlugin", "PluginBase<Account>" -> "PluginBase`1", "global::X.Y" -> "Y". */
function simpleName(typeRef: string): string {
  const generic = /<([\s\S]*)>\s*$/.exec(typeRef);
  const bare = typeRef.replace(/<[\s\S]*>\s*$/, "").trim();
  const last = bare.split(/\.|::/).pop()!.trim();
  return generic ? `${last}\`${splitTopLevel(generic[1]).length}` : last;
}

// ---------- projects ----------

const MSBUILD_DIR = /\$\(MSBuildThisFileDirectory\)|\$\(MSBuildProjectDirectory\)[\\/]?/gi;

/**
 * The .cs files compiled into a project: everything under its folder for
 * SDK-style projects, plus explicit Compile items (linked files) and shared
 * projects (.projitems) it imports.
 */
export function projectSourceFiles(csproj: string): string[] {
  const dir = path.dirname(csproj);
  const text = fs.readFileSync(csproj, "utf8");
  const files = new Set<string>();
  if (/<Project[^>]*\bSdk\s*=/i.test(text) || /<Sdk\s+Name=/i.test(text)) {
    for (const f of findFiles(dir, (n) => n.toLowerCase().endsWith(".cs"))) files.add(f);
  }
  const addIncludes = (xml: string, base: string) => {
    for (const m of xml.matchAll(/<Compile\s+Include\s*=\s*"([^"]+)"/gi)) {
      if (/[*?]/.test(m[1])) continue;
      const rel = m[1].replace(MSBUILD_DIR, "").replace(/\\/g, path.sep);
      const full = path.resolve(base, rel);
      if (full.toLowerCase().endsWith(".cs") && fs.existsSync(full)) files.add(full);
    }
  };
  addIncludes(text, dir);
  for (const m of text.matchAll(/<Import\s+Project\s*=\s*"([^"]+\.projitems)"/gi)) {
    const items = path.resolve(dir, m[1].replace(MSBUILD_DIR, "").replace(/\\/g, path.sep));
    if (fs.existsSync(items)) addIncludes(fs.readFileSync(items, "utf8"), path.dirname(items));
  }
  return [...files];
}

/** Types in the given files. Partial types declared in several files appear once per declaration. */
export function typesInFiles(files: string[]): CsType[] {
  const out: CsType[] = [];
  for (const f of files) {
    try {
      const mtime = fs.statSync(f).mtimeMs;
      let hit = parsed.get(f);
      if (!hit || hit.mtime !== mtime) {
        hit = { mtime, types: csharpTypes(fs.readFileSync(f, "utf8"), f) };
        parsed.set(f, hit);
      }
      out.push(...hit.types);
    } catch {
      // unreadable or deleted file
    }
  }
  return out;
}

/** Parsed files by path, reused until the file changes (CodeLens and the tree ask often). */
const parsed = new Map<string, { mtime: number; types: CsType[] }>();

/**
 * Plug-in and workflow classes among a project's types, by the Plugin
 * Registration Tool's rules: exported, not abstract or static, and implementing
 * IPlugin or deriving from Activity, directly or through other types in the
 * project (or elsewhere in the folder, for base classes kept in a shared library).
 */
export function pluginClassesIn(types: CsType[], lookup: CsType[] = []): CsPluginClass[] {
  const byName = new Map<string, CsType[]>();
  for (const t of [...types, ...lookup]) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  const kindOf = (t: CsType, seen: Set<CsType>): "plugin" | "workflow" | undefined => {
    if (seen.has(t)) return undefined;
    seen.add(t);
    for (const b of t.bases) {
      if (b === "IPlugin") return "plugin";
      if (WORKFLOW_BASES.has(b.replace(/`\d+$/, ""))) return "workflow";
      for (const candidate of byName.get(b) ?? []) {
        const k = kindOf(candidate, seen);
        if (k) return k;
      }
    }
    return undefined;
  };
  // Merge partial declarations: modifiers and bases from every part.
  const merged = new Map<string, CsType>();
  for (const t of types) {
    if (t.kind !== "class" && t.kind !== "record") continue;
    const prior = merged.get(t.fullName);
    if (!prior) merged.set(t.fullName, { ...t, bases: [...t.bases], modifiers: [...t.modifiers] });
    else {
      prior.bases.push(...t.bases.filter((b) => !prior.bases.includes(b)));
      prior.modifiers.push(...t.modifiers.filter((m) => !prior.modifiers.includes(m)));
      prior.exported = prior.exported || t.exported;
    }
  }
  const out: CsPluginClass[] = [];
  for (const t of merged.values()) {
    if (!t.exported || t.modifiers.includes("abstract") || t.modifiers.includes("static") || t.fullName.includes("`")) continue;
    const parts = types.filter((x) => x.fullName === t.fullName);
    const k = kindOf(t, new Set()) ?? parts.map((p) => kindOf(p, new Set())).find(Boolean);
    if (k) out.push({ ...t, pluginKind: k });
  }
  return out;
}

/** Plug-in classes of a project, resolving base classes through the rest of the folder when needed. */
export function projectPluginClasses(csproj: string, searchRoot?: string): CsPluginClass[] {
  const types = typesInFiles(projectSourceFiles(csproj));
  const direct = pluginClassesIn(types);
  const unresolved = types.some((t) => t.kind === "class" && t.bases.length && !direct.some((d) => d.fullName === t.fullName));
  if (!unresolved || !searchRoot || !isDirectory(searchRoot)) return direct;
  const own = new Set(types.map((t) => t.file));
  const others = typesInFiles(findFiles(searchRoot, (n, full) => n.toLowerCase().endsWith(".cs") && !own.has(full)));
  return pluginClassesIn(types, others);
}

/** The declaration of a type, preferring the given project's files. */
export function findType(typeName: string, files: string[], fallbackRoot?: string): CsType | undefined {
  const short = typeName.split(/[.+]/).pop()!;
  const match = (list: CsType[]) => {
    const exact = list.find((t) => t.fullName === typeName) ?? list.find((t) => t.fullName.replace(/\+/g, ".") === typeName.replace(/\+/g, "."));
    if (exact) return exact;
    // A bare class name, or a namespace that has since changed: only when the short name is unambiguous.
    const named = list.filter((t) => t.kind === "class" && t.name === short);
    return named.length === 1 ? named[0] : undefined;
  };
  const hit = match(typesInFiles(files));
  if (hit || !fallbackRoot) return hit;
  return match(typesInFiles(findFiles(fallbackRoot, (n) => n.toLowerCase().endsWith(".cs"))));
}
