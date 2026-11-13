/**
 * Translates a read-only SQL dialect into FetchXML, so you can query Dataverse the
 * way you'd query SQL Server. Supported:
 *
 *   SELECT [DISTINCT] [TOP n] *, t.*, col [AS alias], COUNT(*), COUNT([DISTINCT] col), SUM/AVG/MIN/MAX(col)
 *   FROM table [AS] [alias]
 *   [INNER | LEFT [OUTER]] JOIN table [AS] alias ON a.col = b.col   (any number, nestable)
 *   WHERE  =, <>, !=, <, <=, >, >=, [NOT] LIKE, [NOT] IN (...), IS [NOT] NULL, [NOT] BETWEEN, AND, OR, NOT, ( ),
 *          [NOT] EXISTS (SELECT ... FROM t [alias] [JOIN ...] WHERE t.col = outer.col [AND ...]),
 *          col [NOT] IN (SELECT col FROM t [alias] [JOIN ...] [WHERE ...])
 *          Subqueries become <link-entity link-type="any" / "not any"> inside the filter, so they compose with AND/OR/NOT,
 *          nest, and can be linked to the FROM table or (with AND) to an INNER JOINed table.
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
  | { kind: "cmp"; ref: ColumnRef; op: string; values: Literal[] }
  /** Two columns compared. Only parsed inside a subquery, where one such = links the subquery's table to the outer query. */
  | { kind: "colcmp"; left: ColumnRef; op: string; right: ColumnRef; pos: number }
  /**
   * [NOT] EXISTS (SELECT ... FROM table [alias] [WHERE ...]) or outer [NOT] IN (SELECT inner FROM table [alias] [WHERE ...]).
   * For IN, outer and inner are set here; for EXISTS they come from the linking condition in the subquery's WHERE.
   */
  | { kind: "sub"; negated: boolean; outer?: ColumnRef; inner?: ColumnRef; table: string; alias: string; joins: Join[]; where?: Cond; pos: number };

export type SubCond = Extract<Cond, { kind: "sub" }>;

export interface Join {
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
  target: { fn?: "count" | "countcolumn" | "sum" | "avg" | "min" | "max"; column?: string; table?: string; distinct?: boolean; alias?: string };
  op: "eq" | "ne" | "lt" | "le" | "gt" | "ge";
  value: number;
}

// ---------- parser ----------

const RESERVED = new Set([
  "SELECT", "DISTINCT", "TOP", "FROM", "AS", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ON", "WHERE",
  "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "EXISTS", "GROUP", "BY", "ORDER", "ASC", "DESC", "HAVING",
  "UNION", "INSERT", "UPDATE", "DELETE", "INTO", "VALUES", "SET", "OPTION",
]);

