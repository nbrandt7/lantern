/**
 * FetchXML written inside code: string literals (or + concatenations of them) that
 * contain <fetch ... </fetch>. Values spliced in at runtime become placeholders:
 *   JS  `...${id}...`        C#  $@"...{id}..."       C#  string.Format("...{0}...")
 *   "...'" + id + "'..."     (a concatenated expression, shown as {{id}})
 */

export type LiteralKind = "template" | "single" | "double" | "verbatim" | "interpolated" | "raw";

export interface FetchLiteral {
  /** Offset of the first character of the first literal (its opening quote or prefix). */
  start: number;
  /** Offset just past the last literal's closing quote. */
  end: number;
  /** The FetchXML with escapes resolved and spliced expressions as placeholders. */
  text: string;
  kind: LiteralKind;
  /** More than one literal joined with +. */
  concatenated: boolean;
  line: number;
}

interface Literal {
  start: number;
  end: number;
  content: string;
  kind: LiteralKind;
}

/** Every string literal in the source, with its decoded content. */
function literals(source: string, language: "js" | "cs"): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      const e = source.indexOf("\n", i);
      i = e < 0 ? source.length : e;
      continue;
    }
    if (c === "/" && n === "*") {
      const e = source.indexOf("*/", i + 2);
      i = e < 0 ? source.length : e + 2;
      continue;
    }
    if (language === "cs" && source.startsWith('"""', i)) {
      const e = source.indexOf('"""', i + 3);
      if (e < 0) break;
      out.push({ start: i, end: e + 3, content: source.slice(i + 3, e).replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, ""), kind: "raw" });
      i = e + 3;
      continue;
    }
    const csPrefix = language === "cs" ? /^(\$@|@\$|@|\$)"/.exec(source.slice(i, i + 3))?.[1] : undefined;
    if (csPrefix !== undefined) {
      const verbatim = csPrefix.includes("@");
      let j = i + csPrefix.length + 1;
      let content = "";
      while (j < source.length) {
        if (verbatim && source[j] === '"' && source[j + 1] === '"') {
          content += '"';
          j += 2;
          continue;
        }
        if (!verbatim && source[j] === "\\") {
          content += unescapeC(source[j + 1]);
          j += 2;
          continue;
        }
        if (source[j] === '"') break;
        content += source[j++];
      }
      out.push({ start: i, end: j + 1, content, kind: csPrefix.includes("$") ? "interpolated" : verbatim ? "verbatim" : "double" });
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && language === "js")) {
      let j = i + 1;
      let content = "";
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") {
          content += unescapeC(source[j + 1]);
          j += 2;
          continue;
        }
        if (c !== "`" && source[j] === "\n") break;
        content += source[j++];
      }
      out.push({ start: i, end: j + 1, content, kind: c === "`" ? "template" : c === "'" ? "single" : "double" });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function unescapeC(ch: string | undefined): string {
  return ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch ?? "";
}

/** FetchXML literals in a file, joining "a" + x + "b" chains into one with {{x}} placeholders. */
export function findFetchLiterals(source: string, language: "js" | "cs"): FetchLiteral[] {
  const all = literals(source, language);
  const found: FetchLiteral[] = [];
  for (let k = 0; k < all.length; k++) {
    const first = all[k];
    if (!/<fetch[\s>]/i.test(first.content)) continue;
    let text = first.content;
    let end = first.end;
    let m = k;
    // Follow + chains until </fetch>, turning expressions between literals into placeholders.
    while (!/<\/fetch>|<fetch[^>]*\/>/i.test(text) && m + 1 < all.length) {
      const between = source.slice(all[m].end, all[m + 1].start);
      if (!/^\s*\+[\s\S]*\+?\s*$/.test(between) || /[;{}]/.test(between)) break;
      const expr = between.replace(/^\s*\+\s*/, "").replace(/\s*\+\s*$/, "").trim();
      if (expr) text += `{{${expr}}}`;
      m++;
      text += all[m].content;
      end = all[m].end;
    }
    if (!/<\/fetch>|<fetch[^>]*\/>/i.test(text)) continue;
    found.push({ start: first.start, end, text, kind: first.kind, concatenated: m > k, line: source.slice(0, first.start).split("\n").length - 1 });
    k = m;
  }
  return found;
}

/** Placeholders in a literal's FetchXML, in order of appearance, without repeats. */
export function placeholders(lit: FetchLiteral): string[] {
  const res: string[] = [];
  const patterns = [/\$\{([^}]+)\}/g, /\{\{([^}]+)\}\}/g, /\{(\d+)\}/g];
  if (lit.kind === "interpolated") patterns.push(/(?<!\{)\{([A-Za-z_][\w.()]*)\}(?!\})/g);
  const marks: Array<{ at: number; token: string }> = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(lit.text))) marks.push({ at: m.index, token: m[0] });
  }
  for (const mk of marks.sort((a, b) => a.at - b.at)) if (!res.includes(mk.token)) res.push(mk.token);
  return res;
}

/** The FetchXML with each placeholder replaced by the value given for it. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(values)) out = out.split(token).join(value);
  return out;
}

/** Source code for a literal holding this text, in the literal's original style. */
export function encodeLiteral(text: string, kind: LiteralKind, language: "js" | "cs"): string {
  if (language === "js") {
    // Always a template literal: FetchXML spans lines; ${...} placeholders stay live.
    return "`" + text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\{\{([^}]+)\}\}/g, "${$1}") + "`";
  }
  if (kind === "raw") return `"""\n${text}\n"""`;
  const interpolated = kind === "interpolated" || /\{\{[^}]+\}\}/.test(text);
  const body = text.replace(/"/g, '""').replace(/\{\{([^}]+)\}\}/g, "{$1}");
  return `${interpolated ? "$@" : "@"}"${body}"`;
}
