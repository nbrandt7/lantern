import { Cancellation } from "./process";
import { UserError } from "./errors";
import { ColumnMeta, TableMeta } from "./metadata";
import { Cell, executeFetch, QueryContext, ResultSet } from "./query";
import { Literal, SelectQuery, Statement, translateQuery } from "./sql";

const LOOKUP_TYPES = ["Lookup", "Customer", "Owner"];
const NUMERIC = new Set(["Integer", "BigInt", "Decimal", "Double", "Money", "Picklist", "State", "Status"]);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values ready for the Web API: plain fields, lookup binds, and lookups to clear. */
export interface Prepared {
  body: Record<string, unknown>;
  /** Navigation properties to disassociate (setting a lookup to NULL). */
  clears: string[];
  /** "fax = '555', parentaccountid = account 1234…", for confirmations. */
  summary: string[];
}

/**
 * Converts a value to what the Web API expects for a non-lookup column, or explains
 * why it can't. Choices accept the number or the label.
 */
export function coerce(column: ColumnMeta, value: Literal): unknown {
  if (value === null || value === "") return null;
  if (column.type === "Boolean") {
    const v = String(value).toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
    throw new UserError(`${column.logicalName} is yes/no. Use TRUE or FALSE.`);
  }
  if (NUMERIC.has(column.type)) {
    if (typeof value === "string" && column.options?.length && Number.isNaN(Number(value))) {
      const option = column.options.find((o) => o.label.toLowerCase() === value.trim().toLowerCase());
      if (!option) throw new UserError(`${column.logicalName} has no choice labeled '${value}'. Options: ${column.options.map((o) => `${o.value} ${o.label}`).join(", ")}.`);
      return option.value;
    }
    const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    if (Number.isNaN(n)) throw new UserError(`${column.logicalName} needs a number, not '${value}'.`);
    return n;
  }
  return String(value);
}

function describe(column: ColumnMeta, value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const option = column.options?.find((o) => o.value === value);
  if (option) return `${value} (${option.label})`;
  return typeof value === "string" ? `'${value}'` : String(value);
}

/** Navigation property for a lookup column pointing at a table, from its many-to-one relationships. */
export class LookupResolver {
  private readonly cache = new Map<string, Array<{ nav: string; target: string }>>();

  constructor(private readonly ctx: QueryContext) {}

  async navs(table: string, column: string): Promise<Array<{ nav: string; target: string }>> {
    const key = `${table}.${column}`;
    let hit = this.cache.get(key);
    if (!hit) {
      const r = await this.ctx.dv.getJson<{ value: Array<{ ReferencingEntityNavigationPropertyName: string; ReferencedEntity: string }> }>(
        `EntityDefinitions(LogicalName='${table}')/ManyToOneRelationships?$select=ReferencingEntityNavigationPropertyName,ReferencedEntity&$filter=ReferencingAttribute eq '${column}'`
      );
      hit = r.value.map((x) => ({ nav: x.ReferencingEntityNavigationPropertyName, target: x.ReferencedEntity }));
      this.cache.set(key, hit);
    }
    return hit;
  }
}

/**
 * Column assignments to Web API fields. Lookups take 'GUID' (one target) or
 * 'table:GUID' (customer and owner lookups), and NULL clears them.
 */
export async function prepareValues(
  table: TableMeta,
  columns: ColumnMeta[],
  assignments: Array<{ column: string; value: Literal }>,
  ctx: QueryContext,
  lookups: LookupResolver
): Promise<Prepared> {
  const out: Prepared = { body: {}, clears: [], summary: [] };
  for (const a of assignments) {
    const column = columns.find((c) => c.logicalName === a.column.toLowerCase());
    if (!column) throw new UserError(`${table.logicalName} has no column named ${a.column}.`);
    if (!LOOKUP_TYPES.includes(column.type)) {
      const value = coerce(column, a.value);
      out.body[column.logicalName] = value;
      out.summary.push(`${column.logicalName} = ${describe(column, value)}`);
      continue;
    }
    const navs = await lookups.navs(table.logicalName, column.logicalName);
    if (!navs.length) throw new UserError(`Couldn't find how ${column.logicalName} links to its table.`);
    if (a.value === null || a.value === "") {
      out.clears.push(...navs.map((n) => n.nav));
      out.summary.push(`${column.logicalName} = NULL`);
      continue;
    }
    const text = String(a.value).trim();
    const [first, second] = text.includes(":") ? text.split(":") : [undefined, text];
    const id = (second ?? "").trim();
    if (!GUID.test(id)) throw new UserError(`${column.logicalName} needs a record ID (GUID)${navs.length > 1 ? " written as 'table:GUID'" : ""}, not '${text}'.`);
    const target = first?.trim().toLowerCase() ?? (navs.length === 1 ? navs[0].target : undefined);
    if (!target) throw new UserError(`${column.logicalName} can point to ${navs.map((n) => n.target).join(" or ")}; write it as '${navs[0].target}:${id}'.`);
    const nav = navs.find((n) => n.target === target);
    if (!nav) throw new UserError(`${column.logicalName} can't point to ${target}; it takes ${navs.map((n) => n.target).join(" or ")}.`);
    out.body[`${nav.nav}@odata.bind`] = `/${await ctx.entitySetOf(target)}(${id})`;
    out.summary.push(`${column.logicalName} = ${target} ${id.slice(0, 8)}…`);
  }
  return out;
}