class Parser {
  private i = 0;
  /** > 0 while parsing a subquery, where column = column conditions are allowed (one of them links it to the outer query). */
  private subDepth = 0;
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
      const hints = this.hints();
      this.end();
      return { kind: "insert", table, alias: table, columns, rows, ...hints };
    }
    if (this.accept("UPDATE")) {
      const target = this.identifier("table");
      const targetAlias = this.tableAlias();
      this.expect("SET");
      const sets: Array<{ column: string; value: Literal }> = [];
      do {
        if (this.isPunct(",")) this.i++;
        const ref = this.columnRef();
        if (!(this.t.kind === "op" && this.t.value === "=")) throw this.error("Expected = in SET");
        this.i++;
        sets.push({ column: ref.column, value: this.literal() });
      } while (this.isPunct(","));
      const { table, alias } = this.writeTarget("UPDATE", target, targetAlias);
      const where = this.accept("WHERE") ? this.orCond() : undefined;
      const hints = this.hints();
      this.end();
      return { kind: "update", table, alias, sets, where, ...hints };
    }
    if (this.accept("DELETE")) {
      const direct = this.accept("FROM");
      const target = this.identifier("table");
      const targetAlias = this.tableAlias();
      const { table, alias } = direct ? { table: target.toLowerCase(), alias: (targetAlias ?? target).toLowerCase() } : this.writeTarget("DELETE", target, targetAlias);
      const where = this.accept("WHERE") ? this.orCond() : undefined;
      const hints = this.hints();
      this.end();
      return { kind: "delete", table, alias, where, ...hints };
    }
    return { kind: "select", query: this.parse() };
  }

  /**
   * The table an UPDATE or DELETE changes: "UPDATE table [alias]", or SQL Server's "UPDATE alias ... FROM table alias"
   * (and "DELETE alias FROM table alias"), where the name before SET is the alias of the one table in FROM.
   */
  private writeTarget(verb: string, target: string, targetAlias: string | undefined): { table: string; alias: string } {
    if (!this.accept("FROM")) return { table: target.toLowerCase(), alias: (targetAlias ?? target).toLowerCase() };
    const pos = this.t.pos;
    const fromTable = this.identifier("table");
    const fromAlias = (this.tableAlias() ?? fromTable).toLowerCase();
    if (["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS"].some((w) => this.is(w))) {
      throw new SqlError(`${verb} ... FROM takes one table. For conditions on related rows, use WHERE EXISTS (SELECT ...) or IN (SELECT ...).`, this.t.pos);
    }
    const name = target.toLowerCase();
    if (targetAlias || (name !== fromTable.toLowerCase() && name !== fromAlias)) {
      const named = `${verb} ${target}${targetAlias ? ` ${targetAlias}` : ""} doesn't match FROM ${fromTable}${fromAlias !== fromTable.toLowerCase() ? ` ${fromAlias}` : ""}.`;
      const fix =
        fromAlias === fromTable.toLowerCase() && !targetAlias
          ? `Write FROM ${fromTable} ${target} so ${target} is its alias, or ${verb} ${fromTable} ... FROM ${fromTable}.`
          : `Write ${verb} ${fromAlias} ... FROM ${fromTable} ${fromAlias}, or leave FROM out.`;
      throw new SqlError(`${named} ${fix}`, pos);
    }
    return { table: fromTable.toLowerCase(), alias: fromAlias };
  }

  /**
   * SQL Server-style OPTION (...) at the end of a write statement: BYPASS PLUGINS, BYPASS SYNC PLUGINS,
   * BYPASS ASYNC PLUGINS and BYPASS FLOWS, comma-separated. Absent, the result has no hints key.
   */
  private hints(): { hints?: WriteHint[] } {
    if (!this.accept("OPTION")) return {};
    this.expectPunct("(");
    const hints: WriteHint[] = [];
    do {
      if (this.isPunct(",")) this.i++;
      if (!this.accept("BYPASS")) throw this.error("OPTION takes BYPASS PLUGINS, BYPASS SYNC PLUGINS, BYPASS ASYNC PLUGINS or BYPASS FLOWS, not");
      if (this.accept("PLUGINS")) hints.push("bypass plugins");
      else if (this.accept("FLOWS")) hints.push("bypass flows");
      else if (this.accept("SYNC") || this.accept("ASYNC")) {
        const which = this.toks[this.i - 1].upper === "SYNC" ? "bypass sync plugins" : "bypass async plugins";
        this.expect("PLUGINS");
        hints.push(which);
      } else throw this.error("BYPASS takes PLUGINS, SYNC PLUGINS, ASYNC PLUGINS or FLOWS, not");
    } while (this.isPunct(","));
    this.expectPunct(")");
    return { hints: [...new Set(hints)] };
  }

  private end(): void {
    if (this.isPunct(";")) this.i++;
    if (this.is("OPTION")) throw this.error("OPTION (BYPASS ...) goes on UPDATE, DELETE and INSERT; a SELECT runs no plug-ins or flows. Unexpected");
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
    if (this.isPunct("(")) throw new SqlError("Subqueries in FROM aren't supported. Query the table directly and filter it with WHERE.", this.t.pos);
    const fromTable = this.identifier("table");
    const from = { table: fromTable.toLowerCase(), alias: (this.tableAlias() ?? fromTable).toLowerCase() };

    const joins = this.joins(false);

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
    this.end();
    return { distinct, top, items, from, joins, where, groupBy, having, orderBy };
  }

  /** The JOIN clauses after FROM. A subquery takes INNER JOIN only: FetchXML filters a LEFT JOINed table with the join, not after it. */
  private joins(inSubquery: boolean): Join[] {
    const joins: Join[] = [];
    for (;;) {
      let outer = false;
      if (this.is("RIGHT") || this.is("FULL") || this.is("CROSS")) throw new SqlError(`${this.t.upper} JOIN isn't supported; use INNER or LEFT JOIN.`, this.t.pos);
      if (inSubquery && this.is("LEFT")) {
        throw new SqlError("A subquery supports INNER JOIN only. A LEFT JOIN with no condition on it changes nothing in EXISTS, and FetchXML can't apply a condition on it after the join.", this.t.pos);
      }
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
    return joins;
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
        const distinct = this.accept("DISTINCT");
        const ref = this.columnRef();
        target = { fn: fn === "COUNT" ? "countcolumn" : (fn.toLowerCase() as Having["target"]["fn"]), column: ref.column, table: ref.table, distinct };
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
    if (this.isPunct("(") && this.peek().upper === "SELECT") {
      throw new SqlError("Subqueries in SELECT aren't supported. FetchXML only uses a subquery as a filter: WHERE [NOT] EXISTS (SELECT ...) or column [NOT] IN (SELECT ...).", this.t.pos);
    }
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
    const start = this.t.pos;
    if (this.accept("EXISTS")) {
      this.expectPunct("(");
      return this.subquery(undefined, start);
    }
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
      if (this.is("SELECT")) return { ...this.subquery(ref, start), negated: not };
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
    if (this.t.kind !== "op") throw this.error("Expected a comparison (=, <>, <, >, LIKE, IN, IS NULL, BETWEEN, EXISTS)");
    const op = this.toks[this.i++].value;
    if (this.isPunct("(") && this.peek().upper === "SELECT") {
      throw new SqlError(`${op} (SELECT ...) isn't supported. Use column IN (SELECT column FROM ...) or EXISTS (SELECT ...).`, this.t.pos);
    }
    const next = this.toks[this.i];
    if (this.subDepth > 0 && next.kind === "word" && next.quote !== '"' && !["NULL", "TRUE", "FALSE"].includes(next.upper)) {
      return { kind: "colcmp", left: ref, op, right: this.columnRef(), pos: start };
    }
    const value = this.literal();
    const map: Record<string, string> = { "=": "eq", "<>": "ne", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };
    if (value === null) {
      if (op === "=") return { kind: "cmp", ref, op: "null", values: [] };
      if (op === "<>" || op === "!=") return { kind: "cmp", ref, op: "not-null", values: [] };
      throw new SqlError("NULL can only be compared with = or <> (or IS NULL).");
    }
    return { kind: "cmp", ref, op: map[op], values: [value] };
  }

  /**
   * The SELECT of EXISTS (...) or IN (...), after its "(". FetchXML links one table per subquery (with its INNER JOINs)
   * and filters it, so this accepts SELECT <anything simple> FROM table [alias] [JOIN ...] [WHERE ...] and names what it can't take.
   */
  private subquery(outer: ColumnRef | undefined, pos: number): SubCond {
    this.expect("SELECT");
    this.subDepth++;
    this.accept("DISTINCT");
    if (this.is("TOP")) throw new SqlError("TOP isn't supported in a subquery.", this.t.pos);
    const items: ColumnRef[] = [];
    let star = false;
    do {
      if (this.isPunct(",")) this.i++;
      if (this.isPunct("*")) {
        this.i++;
        star = true;
      } else if (this.t.kind === "word" && this.peek().value === "." && this.peek(2).value === "*") {
        this.i += 3;
        star = true;
      } else if (this.t.kind === "number") this.i++;
      else if (this.t.kind === "word" && this.peek().value === "(") {
        throw new SqlError(`${this.t.value}() isn't supported in a subquery. Select a column, or 1 for EXISTS.`, this.t.pos);
      } else items.push(this.columnRef());
    } while (this.isPunct(","));
    this.expect("FROM");
    const tableName = this.identifier("table");
    const table = tableName.toLowerCase();
    const alias = (this.tableAlias() ?? tableName).toLowerCase();
    const joins = this.joins(true);
    const where = this.accept("WHERE") ? this.orCond() : undefined;
    if (this.is("GROUP") || this.is("ORDER") || this.is("HAVING")) {
      throw new SqlError(`${this.t.upper} isn't supported in a subquery. A subquery only filters the outer query's rows.`, this.t.pos);
    }
    this.expectPunct(")");
    this.subDepth--;
    let inner: ColumnRef | undefined;
    if (outer) {
      if (star || items.length !== 1) throw new SqlError(`IN (SELECT ...) needs exactly one column, like IN (SELECT ${table}id FROM ${table}).`, pos);
      inner = items[0];
      if (inner.table && inner.table !== alias && inner.table !== table) {
        throw new SqlError(`The column selected in IN (SELECT ...) must come from ${alias}, not ${inner.table}: FetchXML links on the subquery table's own column.`, pos);
      }
    }
    return { kind: "sub", negated: false, outer, inner, table, alias, joins, where, pos };
  }
}

