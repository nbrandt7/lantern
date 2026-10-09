/**
 * Translates a read-only SQL dialect into FetchXML, so you can query Dataverse the
 * way you'd query SQL Server. Supported:
 *
 *   SELECT [DISTINCT] [TOP n] *, t.*, col [AS alias], COUNT(*), COUNT([DISTINCT] col), SUM/AVG/MIN/MAX(col)
 *   FROM table [AS] [alias]
 *   [INNER | LEFT [OUTER]] JOIN table [AS] alias ON a.col = b.col   (any number, nestable)
 *   WHERE  =, <>, !=, <, <=, >, >=, [NOT] LIKE, [NOT] IN (...), IS [NOT] NULL, [NOT] BETWEEN, AND, OR, NOT, ( )
 *   GROUP BY col, ...
 *   ORDER BY col | alias [ASC | DESC], ...
 *
 * Statements are separated by ";" or a line containing only GO.
 */

export class SqlError extends Error {
  constructor(message: string, public readonly position?: number) {
    super(message);
  }
}

// ---------- tokens ----------

type TokKind = "word" | "string" | "number" | "op" | "punct" | "eof";
interface Tok {
  kind: TokKind;
  value: string;
  /** Uppercased word, for keyword checks. Empty for quoted identifiers so they never act as keywords. */
  upper: string;
  pos: number;
  /** The quote a quoted identifier used: [ or ". */
  quote?: string;
}