export interface WritePlan {
  kind: "update" | "delete" | "insert";
  table: TableMeta;
  /** Rows to change (UPDATE/DELETE) or, for INSERT, one entry per new row. */
  rows: Array<{ id: string; name: string }>;
  /** UPDATE: the same fields for every row. */
  prepared?: Prepared;
  /** INSERT: fields per new row. */
  inserts?: Prepared[];
  summary: string;
  hasWhere: boolean;
  source: string;
}

/** Finds the rows an UPDATE or DELETE would touch, or prepares INSERT rows, without changing anything. */
export async function planWrite(
  stmt: Extract<Statement, { kind: "update" | "delete" | "insert" }>,
  source: string,
  table: TableMeta,
  columns: ColumnMeta[],
  ctx: QueryContext
): Promise<WritePlan> {
  const lookups = new LookupResolver(ctx);
  if (stmt.kind === "insert") {
    const inserts: Prepared[] = [];
    for (const row of stmt.rows) {
      if (row.length !== stmt.columns.length) throw new UserError(`Each VALUES row needs ${stmt.columns.length} values, one per column.`);
      inserts.push(await prepareValues(table, columns, stmt.columns.map((column, i) => ({ column, value: row[i] })), ctx, lookups));
    }
    const nameAt = table.primaryName ? stmt.columns.findIndex((c) => c.toLowerCase() === table.primaryName) : -1;
    return {
      kind: "insert",
      table,
      rows: stmt.rows.map((r, i) => ({ id: "", name: nameAt >= 0 && r[nameAt] !== null ? String(r[nameAt]) : `row ${i + 1}` })),
      inserts,
      summary: stmt.columns.join(", "),
      hasWhere: true,
      source,
    };
  }

  const prepared = stmt.kind === "update" ? await prepareValues(table, columns, stmt.sets, ctx, lookups) : undefined;
  const items: SelectQuery["items"] = [{ kind: "column", ref: { column: table.primaryId } }];
  if (table.primaryName) items.push({ kind: "column", ref: { column: table.primaryName } });
  const select: SelectQuery = { distinct: false, items, from: { table: stmt.table, alias: stmt.alias }, joins: [], where: stmt.where, groupBy: [], orderBy: [] };
  const t = translateQuery(select, { primaryIdOf: () => table.primaryId });
  const found = await executeFetch(source, t.fetchXml, table.logicalName, t.columns, true, ctx);
  if (found.truncated) {
    throw new UserError(
      `This ${stmt.kind.toUpperCase()} matches more than ${found.rows.length.toLocaleString()} rows. Narrow the WHERE clause, or raise lantern.query.maxRows.`
    );
  }
  const nameCol = table.primaryName ? found.columns.indexOf(table.primaryName) : -1;
  const rows = found.rows.map((r, i) => {
    const id = found.rowIds[i] ?? String(r[0].raw);
    return { id, name: nameCol >= 0 && r[nameCol].raw !== null ? String(r[nameCol].raw) : id };
  });
  return { kind: stmt.kind, table, rows, prepared, summary: prepared?.summary.join(", ") ?? "", hasWhere: !!stmt.where, source };
}

/** Applies a plan row by row. Failures don't stop the rest; each row's outcome is in the result. */
export async function applyWrite(plan: WritePlan, ctx: QueryContext, onProgress: (done: number) => void, token?: Cancellation): Promise<ResultSet> {
  const started = Date.now();
  const set = plan.table.entitySetName;
  const outcome: Cell[][] = [];
  const ids: Array<string | undefined> = [];
  for (const [i, row] of plan.rows.entries()) {
    if (token?.isCancellationRequested) {
      outcome.push([{ raw: row.name }, { raw: "Skipped (cancelled)" }]);
      ids.push(undefined);
      continue;
    }
    try {
      if (plan.kind === "insert") {
        const p = plan.inserts![i];
        const id = await ctx.dv.create(set, p.body);
        outcome.push([{ raw: row.name }, { raw: "Created" }]);
        ids.push(id);
      } else if (plan.kind === "update") {
        const p = plan.prepared!;
        if (Object.keys(p.body).length) await ctx.dv.update(`${set}(${row.id})`, p.body);
        // Clearing a lookup is a disassociate; a lookup that's already empty answers 404, which is fine.
        for (const nav of p.clears) await ctx.dv.remove(`${set}(${row.id})/${nav}/$ref`).catch(() => undefined);
        outcome.push([{ raw: row.name }, { raw: "Updated" }]);
        ids.push(row.id);
      } else {
        await ctx.dv.remove(`${set}(${row.id})`);
        outcome.push([{ raw: row.name }, { raw: "Deleted" }]);
        ids.push(undefined);
      }
    } catch (err) {
      outcome.push([{ raw: row.name }, { raw: `Failed: ${err instanceof Error ? err.message : String(err)}` }]);
      ids.push(plan.kind === "update" ? row.id : undefined);
    }
    onProgress(i + 1);
  }
  return {
    source: plan.source,
    table: plan.table.logicalName,
    fetchXml: "",
    columns: [plan.table.primaryName || "record", "Result"],
    rows: outcome,
    rowIds: ids,
    truncated: false,
    elapsedMs: Date.now() - started,
    kind: "write",
  };
}