export function parseSql(sql: string): SelectQuery {
  return new Parser(tokenize(sql)).parse();
}

/**
 * OPTION (BYPASS ...) on a write statement: what Dataverse is told not to run for each row.
 * "bypass plugins" is custom synchronous and asynchronous plug-ins and workflows (ISV and
 * Microsoft-published ones still run); "bypass flows" is Power Automate triggers.
 */
export type WriteHint = "bypass plugins" | "bypass sync plugins" | "bypass async plugins" | "bypass flows";

export type Statement =
  | { kind: "select"; query: SelectQuery }
  | { kind: "update"; table: string; alias: string; sets: Array<{ column: string; value: Literal }>; where?: Cond; hints?: WriteHint[] }
  | { kind: "delete"; table: string; alias: string; where?: Cond; hints?: WriteHint[] }
  | { kind: "insert"; table: string; alias: string; columns: string[]; rows: Literal[][]; hints?: WriteHint[] };

export function parseStatement(sql: string): Statement {
  return new Parser(tokenize(sql)).statement();
}

// ---------- scopes: a query's tables, and a subquery's inside it ----------

/** One table of a query: the FROM table or a JOIN, with what the FetchXML writer collects for it. */
export interface TableNode {
  table: string;
  alias: string;
  join?: Join;
  children: TableNode[];
  attrs: string[];
  orders: string[];
  all: boolean;
  /** Conditions that must be written in this table's own filter (a subquery linked to it, or a subquery's conditions on its JOINs). */
  lifted: Cond[];
}

