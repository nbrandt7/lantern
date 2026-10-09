/**
 * Static analysis of form scripts and plug-in classes: which functions a library
 * defines, what each one touches (columns, controls, tabs, Web API calls, other
 * functions), and which columns a plug-in reads and writes. It reads source text,
 * so names built at runtime are reported as dynamic instead of guessed.
 */

// ---------- scanning helpers ----------

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

/**
 * Two same-length copies of a script, so offsets, lines and columns stay exact:
 *  - noComments: comments and regex literals blanked (strings kept, for names like getAttribute("fax"))
 *  - codeOnly: string contents blanked too, for finding definitions and matching braces
 */
export function maskJs(text: string): { noComments: string; codeOnly: string } {
  const a = text.split("");
  const b = text.split("");
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== "\n" && arr[k] !== "\r") arr[k] = " ";
  };
  let i = 0;
  let prev = "";
  let prevWord = "";
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(a, i, stop);
      blank(b, i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(a, i, stop);
      blank(b, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (c !== "`" && text[j] === "\n") break;
        j++;
      }
      blank(b, i + 1, Math.min(j, text.length));
      i = j + 1;
      prev = c;
      prevWord = "";
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_BEFORE.has(prev) || REGEX_AFTER_WORD.has(prevWord))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j++;
      }
      if (text[j] === "/") {
        j++;
        while (/[a-z]/i.test(text[j] ?? "")) j++;
        blank(a, i, j);
        blank(b, i, j);
        i = j;
        prev = "/";
        prevWord = "";
        continue;
      }
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j++;
      prevWord = text.slice(i, j);
      prev = text[j - 1];
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = "";
    }
    i++;
  }
  return { noComments: a.join(""), codeOnly: b.join("") };
}

/** Index of the brace matching the "{" at `open`, skipping strings and comments. -1 if unbalanced. */
export function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && next === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "else", "do", "try", "new", "typeof", "await"]);

// ---------- JavaScript outline ----------

export interface JsFunction {
  /** Last segment, e.g. "onLoad". */
  name: string;
  /** As written in an assignment, e.g. "Acme.Account.onLoad" or "this.formOnLoad". */
  written: string;
  line: number;
  character: number;
  bodyStart: number;
  bodyEnd: number;
}