export function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    const start = i;
    if ((c === "N" || c === "n") && sql[i + 1] === "'") i++;
    if (sql[i] === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= sql.length) throw new SqlError("Unclosed string literal.", start);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += sql[i++];
      }
      toks.push({ kind: "string", value, upper: "", pos: start });
      continue;
    }
    if (c === "[" || c === '"') {
      const close = c === "[" ? "]" : '"';
      const end = sql.indexOf(close, i + 1);
      if (end < 0) throw new SqlError(`Unclosed ${c} identifier.`, i);
      toks.push({ kind: "word", value: sql.slice(i + 1, end), upper: "", pos: i, quote: c });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(sql.slice(i))!;
      toks.push({ kind: "number", value: m[0], upper: "", pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_@#]/.test(c)) {
      const m = /^[A-Za-z_@#][\w@#$]*/.exec(sql.slice(i))!;
      toks.push({ kind: "word", value: m[0], upper: m[0].toUpperCase(), pos: i });
      i += m[0].length;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (["<=", ">=", "<>", "!="].includes(two)) {
      toks.push({ kind: "op", value: two, upper: two, pos: i });
      i += 2;
      continue;
    }
    if ("=<>".includes(c)) {
      toks.push({ kind: "op", value: c, upper: c, pos: i });
      i++;
      continue;
    }
    if ("(),.*;-+".includes(c)) {
      toks.push({ kind: "punct", value: c, upper: c, pos: i });
      i++;
      continue;
    }
    throw new SqlError(`Unexpected character "${c}".`, i);
  }
  toks.push({ kind: "eof", value: "", upper: "", pos: sql.length });
  return toks;
}

/** Splits a script into statements on ";" and lines that only say GO. Returns each statement's text. */
export function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  // Same length as the original, so token positions map straight back to the text.
  const normalized = sql.replace(/^[ \t]*GO[ \t]*$/gim, (m) => ";".padEnd(m.length, " "));
  const toks = tokenize(normalized);
  let start = 0;
  for (const t of toks) {
    if (t.kind === "eof" || (t.kind === "punct" && t.value === ";")) {
      const text = normalized.slice(start, t.pos).trim();
      if (text && tokenize(text).length > 1) parts.push(text);
      start = t.pos + 1;
    }
  }
  return parts;
}

// ---------- AST ----------

export interface ColumnRef {
  table?: string;
  column: string;
}

export type SelectItem =
  | { kind: "all"; table?: string }
  | { kind: "column"; ref: ColumnRef; alias?: string }
  | { kind: "aggregate"; fn: "count" | "countcolumn" | "sum" | "avg" | "min" | "max"; ref?: ColumnRef; distinct: boolean; alias?: string };

export type Literal = string | number | null;

export type Cond =
  | { kind: "and" | "or"; items: Cond[] }
  | { kind: "not"; item: Cond }
  | { kind: "cmp"; ref: ColumnRef; op: string; values: Literal[] };

interface Join {
  outer: boolean;
  table: string;
  alias: string;
  left: ColumnRef;
  right: ColumnRef;
}

export interface SelectQuery {
  distinct: boolean;
  top?: number;
  items: SelectItem[];
  from: { table: string; alias: string };
  joins: Join[];
  where?: Cond;
  groupBy: ColumnRef[];
  /** Conditions on aggregates. FetchXML has no HAVING, so these filter the grouped rows afterwards. */
  having?: Having[];
  orderBy: Array<{ ref: ColumnRef; desc: boolean }>;
}

export interface Having {
  /** An aggregate like COUNT(*) / SUM(col), or a select alias like "count". */
  target: { fn?: "count" | "countcolumn" | "sum" | "avg" | "min" | "max"; column?: string; alias?: string };
  op: "eq" | "ne" | "lt" | "le" | "gt" | "ge";
  value: number;
}

// ---------- parser ----------

const RESERVED = new Set([
  "SELECT", "DISTINCT", "TOP", "FROM", "AS", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ON", "WHERE",
  "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "GROUP", "BY", "ORDER", "ASC", "DESC", "HAVING",
  "UNION", "INSERT", "UPDATE", "DELETE", "INTO", "VALUES", "SET",
]);

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private get t(): Tok {
    return this.toks[this.i];
  }
  private peek(n = 1): Tok {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)];
  }
  private is(word: string): boolean {
    return this.t.kind === "word" && this.t.upper === word;
  }
  private isPunct(p: string): boolean {
    return this.t.kind === "punct" && this.t.value === p;
  }
  private accept(word: string): boolean {
    if (this.is(word)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(word: string): void {
    if (!this.accept(word)) throw this.error(`Expected ${word}`);
  }
  private expectPunct(p: string): void {
    if (!this.isPunct(p)) throw this.error(`Expected "${p}"`);
    this.i++;
  }
  private error(message: string): SqlError {
    const near = this.t.kind === "eof" ? "the end of the query" : `"${this.t.value}"`;
    return new SqlError(`${message} near ${near}.`, this.t.pos);
  }

  private identifier(what: string): string {
    if (this.t.kind !== "word" || (this.t.upper && RESERVED.has(this.t.upper))) throw this.error(`Expected a ${what} name`);
    return this.toks[this.i++].value;
  }

  /** SELECT, UPDATE, or DELETE. */
  statement(): Statement {
    if (this.accept("INSERT")) {
      this.expect("INTO");
      const table = this.identifier("table").toLowerCase();
      this.expectPunct("(");
      const columns: string[] = [];
      do {
        if (this.isPunct(",")) this.i++;
        columns.push(this.identifier("column").toLowerCase());
      } while (this.isPunct(","));
      this.expectPunct(")");
      this.expect("VALUES");
      const rows: Literal[][] = [];
      do {
        if (this.isPunct(",")) this.i++;
        this.expectPunct("(");
        const row: Literal[] = [];
        do {
          if (this.isPunct(",")) this.i++;
          row.push(this.literal());
        } while (this.isPunct(","));
        this.expectPunct(")");
        rows.push(row);
      } while (this.isPunct(","));
      this.end();
      return { kind: "insert", table, alias: table, columns, rows };
    }
    if (this.accept("UPDATE")) {
      const table = this.identifier("table");
      const alias = (this.tableAlias() ?? table).toLowerCase();
      this.expect("SET");
      const sets: Array<{ column: string; value: Literal }> = [];
      do {
        if (this.isPunct(",")) this.i++;
        const ref = this.columnRef();
        if (!(this.t.kind === "op" && this.t.value === "=")) throw this.error("Expected = in SET");
        this.i++;
        sets.push({ column: ref.column, value: this.literal() });
      } while (this.isPunct(","));
      const where = this.accept("WHERE") ? this.orCond() : undefined;
      this.end();
      return { kind: "update", table: table.toLowerCase(), alias, sets, where };
    }
    if (this.accept("DELETE")) {
      this.accept("FROM");
      const table = this.identifier("table");
      const alias = (this.tableAlias() ?? table).toLowerCase();
      const where = this.accept("WHERE") ? this.orCond() : undefined;
      this.end();
      return { kind: "delete", table: table.toLowerCase(), alias, where };
    }
    return { kind: "select", query: this.parse() };
  }

  private end(): void {
    if (this.isPunct(";")) this.i++;
    if (this.t.kind !== "eof") throw this.error("Unexpected text");
  }

  parse(): SelectQuery {
    if (["INSERT", "UPDATE", "DELETE"].some((w) => this.is(w))) {
      throw new SqlError(`${this.t.upper} changes data, so it has no FetchXML. Run it with F5 to preview and confirm the change.`, this.t.pos);
    }
    this.expect("SELECT");
    const distinct = this.accept("DISTINCT");
    let top: number | undefined;
    if (this.accept("TOP")) {
      const paren = this.isPunct("(");
      if (paren) this.i++;
      if (this.t.kind !== "number") throw this.error("Expected a number after TOP");
      top = Number(this.toks[this.i++].value);
      if (paren) this.expectPunct(")");
    }
    const items: SelectItem[] = [this.selectItem()];
    while (this.isPunct(",")) {
      this.i++;
      items.push(this.selectItem());
    }
    this.expect("FROM");
    const fromTable = this.identifier("table");
    const from = { table: fromTable.toLowerCase(), alias: (this.tableAlias() ?? fromTable).toLowerCase() };

    const joins: Join[] = [];
    for (;;) {
      let outer = false;
      if (this.is("RIGHT") || this.is("FULL") || this.is("CROSS")) throw new SqlError(`${this.t.upper} JOIN isn't supported; use INNER or LEFT JOIN.`, this.t.pos);
      if (this.accept("LEFT")) {
        outer = true;
        this.accept("OUTER");
        this.expect("JOIN");
      } else if (this.accept("INNER")) this.expect("JOIN");
      else if (!this.accept("JOIN")) break;
      const table = this.identifier("table");
      const alias = (this.tableAlias() ?? table).toLowerCase();
      this.expect("ON");
      const left = this.columnRef();
      if (!(this.t.kind === "op" && this.t.value === "=")) throw this.error("Joins need an equality condition like a.col = b.col");
      this.i++;
      const right = this.columnRef();
      if (this.is("AND") || this.is("OR")) throw new SqlError("Joins support a single a.col = b.col condition. Move other conditions to WHERE.", this.t.pos);
      joins.push({ outer, table: table.toLowerCase(), alias, left, right });
    }

    const where = this.accept("WHERE") ? this.orCond() : undefined;
    const groupBy: ColumnRef[] = [];
    if (this.accept("GROUP")) {
      this.expect("BY");
      groupBy.push(this.columnRef());
      while (this.isPunct(",")) {
        this.i++;
        groupBy.push(this.columnRef());
      }
    }
    const having: Having[] = [];
    if (this.accept("HAVING")) {
      if (!groupBy.length && !items.some((i) => i.kind === "aggregate")) throw new SqlError("HAVING needs GROUP BY or an aggregate like COUNT(*).", this.t.pos);
      do having.push(this.havingCondition());
      while (this.accept("AND"));
      if (this.is("OR")) throw new SqlError("HAVING supports conditions joined with AND.", this.t.pos);
    }
    const orderBy: Array<{ ref: ColumnRef; desc: boolean }> = [];
    if (this.accept("ORDER")) {
      this.expect("BY");
      do {
        if (this.isPunct(",")) this.i++;
        const ref = this.columnRef();
        const desc = this.accept("DESC");
        if (!desc) this.accept("ASC");
        orderBy.push({ ref, desc });
      } while (this.isPunct(","));
    }
    if (this.isPunct(";")) this.i++;
    if (this.t.kind !== "eof") throw this.error("Unexpected text");
    return { distinct, top, items, from, joins, where, groupBy, having, orderBy };
  }

  private havingCondition(): Having {
    let target: Having["target"];
    const fn = this.t.upper;
    if (["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(fn) && this.peek().value === "(") {
      this.i += 2;
      if (fn === "COUNT" && this.isPunct("*")) {
        this.i++;
        target = { fn: "count" };
      } else {
        this.accept("DISTINCT");
        const ref = this.columnRef();
        target = { fn: fn === "COUNT" ? "countcolumn" : (fn.toLowerCase() as Having["target"]["fn"]), column: ref.column };
      }
      this.expectPunct(")");
    } else {
      target = { alias: this.identifier("aggregate or alias").toLowerCase() };
    }
    if (this.t.kind !== "op") throw this.error("Expected a comparison in HAVING");
    const op = ({ "=": "eq", "<>": "ne", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" } as const)[this.toks[this.i++].value as "="];
    const value = this.literal();
    if (typeof value !== "number") throw new SqlError("HAVING compares aggregates to numbers, like COUNT(*) > 1.");
    return { target, op, value };
  }

  private tableAlias(): string | undefined {
    if (this.accept("AS")) return this.identifier("alias");
    if (this.t.kind === "word" && !(this.t.upper && RESERVED.has(this.t.upper))) return this.toks[this.i++].value;
    return undefined;
  }

  private columnAlias(): string | undefined {
    if (this.accept("AS")) {
      if (this.t.kind === "string") return this.toks[this.i++].value;
      return this.identifier("alias");
    }
    if (this.t.kind === "word" && !(this.t.upper && RESERVED.has(this.t.upper))) return this.toks[this.i++].value;
    return undefined;
  }

  private columnRef(): ColumnRef {
    const first = this.identifier("column");
    if (this.isPunct(".")) {
      this.i++;
      return { table: first.toLowerCase(), column: this.identifier("column").toLowerCase() };
    }
    return { column: first.toLowerCase() };
  }

  private selectItem(): SelectItem {
    if (this.isPunct("*")) {
      this.i++;
      return { kind: "all" };
    }
    if (this.t.kind === "word" && this.peek().kind === "punct" && this.peek().value === "." && this.peek(2).value === "*") {
      const table = this.toks[this.i].value.toLowerCase();
      this.i += 3;
      return { kind: "all", table };
    }
    const fn = this.t.upper;
    if (["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(fn) && this.peek().value === "(") {
      this.i += 2;
      if (fn === "COUNT" && this.isPunct("*")) {
        this.i++;
        this.expectPunct(")");
        return { kind: "aggregate", fn: "count", distinct: false, alias: this.columnAlias() };
      }
      const distinct = this.accept("DISTINCT");
      const ref = this.columnRef();
      this.expectPunct(")");
      const name = fn === "COUNT" ? "countcolumn" : (fn.toLowerCase() as "sum" | "avg" | "min" | "max");
      return { kind: "aggregate", fn: name, ref, distinct, alias: this.columnAlias() };
    }
    if (this.t.kind === "word" && this.peek().value === "(") {
      throw new SqlError(`${this.t.value}() isn't supported. Select columns and COUNT/SUM/AVG/MIN/MAX only.`, this.t.pos);
    }
    const ref = this.columnRef();
    return { kind: "column", ref, alias: this.columnAlias() };
  }

  private orCond(): Cond {
    const items = [this.andCond()];
    while (this.accept("OR")) items.push(this.andCond());
    return items.length === 1 ? items[0] : { kind: "or", items };
  }

  private andCond(): Cond {
    const items = [this.notCond()];
    while (this.accept("AND")) items.push(this.notCond());
    return items.length === 1 ? items[0] : { kind: "and", items };
  }

  private notCond(): Cond {
    if (this.accept("NOT")) return { kind: "not", item: this.notCond() };
    if (this.isPunct("(")) {
      this.i++;
      const inner = this.orCond();
      this.expectPunct(")");
      return inner;
    }
    return this.predicate();
  }

  private literal(): Literal {
    const t = this.t;
    if (t.kind === "string") {
      this.i++;
      return t.value;
    }
    if (t.kind === "number") {
      this.i++;
      return Number(t.value);
    }
    if (t.kind === "punct" && t.value === "-" && this.peek().kind === "number") {
      this.i += 2;
      return -Number(this.toks[this.i - 1].value);
    }
    if (t.kind === "word" && t.upper === "NULL") {
      this.i++;
      return null;
    }
    if (t.kind === "word" && (t.upper === "TRUE" || t.upper === "FALSE")) {
      this.i++;
      return t.upper === "TRUE" ? 1 : 0;
    }
    if (t.kind === "word" && t.quote === '"') {
      throw new SqlError(`Text values take single quotes: '${t.value}'. Double quotes are for names.`, t.pos);
    }
    if (t.kind === "word" && this.peek().value === ".") {
      throw new SqlError("Comparing one column to another isn't supported in WHERE. Compare columns to values.", t.pos);
    }
    throw this.error("Expected a value ('text', a number, or NULL)");
  }

  private predicate(): Cond {
    const ref = this.columnRef();
    if (this.accept("IS")) {
      const not = this.accept("NOT");
      this.expect("NULL");
      return { kind: "cmp", ref, op: not ? "not-null" : "null", values: [] };
    }
    const not = this.accept("NOT");
    if (this.accept("LIKE")) {
      const v = this.literal();
      return { kind: "cmp", ref, op: not ? "not-like" : "like", values: [v] };
    }
    if (this.accept("IN")) {
      this.expectPunct("(");
      if (this.is("SELECT")) throw new SqlError("Subqueries aren't supported. Use a JOIN instead.", this.t.pos);
      const values = [this.literal()];
      while (this.isPunct(",")) {
        this.i++;
        values.push(this.literal());
      }
      this.expectPunct(")");
      return { kind: "cmp", ref, op: not ? "not-in" : "in", values };
    }
    if (this.accept("BETWEEN")) {
      const a = this.literal();
      this.expect("AND");
      const b = this.literal();
      return { kind: "cmp", ref, op: not ? "not-between" : "between", values: [a, b] };
    }
    if (not) throw this.error("Expected LIKE, IN, or BETWEEN after NOT");
    if (this.t.kind !== "op") throw this.error("Expected a comparison (=, <>, <, >, LIKE, IN, IS NULL, BETWEEN)");
    const op = this.toks[this.i++].value;
    const value = this.literal();
    const map: Record<string, string> = { "=": "eq", "<>": "ne", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };
    if (value === null) {
      if (op === "=") return { kind: "cmp", ref, op: "null", values: [] };
      if (op === "<>" || op === "!=") return { kind: "cmp", ref, op: "not-null", values: [] };
      throw new SqlError("NULL can only be compared with = or <> (or IS NULL).");
    }
    return { kind: "cmp", ref, op: map[op], values: [value] };
  }
}

export function parseSql(sql: string): SelectQuery {
  return new Parser(tokenize(sql)).parse();
}

export type Statement =
  | { kind: "select"; query: SelectQuery }
  | { kind: "update"; table: string; alias: string; sets: Array<{ column: string; value: Literal }>; where?: Cond }
  | { kind: "delete"; table: string; alias: string; where?: Cond }
  | { kind: "insert"; table: string; alias: string; columns: string[]; rows: Literal[][] };

export function parseStatement(sql: string): Statement {
  return new Parser(tokenize(sql)).statement();
}

// ---------- FetchXML ----------

const NEGATE: Record<string, string> = {
  eq: "ne", ne: "eq", lt: "ge", ge: "lt", gt: "le", le: "gt", like: "not-like", "not-like": "like",
  in: "not-in", "not-in": "in", null: "not-null", "not-null": "null", between: "not-between", "not-between": "between",
};

/** Pushes NOT down to the comparisons (De Morgan), since FetchXML has no NOT. */
function pushNot(c: Cond, negate = false): Cond {
  if (c.kind === "not") return pushNot(c.item, !negate);
  if (c.kind === "cmp") return negate ? { ...c, op: NEGATE[c.op] } : c;
  const kind = negate ? (c.kind === "and" ? "or" : "and") : c.kind;
  return { kind, items: c.items.map((i) => pushNot(i, negate)) };
}

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One column of the result grid: where its value comes from in the Web API response. */
export interface ResultColumn {
  header: string;
  /** Link-entity alias, or undefined for the main table. */
  entityAlias?: string;
  column?: string;
  /** Alias of an aggregate or group-by value. */
  valueAlias?: string;
}

export interface Translation {
  fetchXml: string;
  table: string;
  /** Explicit columns, or "all" when the query used * (columns come from the rows). */
  columns: ResultColumn[] | "all";
  aggregate: boolean;
  top?: number;
  /** HAVING filters to apply to the grouped rows, by result value alias. */
  having?: Array<{ alias: string; op: Having["op"]; value: number; text: string }>;
}

export interface TranslateOptions {
  /** Primary key column of a table, for COUNT(*). Defaults to "<table>id". */
  primaryIdOf?: (table: string) => string | undefined;
}

export function translate(sql: string, options: TranslateOptions = {}): Translation {
  return translateQuery(parseSql(sql), options);
}

export function translateQuery(q: SelectQuery, options: TranslateOptions = {}): Translation {
  const root = q.from;
  type Node = { table: string; alias: string; join?: Join; children: Node[]; attrs: string[]; orders: string[]; all: boolean };
  const rootNode: Node = { table: root.table, alias: root.alias, children: [], attrs: [], orders: [], all: false };
  const nodes = new Map<string, Node>([[root.alias, rootNode]]);
  if (root.table !== root.alias) nodes.set(root.table, rootNode);

  for (const j of q.joins) {
    if (nodes.has(j.alias)) throw new SqlError(`The alias "${j.alias}" is used twice.`);
    const sideOf = (r: ColumnRef) => r.table ?? root.alias;
    let mine: ColumnRef;
    let theirs: ColumnRef;
    if (sideOf(j.left) === j.alias) [mine, theirs] = [j.left, j.right];
    else if (sideOf(j.right) === j.alias) [mine, theirs] = [j.right, j.left];
    else throw new SqlError(`The ON condition for ${j.alias} must use a column from ${j.alias}.`);
    const parent = nodes.get(sideOf(theirs));
    if (!parent) throw new SqlError(`Unknown table or alias "${sideOf(theirs)}" in the join to ${j.alias}.`);
    const node: Node = { table: j.table, alias: j.alias, join: { ...j, left: mine, right: theirs }, children: [], attrs: [], orders: [], all: false };
    parent.children.push(node);
    nodes.set(j.alias, node);
  }

  const nodeFor = (ref: ColumnRef): Node => {
    const n = nodes.get(ref.table ?? root.alias);
    if (!n) throw new SqlError(`Unknown table or alias "${ref.table}".`);
    return n;
  };
  const isRoot = (n: Node) => n === rootNode;

  const aggregate = q.items.some((i) => i.kind === "aggregate") || q.groupBy.length > 0;
  const columns: ResultColumn[] = [];
  let hasAll = false;
  const usedAliases = new Set<string>();
  const uniqueAlias = (base: string) => {
    let a = base.replace(/[^\w]/g, "_");
    let n = 2;
    while (usedAliases.has(a)) a = `${base}_${n++}`;
    usedAliases.add(a);
    return a;
  };
  const groupAliases = new Map<string, string>();

  if (aggregate) {
    for (const g of q.groupBy) {
      const n = nodeFor(g);
      const alias = uniqueAlias(isRoot(n) ? g.column : `${n.alias}_${g.column}`);
      groupAliases.set(`${n.alias}.${g.column}`, alias);
      n.attrs.push(`<attribute name="${xmlEscape(g.column)}" alias="${alias}" groupby="true" />`);
    }
  }

  for (const item of q.items) {
    if (item.kind === "all") {
      if (aggregate) throw new SqlError("* can't be combined with GROUP BY or aggregates.");
      const n = item.table ? nodes.get(item.table) : rootNode;
      if (!n) throw new SqlError(`Unknown table or alias "${item.table}".`);
      n.all = true;
      hasAll = true;
      continue;
    }
    if (item.kind === "column") {
      const n = nodeFor(item.ref);
      if (aggregate) {
        const alias = groupAliases.get(`${n.alias}.${item.ref.column}`);
        if (!alias) throw new SqlError(`${item.ref.column} must be in GROUP BY or inside an aggregate like COUNT().`);
        columns.push({ header: item.alias ?? item.ref.column, valueAlias: alias });
        continue;
      }
      n.attrs.push(`<attribute name="${xmlEscape(item.ref.column)}" />`);
      columns.push({ header: item.alias ?? (isRoot(n) ? item.ref.column : `${n.alias}.${item.ref.column}`), entityAlias: isRoot(n) ? undefined : n.alias, column: item.ref.column });
      continue;
    }
    // aggregate
    const n = item.ref ? nodeFor(item.ref) : rootNode;
    const column = item.ref?.column ?? options.primaryIdOf?.(n.table) ?? `${n.table}id`;
    const alias = uniqueAlias(item.alias ?? (item.fn === "count" ? "count" : `${item.fn === "countcolumn" ? "count" : item.fn}_${column}`));
    n.attrs.push(
      `<attribute name="${xmlEscape(column)}" alias="${alias}" aggregate="${item.fn}"${item.distinct ? ' distinct="true"' : ""} />`
    );
    columns.push({ header: item.alias ?? alias, valueAlias: alias });
  }
  // Group-by columns that weren't selected still need to be in the result for FetchXML; they're fine as extra attributes.

  for (const o of q.orderBy) {
    const desc = o.desc ? ' descending="true"' : "";
    if (aggregate) {
      const selectAlias = columns.find((c) => c.header.toLowerCase() === o.ref.column && !o.ref.table)?.valueAlias;
      const n = nodeFor(o.ref);
      const alias = selectAlias ?? groupAliases.get(`${n.alias}.${o.ref.column}`);
      if (!alias) throw new SqlError(`ORDER BY ${o.ref.column} must refer to a selected or grouped column.`);
      rootNode.orders.push(`<order alias="${alias}"${desc} />`);
      continue;
    }
    // ORDER BY a select alias -> the underlying column.
    const aliased = !o.ref.table ? columns.find((c) => c.header.toLowerCase() === o.ref.column && c.column) : undefined;
    const ref = aliased ? { table: aliased.entityAlias, column: aliased.column! } : o.ref;
    const n = nodeFor(ref);
    n.orders.push(`<order attribute="${xmlEscape(ref.column)}"${desc} />`);
  }

  const condXml = (c: Cond, indent: string): string => {
    if (c.kind === "cmp") {
      const n = nodeFor(c.ref);
      const entity = isRoot(n) ? "" : ` entityname="${n.alias}"`;
      const head = `${indent}<condition${entity} attribute="${xmlEscape(c.ref.column)}" operator="${c.op}"`;
      if (!c.values.length) return `${head} />`;
      if (["in", "not-in", "between", "not-between"].includes(c.op)) {
        const values = c.values.map((v) => `${indent}  <value>${xmlEscape(String(v))}</value>`).join("\n");
        return `${head}>\n${values}\n${indent}</condition>`;
      }
      return `${head} value="${xmlEscape(String(c.values[0]))}" />`;
    }
    if (c.kind === "not") return condXml(pushNot(c), indent);
    return `${indent}<filter type="${c.kind}">\n${c.items.map((i) => condXml(i, indent + "  ")).join("\n")}\n${indent}</filter>`;
  };

  const nodeXml = (n: Node, indent: string): string => {
    const lines: string[] = [];
    if (n.all) lines.push(`${indent}<all-attributes />`);
    lines.push(...n.attrs.map((a) => indent + a));
    lines.push(...n.orders.map((o) => indent + o));
    if (isRoot(n) && q.where) {
      const where = pushNot(q.where);
      lines.push(where.kind === "cmp" ? `${indent}<filter>\n${condXml(where, indent + "  ")}\n${indent}</filter>` : condXml(where, indent));
    }
    for (const child of n.children) {
      const j = child.join!;
      const linkType = j.outer ? "outer" : "inner";
      const body = nodeXml(child, indent + "  ");
      lines.push(
        `${indent}<link-entity name="${xmlEscape(child.table)}" from="${xmlEscape(j.left.column)}" to="${xmlEscape(j.right.column)}" alias="${child.alias}" link-type="${linkType}"${body ? ">" : " />"}`
      );
      if (body) lines.push(body, `${indent}</link-entity>`);
    }
    return lines.join("\n");
  };

  const fetchAttrs = [
    q.top !== undefined && !aggregate ? ` top="${q.top}"` : "",
    q.distinct ? ' distinct="true"' : "",
    aggregate ? ' aggregate="true"' : "",
  ].join("");
  const fetchXml = `<fetch${fetchAttrs}>\n  <entity name="${xmlEscape(root.table)}">\n${nodeXml(rootNode, "    ")}\n  </entity>\n</fetch>`;
  const OPS = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" };
  const having = (q.having ?? []).map((h) => {
    const t = h.target;
    const item = t.alias
      ? columns.find((c) => c.header.toLowerCase() === t.alias && c.valueAlias)
      : q.items
          .map((it, idx) => ({ it, col: columns[idx] }))
          .find(({ it }) => it.kind === "aggregate" && it.fn === t.fn && (t.fn === "count" || it.ref?.column === t.column))?.col;
    const alias = item?.valueAlias;
    const label = t.alias ?? `${t.fn === "countcolumn" ? "COUNT" : (t.fn ?? "").toUpperCase()}(${t.column ?? "*"})`;
    if (!alias) throw new SqlError(`Select ${label} too (e.g. ${label} AS count) so HAVING can filter on it.`);
    return { alias, op: h.op, value: h.value, text: `${label} ${OPS[h.op]} ${h.value}` };
  });
  return {
    fetchXml: fetchXml.replace(/\n\n+/g, "\n"),
    table: root.table,
    columns: hasAll ? "all" : columns,
    aggregate,
    top: q.top,
    having: having.length ? having : undefined,
  };
}

/** Keeps the grouped rows that pass every HAVING condition. */
export function passesHaving(values: Record<string, unknown>, having: NonNullable<Translation["having"]>): boolean {
  return having.every((h) => {
    const v = Number(values[h.alias]);
    switch (h.op) {
      case "eq": return v === h.value;
      case "ne": return v !== h.value;
      case "lt": return v < h.value;
      case "le": return v <= h.value;
      case "gt": return v > h.value;
      case "ge": return v >= h.value;
    }
  });
}