/** The tables of one query. A subquery gets its own scope, with the query around it as parent, so its WHERE can refer to both. */
export interface Scope {
  root: TableNode;
  nodes: Map<string, TableNode>;
  parent?: Scope;
  sub?: SubCond;
  /** The WHERE written as this scope's root filter: the query's, or a subquery's without its linking condition. */
  where?: Cond;
  keyOf?: (table: string) => string | undefined;
}

function lookup(alias: string, scope: Scope | undefined): { node: TableNode; scope: Scope } | undefined {
  for (let s = scope; s; s = s.parent) {
    const node = s.nodes.get(alias);
    if (node) return { node, scope: s };
  }
  return undefined;
}

function refNode(ref: ColumnRef, scope: Scope): { node: TableNode; scope: Scope } {
  const found = lookup(ref.table ?? scope.root.alias, scope);
  if (!found) throw new SqlError(`Unknown table or alias "${ref.table}".`);
  return found;
}

const refText = (r: ColumnRef) => (r.table ? `${r.table}.${r.column}` : r.column);

/** The scope of a query: its FROM table and JOINs. */
export function scopeOf(from: { table: string; alias: string }, joins: Join[], keyOf?: Scope["keyOf"]): Scope {
  return buildScope(from, joins, undefined, undefined, keyOf);
}