/** Functions a script defines, in source order. */
export function outlineJs(source: string): JsFunction[] {
  // Definitions are found in code only: not in comments, strings, or regex literals.
  const text = maskJs(source).codeOnly;
  const found: JsFunction[] = [];
  const seen = new Set<number>();
  // prefix: the "this." / "Acme.Account." before the name, when there is one.
  const patterns: Array<{ re: RegExp; prefix?: number; name: number; arrow?: boolean }> = [
    { re: /\bfunction\s*\*?\s*([\w$]+)\s*\(/g, name: 1 },
    { re: /((?:[\w$]+\.)*)([\w$]+)\s*=\s*(?:async\s+)?function\b[^(]*\(/g, prefix: 1, name: 2 },
    { re: /([\w$]+)\s*:\s*(?:async\s+)?function\b[^(]*\(/g, name: 1 },
    { re: /((?:[\w$]+\.)*)([\w$]+)\s*[=:]\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/g, prefix: 1, name: 2, arrow: true },
    { re: /^[ \t]*(?:async\s+|static\s+)*([\w$]+)\s*\([^)]*\)\s*\{/gm, name: 1 },
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const name = m[p.name];
      const prefix = p.prefix ? m[p.prefix] ?? "" : "";
      if (!name || KEYWORDS.has(name)) continue;
      const written = `${prefix}${name}`;
      const nameAt = m.index + m[0].indexOf(written) + prefix.length;
      if (seen.has(nameAt)) continue;
      const end = m.index + m[0].length;
      let bodyStart: number;
      let bodyEnd: number;
      if (p.arrow && !/^\s*\{/.test(text.slice(end))) {
        // Expression-bodied arrow: up to the end of the statement.
        bodyStart = end;
        const semi = text.indexOf(";", end);
        bodyEnd = semi < 0 ? text.length : semi;
      } else {
        const open = text.indexOf("{", p.arrow ? end : end - 1);
        if (open < 0) continue;
        bodyStart = open;
        bodyEnd = matchBrace(text, open);
        if (bodyEnd < 0) continue;
      }
      seen.add(nameAt);
      found.push({ name, written, line: lineOf(text, nameAt), character: nameAt - (text.lastIndexOf("\n", nameAt - 1) + 1), bodyStart, bodyEnd });
    }
  }
  return found.sort((a, b) => a.bodyStart - b.bodyStart);
}

/** The innermost function whose body contains the offset. */
export function functionAt(outline: JsFunction[], offset: number): JsFunction | undefined {
  return outline
    .filter((f) => offset >= f.bodyStart && offset <= f.bodyEnd)
    .sort((a, b) => a.bodyEnd - a.bodyStart - (b.bodyEnd - b.bodyStart))[0];
}

export function findJsFunction(outline: JsFunction[], name: string): JsFunction | undefined {
  const last = name.split(".").pop() ?? name;
  return outline.find((f) => f.written === name || f.written.endsWith(`.${name}`)) ?? outline.find((f) => f.name === last);
}

// ---------- what a JS function touches ----------

export interface Touch {
  name: string;
  /** Methods called on it, e.g. ["getValue", "setValue"]; empty when only looked up. */
  methods: string[];
  line: number;
}

export interface FunctionTouches {
  fn: JsFunction;
  columns: Touch[];
  controls: Touch[];
  tabs: Touch[];
  sections: Array<Touch & { tab: string }>;
  webApi: Array<{ operation: string; table: string; line: number }>;
  calls: Array<{ name: string; line: number }>;
  dynamic: Array<{ text: string; line: number }>;
}

const Q = `(["'\`])`;

function addTouch(list: Touch[], name: string, method: string | undefined, line: number): void {
  let t = list.find((x) => x.name === name);
  if (!t) list.push((t = { name, methods: [], line }));
  if (method && !t.methods.includes(method)) t.methods.push(method);
}

export function analyzeJsFunction(source: string, fn: JsFunction, outline: JsFunction[]): FunctionTouches {
  const text = maskJs(source).noComments;
  const body = text.slice(fn.bodyStart, fn.bodyEnd + 1);
  const at = (i: number) => lineOf(text, fn.bodyStart + i);
  const out: FunctionTouches = { fn, columns: [], controls: [], tabs: [], sections: [], webApi: [], calls: [], dynamic: [] };

  const lookups: Array<[string, Touch[]]> = [["getAttribute", out.columns], ["getControl", out.controls]];
  for (const [call, list] of lookups) {
    // Direct: getAttribute("fax").setValue(...)
    const direct = new RegExp(`\\b${call}\\(\\s*${Q}([\\w]+)\\1\\s*\\)(?:\\s*(?:\\?\\.|\\.)\\s*([\\w$]+))?`, "g");
    let m: RegExpExecArray | null;
    while ((m = direct.exec(body))) addTouch(list, m[2], m[3], at(m.index));
    // Through a variable: const fax = formContext.getAttribute("fax"); fax.getValue()
    const assigned = new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*[^;\\n]*?\\b${call}\\(\\s*${Q}([\\w]+)\\2\\s*\\)\\s*;?`, "g");
    while ((m = assigned.exec(body))) {
      const [, variable, , name] = m;
      const uses = new RegExp(`\\b${esc(variable)}\\s*(?:\\?\\.|\\.)\\s*([\\w$]+)\\s*\\(`, "g");
      let u: RegExpExecArray | null;
      let any = false;
      while ((u = uses.exec(body))) {
        addTouch(list, name, u[1], at(u.index));
        any = true;
      }
      if (!any) addTouch(list, name, undefined, at(m.index));
    }
    const dynamic = new RegExp(`\\b${call}\\(\\s*(?!["'\`)])([^)]*)\\)`, "g");
    while ((m = dynamic.exec(body))) out.dynamic.push({ text: `${call}(${m[1].trim()})`, line: at(m.index) });
  }

  // tabs.get("t").sections.get("s").setVisible(...)
  const tabRe = new RegExp(`\\btabs\\.get\\(\\s*${Q}([\\w]+)\\1\\s*\\)(?:\\s*(?:\\?\\.|\\.)\\s*sections\\.get\\(\\s*${Q}([\\w]+)\\3\\s*\\))?(?:\\s*(?:\\?\\.|\\.)\\s*([\\w$]+))?`, "g");
  let m: RegExpExecArray | null;
  while ((m = tabRe.exec(body))) {
    const [, , tab, , section, method] = m;
    if (section) {
      let s = out.sections.find((x) => x.name === section && x.tab === tab);
      if (!s) out.sections.push((s = { name: section, tab, methods: [], line: at(m.index) }));
      if (method && method !== "get" && !s.methods.includes(method)) s.methods.push(method);
      addTouch(out.tabs, tab, undefined, at(m.index));
    } else addTouch(out.tabs, tab, method === "sections" ? undefined : method, at(m.index));
  }

  const api = new RegExp(`\\bXrm\\.WebApi\\.(?:online\\.|offline\\.)?([\\w]+)\\(\\s*${Q}([\\w]+)\\2`, "g");
  while ((m = api.exec(body))) out.webApi.push({ operation: m[1], table: m[3], line: at(m.index) });

  for (const other of outline) {
    if (other === fn) continue;
    const call = new RegExp(`(?:^|[^\\w$.])(?:[\\w$]+\\.)*${esc(other.name)}\\s*\\(`, "g");
    const hit = call.exec(body);
    // A definition of the same name inside this body isn't a call.
    if (hit && !(other.bodyStart > fn.bodyStart && other.bodyEnd <= fn.bodyEnd)) out.calls.push({ name: other.name, line: at(hit.index) });
  }
  return out;
}

/** Which defined functions call which: name -> callers. */
export function callersIn(text: string, outline: JsFunction[]): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const fn of outline) {
    for (const c of analyzeJsFunction(text, fn, outline).calls) callers.set(c.name, [...(callers.get(c.name) ?? []), fn.name]);
  }
  return callers;
}

// ---------- C# plug-in classes ----------

export interface ColumnUse {
  column: string;
  /** "Target", an image alias, or "other" for other Entity variables. */
  source: string;
  line: number;
  /** Read through Contains or TryGetAttributeValue somewhere, so a missing value is handled. */
  guarded?: boolean;
}

export interface PluginAnalysis {
  className: string;
  classLine: number;
  reads: ColumnUse[];
  writes: ColumnUse[];
  /** Image aliases the code asks for, with whether they're pre or post images. */
  images: Array<{ alias: string; kind: "Pre" | "Post"; line: number }>;
  /** Tables the class creates, updates, or queries through other Entity / QueryExpression objects. */
  otherTables: Array<{ table: string; how: string; line: number }>;
}

export function analyzePluginClass(text: string, className: string): PluginAnalysis | undefined {
  const cls = new RegExp(`\\bclass\\s+${esc(className)}\\b[^{]*\\{`).exec(text);
  if (!cls) return undefined;
  const open = cls.index + cls[0].length - 1;
  const close = matchBrace(text, open);
  const body = text.slice(open, close < 0 ? text.length : close + 1);
  const at = (i: number) => lineOf(text, open + i);
  const out: PluginAnalysis = { className, classLine: lineOf(text, cls.index), reads: [], writes: [], images: [], otherTables: [] };

  // Which variable holds what.
  const sources = new Map<string, string>();
  let m: RegExpExecArray | null;
  const targetPatterns = [
    /(?:var|Entity)\s+(\w+)\s*=\s*\(\s*Entity\s*\)\s*[\w.]*InputParameters\s*\[\s*"Target"\s*\]/g,
    /(\w+)\s*=\s*[\w.]*InputParameters\s*\[\s*"Target"\s*\]\s+as\s+Entity/g,
    /"Target"[^;]*?\bis\s+Entity\s+(\w+)/g,
    /(?:var|Entity)\s+(\w+)\s*=\s*[^;]*Get(?:Target|InputParameter<Entity>\(\s*"Target")/g,
  ];
  for (const re of targetPatterns) while ((m = re.exec(body))) sources.set(m[1], "Target");
  const imagePatterns = [
    /(?:var|Entity)\s+(\w+)\s*=\s*[^;]*?(Pre|Post)EntityImages\s*\[\s*"(\w+)"\s*\]/g,
    /(?:var|Entity)\s+(\w+)\s*=\s*[^;]*?(Pre|Post)EntityImages\.TryGetValue\(\s*"(\w+)"\s*,\s*out\s+(?:var|Entity)\s+(\w+)/g,
    /(Pre|Post)EntityImages\.TryGetValue\(\s*"(\w+)"\s*,\s*out\s+(?:var|Entity)\s+(\w+)/g,
  ];
  for (const re of imagePatterns) {
    while ((m = re.exec(body))) {
      const groups = m.slice(1);
      const kindIdx = groups.findIndex((g) => g === "Pre" || g === "Post");
      const kind = groups[kindIdx] as "Pre" | "Post";
      const alias = groups[kindIdx + 1];
      const vars = groups.filter((g, i) => g && i !== kindIdx && i !== kindIdx + 1);
      for (const v of vars) sources.set(v, `${kind}Image:${alias}`);
      if (!out.images.some((x) => x.alias === alias && x.kind === kind)) out.images.push({ alias, kind, line: at(m.index) });
    }
  }
  const newEntity = /(?:var|Entity)\s+(\w+)\s*=\s*new\s+Entity\s*\(\s*"(\w+)"/g;
  while ((m = newEntity.exec(body))) {
    sources.set(m[1], "other");
    out.otherTables.push({ table: m[2], how: "creates or updates", line: at(m.index) });
  }
  const query = /new\s+QueryExpression\s*\(\s*"(\w+)"|<entity\s+name\s*=\s*['"](\w+)['"]/g;
  while ((m = query.exec(body))) out.otherTables.push({ table: m[1] ?? m[2], how: "queries", line: at(m.index) });

  const push = (list: ColumnUse[], column: string, source: string, line: number, guarded = false) => {
    const existing = list.find((x) => x.column === column && x.source === source);
    if (existing) existing.guarded = existing.guarded || guarded;
    else list.push({ column, source, line, ...(guarded ? { guarded } : {}) });
  };
  // How an Entity expression is read: [pattern after the expression, whether it handles a missing value].
  const readers: Array<[string, boolean]> = [
    ['\\??\\.GetAttributeValue<[^>]+>\\(\\s*"(\\w+)"', false],
    ['\\??\\.TryGetAttributeValue<[^>]+>\\(\\s*"(\\w+)"', true],
    ['\\??(?:\\.Attributes)?\\.(?:Contains|ContainsKey)\\(\\s*"(\\w+)"', true],
    ['(?:\\.Attributes)?\\[\\s*"(\\w+)"\\s*\\](?!\\s*=[^=])', false],
  ];
  const writers = ['(?:\\.Attributes)?\\[\\s*"(\\w+)"\\s*\\]\\s*=(?!=)', '\\.Attributes\\.Add\\(\\s*"(\\w+)"'];
  const scan = (expr: string, source: string) => {
    for (const [after, guarded] of readers) {
      const re = new RegExp(expr + after, "g");
      while ((m = re.exec(body))) push(out.reads, m[m.length - 1], source, at(m.index), guarded);
    }
    for (const after of writers) {
      const re = new RegExp(expr + after, "g");
      while ((m = re.exec(body))) push(out.writes, m[m.length - 1], source, at(m.index));
    }
  };
  for (const [variable, source] of sources) scan(`\\b${esc(variable)}`, source === "other" ? "other" : source);
  // Reads straight off the expression, without a variable.
  scan('\\(\\s*\\(\\s*Entity\\s*\\)\\s*[\\w.]*InputParameters\\s*\\[\\s*"Target"\\s*\\]\\s*\\)', "Target");
  for (const img of out.images) scan(`${img.kind}EntityImages\\s*\\[\\s*"${esc(img.alias)}"\\s*\\]`, `${img.kind}Image:${img.alias}`);
  return out;
}

export interface StepImage {
  alias: string;
  kind: "Pre" | "Post";
  /** Empty means all columns. */
  attributes: string[];
}

/**
 * Problems between a plug-in class and its step registration:
 *  - an image the code reads that the step doesn't register
 *  - a column read from an image that the image doesn't include
 *  - on Update, columns read from Target, which only holds the columns that changed
 */
export function pluginWarnings(a: PluginAnalysis, step: { message: string; filtering: string[]; images: StepImage[] }): string[] {
  const warnings: string[] = [];
  for (const img of a.images) {
    if (!step.images.some((i) => i.alias.toLowerCase() === img.alias.toLowerCase() && i.kind === img.kind)) {
      warnings.push(`The code reads the ${img.kind.toLowerCase()}-image "${img.alias}", but this step has no ${img.kind.toLowerCase()}-image with that alias, so it will be missing at runtime.`);
    }
  }
  for (const r of a.reads) {
    const m = /^(Pre|Post)Image:(.+)$/.exec(r.source);
    if (!m) continue;
    const img = step.images.find((i) => i.alias.toLowerCase() === m[2].toLowerCase() && i.kind === m[1]);
    if (img && img.attributes.length && !img.attributes.includes(r.column)) {
      warnings.push(`${r.column} is read from the "${img.alias}" image (line ${r.line + 1}), but that image only includes ${img.attributes.join(", ")}.`);
    }
  }
  if (step.message.toLowerCase() === "update") {
    // Reads that go through Contains or TryGetAttributeValue already handle a missing column.
    const fromTarget = [...new Set(a.reads.filter((r) => r.source === "Target" && !r.guarded).map((r) => r.column))].filter(
      (c) => !step.filtering.length || !step.filtering.includes(c)
    );
    if (fromTarget.length) {
      const one = fromTarget.length === 1;
      warnings.push(
        `On Update, Target only contains the columns that changed. ${fromTarget.join(", ")} ${one ? "is" : "are"} read from Target but ` +
          (step.filtering.length ? "not in the step's filtering columns" : (one ? "can be absent" : "can each be absent") + " whenever another column triggers the update") +
          `, so ${one ? "the value" : "the values"} may be missing. Read ${one ? "it" : "them"} from an image instead, or check Contains first.`
      );
    }
  }
  return warnings;
}

/** Enclosing C# method name for a line, for "used in Execute" style references. */
export function csMethodAt(text: string, line: number): string | undefined {
  const lines = text.split(/\r?\n/).slice(0, line + 1).reverse();
  for (const l of lines) {
    const m = /^\s*(?:(?:public|private|protected|internal|static|override|virtual|async|sealed)\s+)+[\w<>\[\],.?\s]+?\s(\w+)\s*\(/.exec(l);
    if (m && !KEYWORDS.has(m[1])) return m[1];
  }
  return undefined;
}