function buildScope(from: { table: string; alias: string }, joins: Join[], parent?: Scope, sub?: SubCond, keyOf?: Scope["keyOf"]): Scope {
  const node = (table: string, alias: string, join?: Join): TableNode => ({ table, alias, join, children: [], attrs: [], orders: [], all: false, lifted: [] });
  const rootNode = node(from.table, from.alias);
  const scope: Scope = { root: rootNode, nodes: new Map([[from.alias, rootNode]]), parent, sub, keyOf: parent?.keyOf ?? keyOf };
  if (parent && lookup(from.alias, parent)) {
    throw new SqlError(`The subquery's alias "${from.alias}" is already used by the outer query. Give the subquery's ${from.table} its own alias, like FROM ${from.table} s.`, sub?.pos);
  }
  // The table's own name qualifies its columns too, unless an outer query already goes by it.
  if (from.table !== from.alias && !lookup(from.table, parent)) scope.nodes.set(from.table, rootNode);
  for (const j of joins) {
    if (scope.nodes.has(j.alias)) throw new SqlError(`The alias "${j.alias}" is used twice.`);
    if (parent && lookup(j.alias, parent)) throw new SqlError(`The alias "${j.alias}" is already used by the outer query. Give the subquery's ${j.table} its own alias.`, sub?.pos);
    const sideOf = (r: ColumnRef) => r.table ?? from.alias;
    let mine: ColumnRef;
    let theirs: ColumnRef;
    if (sideOf(j.left) === j.alias) [mine, theirs] = [j.left, j.right];
    else if (sideOf(j.right) === j.alias) [mine, theirs] = [j.right, j.left];
    else throw new SqlError(`The ON condition for ${j.alias} must use a column from ${j.alias}.`);
    const parentNode = scope.nodes.get(sideOf(theirs));
    if (!parentNode) throw new SqlError(`Unknown table or alias "${sideOf(theirs)}" in the join to ${j.alias}.`);
    const child = node(j.table, j.alias, { ...j, left: mine, right: theirs });
    parentNode.children.push(child);
    scope.nodes.set(j.alias, child);
  }
  return scope;
}

/** Why a column = column condition can't be written where it is. */
export function columnComparisonError(c: Extract<Cond, { kind: "colcmp" }>, scope: Scope): SqlError {
  if (!scope.sub || !scope.parent) return new SqlError("Comparing one column to another isn't supported in WHERE. Compare columns to values.", c.pos);
  const l = refNode(c.left, scope).scope === scope;
  const r = refNode(c.right, scope).scope === scope;
  if (l && r) {
    return new SqlError(
      `Comparing two columns of ${scope.root.alias} isn't supported. To link the subquery to the outer query, qualify the outer column, like ${scope.root.alias}.${c.left.column} = ${scope.parent.root.alias}.${c.right.column}.`,
      c.pos
    );
  }
  if (!l && !r) return new SqlError(`${refText(c.left)} and ${refText(c.right)} belong to the outer query. Move that condition out of the subquery.`, c.pos);
  return new SqlError(`The condition linking the subquery to the outer query (${refText(c.left)} ${c.op} ${refText(c.right)}) must be joined to the rest with AND, not OR.`, c.pos);
}

function findColumnComparison(conds: Cond[]): Extract<Cond, { kind: "colcmp" }> | undefined {
  for (const c of conds) {
    if (c.kind === "colcmp") return c;
    if (c.kind === "not") {
      const found = findColumnComparison([c.item]);
      if (found) return found;
    }
    if (c.kind === "and" || c.kind === "or") {
      const found = findColumnComparison(c.items);
      if (found) return found;
    }
  }
  return undefined;
}

const leftJoinLinkError = (n: TableNode, scope: Scope, pos?: number) =>
  new SqlError(`A subquery can't be linked to ${n.alias}, a LEFT JOINed table: FetchXML would apply it to the join instead of to the results. Use INNER JOIN, or link the subquery to ${scope.root.alias}.`, pos);

/** A subquery resolved against the query around it. */
export interface ResolvedSubquery {
  /** The subquery table's column (link-entity from). */
  from: string;
  /** The outer column (link-entity to), and the outer table it belongs to. */
  to: ColumnRef;
  toAlias: string;
  toTable: string;
  /** True when the outer table is the FROM table of the query around the subquery; otherwise it's one of that query's JOINs. */
  toRoot: boolean;
  negated: boolean;
  table: string;
  alias: string;
  /** The subquery's JOINs, each with the alias it hangs off and the column pair (from = its column, to = the parent's). */
  joins: Array<{ table: string; alias: string; parentAlias: string; from: string; to: string }>;
  /** The subquery's WHERE without the linking condition. */
  where?: Cond;
  scope: Scope;
}

/**
 * Finds the condition linking a subquery to the query around it (its link-entity from/to) and what's left of its WHERE.
 * With owner (the alias whose filter the subquery is being written in), a subquery linked to another table is an error.
 */
export function resolveSubquery(s: SubCond, scope: Scope, owner?: string): ResolvedSubquery {
  const inner = buildScope({ table: s.table, alias: s.alias }, s.joins, scope, s);
  const where = s.where ? pushNot(s.where) : undefined;
  let from = s.inner?.column;
  let to = s.outer;
  const rest: Cond[] = [];
  for (const c of !where ? [] : where.kind === "and" ? where.items : [where]) {
    if (c.kind !== "colcmp") {
      rest.push(c);
      continue;
    }
    const l = refNode(c.left, inner);
    const r = refNode(c.right, inner);
    if ((l.scope === inner) === (r.scope === inner)) {
      rest.push(c); // Both inner or both outer: columnComparisonError explains it.
      continue;
    }
    const [mine, theirs, mineRef, theirsRef] = l.scope === inner ? [l, r, c.left, c.right] : [r, l, c.right, c.left];
    const text = `${refText(c.left)} ${c.op} ${refText(c.right)}`;
    if (c.op !== "=") throw new SqlError(`A subquery is linked to the outer query with =, not ${c.op} (${text}).`, c.pos);
    if (from) throw new SqlError(`A subquery can have one condition linking it to the outer query; ${text} is a second one. FetchXML links tables on a single column pair.`, c.pos);
    if (mine.node !== inner.root) {
      throw new SqlError(`The subquery links to the outer query through ${mine.node.alias}, a table it JOINs. Link it through a column of ${s.alias}, or make ${mine.node.table} the subquery's FROM table.`, c.pos);
    }
    if (theirs.scope !== scope) {
      throw new SqlError(`A subquery can only be linked to the query directly around it (${scope.root.alias}), not to ${theirs.scope.root.alias} further out.`, c.pos);
    }
    from = mineRef.column;
    to = theirsRef;
  }
  if (!from || !to) {
    const misplaced = findColumnComparison(rest);
    if (misplaced) throw columnComparisonError(misplaced, inner);
    const key = scope.keyOf?.(scope.root.table) ?? `${scope.root.table}id`;
    throw new SqlError(`The subquery on ${s.table} needs a condition linking it to ${scope.root.alias}, like WHERE ${s.alias}.<column> = ${scope.root.alias}.${key}.`, s.pos);
  }
  const target = refNode(to, scope);
  if (target.scope !== scope) {
    throw new SqlError(`A subquery can only be linked to the query directly around it (${scope.root.alias}), not to ${target.scope.root.alias} further out.`, s.pos);
  }
  const toNode = target.node;
  if (owner !== undefined && toNode.alias !== owner) {
    if (toNode.join?.outer) throw leftJoinLinkError(toNode, scope, s.pos);
    throw new SqlError(`A subquery linked to the joined table ${toNode.alias} must be combined with the rest of the WHERE using AND, not OR: FetchXML puts it inside that table's join.`, s.pos);
  }
  inner.where = rest.length ? (rest.length === 1 ? rest[0] : { kind: "and", items: rest }) : undefined;
  const joins: ResolvedSubquery["joins"] = [];
  const collect = (n: TableNode): void => {
    for (const child of n.children) {
      joins.push({ table: child.table, alias: child.alias, parentAlias: n.alias, from: child.join!.left.column, to: child.join!.right.column });
      collect(child);
    }
  };
  collect(inner.root);
  return { from, to, toAlias: toNode.alias, toTable: toNode.table, toRoot: toNode === scope.root, negated: s.negated, table: s.table, alias: s.alias, joins, where: inner.where, scope: inner };
}

/**
 * Splits a WHERE into what the root filter holds and what must be written in a JOINed table's own filter:
 * a subquery linked to that table and, inside a subquery, conditions on its JOINs (a link-entity's filter
 * can't reference another link-entity). Only the top-level AND can be split; the rest stays, and the writer
 * explains anything it then can't place.
 */
export function partitionWhere(where: Cond | undefined, scope: Scope): { own?: Cond; lifted: Array<{ alias: string; cond: Cond }> } {
  if (!where) return { lifted: [] };
  const w = pushNot(where);
  const own: Cond[] = [];
  const lifted: Array<{ alias: string; cond: Cond }> = [];
  for (const c of w.kind === "and" ? w.items : [w]) {
    let target: TableNode | undefined;
    if (c.kind === "sub") {
      const r = resolveSubquery(c, scope);
      if (!r.toRoot) {
        const node = scope.nodes.get(r.toAlias)!;
        if (node.join?.outer) throw leftJoinLinkError(node, scope, c.pos);
        target = node;
      }
    } else if (c.kind === "cmp" && scope.sub) {
      const r = refNode(c.ref, scope);
      if (r.scope === scope && r.node !== scope.root) target = r.node;
    }
    if (target) lifted.push({ alias: target.alias, cond: c });
    else own.push(c);
  }
  return { own: own.length ? (own.length === 1 ? own[0] : { kind: "and", items: own }) : undefined, lifted };
}

/** The table a condition's column belongs to, checked against the filter (owner alias) it's written in. */
export function resolveColumn(ref: ColumnRef, scope: Scope, owner: string): { alias: string; root: boolean } {
  const r = refNode(ref, scope);
  if (r.scope !== scope) {
    throw new SqlError(`The subquery on ${scope.root.alias} can only filter ${scope.root.alias}'s columns; ${refText(ref)} belongs to the outer query. Move that condition out of the subquery.`);
  }
  if (scope.sub && r.node.alias !== owner) {
    throw new SqlError(
      `Inside a subquery, a condition on the joined table ${r.node.alias} (${refText(ref)}) must be combined with the rest of the subquery's WHERE using AND, not OR: FetchXML can only filter that table inside its join.`
    );
  }
  return { alias: r.node.alias, root: r.node === scope.root };
}

// ---------- FetchXML ----------

const NEGATE: Record<string, string> = {
  eq: "ne", ne: "eq", lt: "ge", ge: "lt", gt: "le", le: "gt", like: "not-like", "not-like": "like",
  in: "not-in", "not-in": "in", null: "not-null", "not-null": "null", between: "not-between", "not-between": "between",
};

const NEGATE_COLUMN_OP: Record<string, string> = { "=": "<>", "<>": "=", "!=": "=", "<": ">=", ">=": "<", ">": "<=", "<=": ">" };

/** Pushes NOT down to the comparisons (De Morgan), since FetchXML has no NOT. A subquery's own WHERE is left alone. */
function pushNot(c: Cond, negate = false): Cond {
  if (c.kind === "not") return pushNot(c.item, !negate);
  if (c.kind === "cmp") return negate ? { ...c, op: NEGATE[c.op] } : c;
  if (c.kind === "colcmp") return negate ? { ...c, op: NEGATE_COLUMN_OP[c.op] ?? c.op } : c;
  if (c.kind === "sub") return negate ? { ...c, negated: !c.negated } : c;
  const kind = negate ? (c.kind === "and" ? "or" : "and") : c.kind;
  return { kind, items: c.items.map((i) => pushNot(i, negate)) };
}

export function xmlEscape(value: string): string {
  // Line breaks and tabs as character references: in an attribute, XML turns literal ones into spaces.
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
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
  const outer = scopeOf(root, q.joins, options.primaryIdOf);
  outer.where = q.where;
  const rootNode = outer.root;
  const nodes = outer.nodes;
  const nodeFor = (ref: ColumnRef): TableNode => refNode(ref, outer).node;
  const isRoot = (n: TableNode) => n === rootNode;

  const aggregate = q.items.some((i) => i.kind === "aggregate") || q.groupBy.length > 0;
  const columns: ResultColumn[] = [];
  let hasAll = false;
  const usedAliases = new Set<string>();
  const uniqueAlias = (base: string) => {
    const safe = base.replace(/[^\w]/g, "_");
    let a = safe;
    let n = 2;
    while (usedAliases.has(a)) a = `${safe}_${n++}`;
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

  /** A condition inside the filter of owner (a table of scope). In the outer query, another table's column gets entityname. */
  const condXml = (c: Cond, scope: Scope, owner: TableNode, indent: string): string => {
    if (c.kind === "cmp") {
      const col = resolveColumn(c.ref, scope, owner.alias);
      const entity = col.alias === owner.alias ? "" : ` entityname="${col.alias}"`;
      const head = `${indent}<condition${entity} attribute="${xmlEscape(c.ref.column)}" operator="${c.op}"`;
      if (!c.values.length) return `${head} />`;
      if (["in", "not-in", "between", "not-between"].includes(c.op)) {
        const values = c.values.map((v) => `${indent}  <value>${xmlEscape(String(v))}</value>`).join("\n");
        return `${head}>\n${values}\n${indent}</condition>`;
      }
      return `${head} value="${xmlEscape(String(c.values[0]))}" />`;
    }
    if (c.kind === "colcmp") throw columnComparisonError(c, scope);
    if (c.kind === "sub") return subXml(c, scope, owner, indent);
    if (c.kind === "not") return condXml(pushNot(c), scope, owner, indent);
    return `${indent}<filter type="${c.kind}">\n${c.items.map((i) => condXml(i, scope, owner, indent + "  ")).join("\n")}\n${indent}</filter>`;
  };

  /**
   * [NOT] EXISTS / [NOT] IN (SELECT ...) as <link-entity link-type="any" | "not any"> inside owner's filter: the condition
   * linking the subquery's table to owner becomes from/to, and the rest of its WHERE (and its JOINs) go inside the link.
   */
  const subXml = (s: SubCond, scope: Scope, owner: TableNode, indent: string): string => {
    const r = resolveSubquery(s, scope, owner.alias);
    const head = `${indent}<link-entity name="${xmlEscape(s.table)}" from="${xmlEscape(r.from)}" to="${xmlEscape(r.to.column)}" link-type="${s.negated ? "not any" : "any"}"`;
    const body = nodeXml(r.scope.root, r.scope, indent + "  ");
    return body ? `${head}>\n${body}\n${indent}</link-entity>` : `${head} />`;
  };

  const nodeXml = (n: TableNode, scope: Scope, indent: string): string => {
    const lines: string[] = [];
    if (n.all) lines.push(`${indent}<all-attributes />`);
    lines.push(...n.attrs.map((a) => indent + a));
    lines.push(...n.orders.map((o) => indent + o));
    const conds = [...n.lifted];
    if (n === scope.root) {
      // Split the WHERE first: what a JOINed table must hold is written when that table is.
      const { own, lifted } = partitionWhere(scope.where, scope);
      for (const l of lifted) scope.nodes.get(l.alias)!.lifted.push(l.cond);
      if (own) conds.push(own);
    }
    if (conds.length) {
      const w: Cond = conds.length === 1 ? conds[0] : { kind: "and", items: conds };
      lines.push(w.kind === "and" || w.kind === "or" ? condXml(w, scope, n, indent) : `${indent}<filter>\n${condXml(w, scope, n, indent + "  ")}\n${indent}</filter>`);
    }
    for (const child of n.children) {
      const j = child.join!;
      const linkType = j.outer ? "outer" : "inner";
      const body = nodeXml(child, scope, indent + "  ");
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
  const fetchXml = `<fetch${fetchAttrs}>\n  <entity name="${xmlEscape(root.table)}">\n${nodeXml(rootNode, outer, "    ")}\n  </entity>\n</fetch>`;
  const OPS = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" };
  const having = (q.having ?? []).map((h) => {
    const t = h.target;
    const item = t.alias
      ? columns.find((c) => c.header.toLowerCase() === t.alias && c.valueAlias)
      : q.items
          .map((it, idx) => ({ it, col: columns[idx] }))
          // The same function on the same column of the same table, DISTINCT or not, as the select list has it.
          .find(({ it }) => it.kind === "aggregate" && it.fn === t.fn && (t.fn === "count" ||
            (!!it.ref && it.ref.column === t.column && it.distinct === !!t.distinct && nodeFor(it.ref) === nodeFor({ table: t.table, column: t.column! }))))?.col;
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
