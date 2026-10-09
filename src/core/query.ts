import { DataverseClient } from "./dataverse";
import { UserError } from "./errors";
import { parseSql, passesHaving, ResultColumn, SqlError, translate, Translation, xmlEscape } from "./sql";

const FORMATTED = "@OData.Community.Display.V1.FormattedValue";
const LOOKUP_TABLE = "@Microsoft.Dynamics.CRM.lookuplogicalname";
const PAGING_COOKIE = "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie";
const MORE_RECORDS = "@Microsoft.Dynamics.CRM.morerecords";

export interface Cell {
  /** Underlying value: a GUID for lookups, a number for choices, ISO text for dates. */
  raw: unknown;
  /** What Dataverse shows people, when it differs from raw (lookup names, choice labels, local dates). */
  formatted?: string;
  /** Lookups: the record it points to. */
  ref?: { table: string; id: string };
}

export interface ResultSet {
  /** The statement as written. */
  source: string;
  table: string;
  fetchXml: string;
  columns: string[];
  rows: Cell[][];
  /** Record each row came from, for "open record". */
  rowIds: Array<string | undefined>;
  /** More rows exist beyond the row limit. */
  truncated: boolean;
  elapsedMs: number;
  /**
   * "record" (one record's columns), "audit" (change history), "write" (outcome of a change),
   * "report" (a grid Lantern built, like a role's privileges or an import preview). Plain query when absent.
   */
  kind?: "record" | "audit" | "write" | "report";
  /** The record a record or audit view is about. */
  record?: { table: string; id: string };
}

export interface QueryContext {
  dv: DataverseClient;
  entitySetOf: (table: string) => Promise<string>;
  primaryIdOf: (table: string) => string | undefined;
  maxRows: number;
}

type Row = Record<string, unknown>;

/**
 * Where <fetch> starts, allowing an XML declaration and comments before it; -1 when
 * the text isn't FetchXML.
 */
export function fetchXmlStart(text: string): number {
  const m = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<fetch[\s>]/i.exec(text);
  return m ? m[0].lastIndexOf("<fetch") : -1;
}

/** TOP n of an aggregate SQL query (the FetchXML can't carry it). */
function translateTop(sql: string): number | undefined {
  try {
    const q = parseSql(sql);
    return q.top !== undefined && (q.groupBy.length || q.items.some((i) => i.kind === "aggregate")) ? q.top : undefined;
  } catch {
    return undefined;
  }
}

/** Runs one SQL statement or FetchXML document. */
export async function runQuery(text: string, ctx: QueryContext): Promise<ResultSet> {
  const started = Date.now();
  let fetchXml: string;
  let table: string;
  let columns: ResultColumn[] | "all" = "all";
  let pageable: boolean;
  let having: Translation["having"];

  const fetchStart = fetchXmlStart(text);
  if (fetchStart >= 0) {
    fetchXml = text.slice(fetchStart).trim();
    table = /<entity\s+name\s*=\s*["']([\w]+)["']/i.exec(fetchXml)?.[1] ?? "";
    if (!table) throw new UserError("The FetchXML has no <entity name=\"...\"> element.");
    pageable = !/\s(top|count|aggregate)\s*=/i.test(fetchXml.slice(0, fetchXml.indexOf(">")));
  } else {
    let t;
    try {
      t = translate(text, { primaryIdOf: ctx.primaryIdOf });
    } catch (err) {
      if (err instanceof SqlError) throw new UserError(err.message);
      throw err;
    }
    fetchXml = t.fetchXml;
    table = t.table;
    columns = t.columns;
    pageable = t.top === undefined && !t.aggregate;
    having = t.having;
  }

  let set = await executeFetch(text.trim(), fetchXml, table, columns, pageable, ctx, started);
  // FetchXML aggregates don't take "top", so TOP on a grouped query trims the result here.
  const top = fetchStart < 0 ? translateTop(text) : undefined;
  // TOP was asked for, so trimming to it isn't "truncated".
  if (!having || columns === "all") return top !== undefined && set.rows.length > top ? { ...set, rows: set.rows.slice(0, top), rowIds: set.rowIds.slice(0, top) } : set;
  // FetchXML has no HAVING: keep only the groups that pass, by the aggregate's column in the grid.
  const index = new Map(columns.map((c, i) => [c.valueAlias ?? "", i]));
  const keep = set.rows.map((row) => passesHaving(Object.fromEntries(having!.map((h) => [h.alias, row[index.get(h.alias) ?? -1]?.raw])), having!));
  set = { ...set, rows: set.rows.filter((_, i) => keep[i]), rowIds: set.rowIds.filter((_, i) => keep[i]) };
  if (top !== undefined && set.rows.length > top) set = { ...set, rows: set.rows.slice(0, top), rowIds: set.rowIds.slice(0, top) };
  return set;
}

/** Runs FetchXML (paging when allowed) and shapes the rows into a ResultSet. */
export async function executeFetch(
  source: string,
  fetchXml: string,
  table: string,
  columns: ResultColumn[] | "all",
  pageable: boolean,
  ctx: QueryContext,
  started = Date.now()
): Promise<ResultSet> {
  const entitySet = await ctx.entitySetOf(table);
  const rows: Row[] = [];
  let truncated = false;
  if (!pageable) {
    rows.push(...(await page(ctx.dv, entitySet, fetchXml)).value);
  } else {
    const count = Math.min(5000, ctx.maxRows);
    let pageNumber = 1;
    let cookie: string | undefined;
    for (;;) {
      const xml = withFetchAttributes(fetchXml, { count: String(count), page: String(pageNumber), "paging-cookie": cookie });
      const result = await page(ctx.dv, entitySet, xml);
      rows.push(...result.value);
      const more = result[MORE_RECORDS] === true;
      if (!more) break;
      if (rows.length >= ctx.maxRows) {
        truncated = true;
        break;
      }
      cookie = pagingCookieFrom(result[PAGING_COOKIE] as string | undefined);
      pageNumber++;
    }
    if (rows.length > ctx.maxRows) {
      rows.length = ctx.maxRows;
      truncated = true;
    }
  }

  const shaped = shape(rows, columns, ctx.primaryIdOf(table) ?? `${table}id`);
  return { source, table, fetchXml, ...shaped, truncated, elapsedMs: Date.now() - started };
}

async function page(dv: DataverseClient, entitySet: string, fetchXml: string): Promise<Row & { value: Row[] }> {
  return dv.getJson<Row & { value: Row[] }>(`${entitySet}?fetchXml=${encodeURIComponent(fetchXml)}`, {
    Prefer: 'odata.include-annotations="*"',
  });
}

/** Sets (or removes, when undefined) attributes on the <fetch> element. */
export function withFetchAttributes(fetchXml: string, attrs: Record<string, string | undefined>): string {
  return fetchXml.replace(/<fetch\b([^>]*)>/i, (_m, existing: string) => {
    let rest = existing;
    for (const name of Object.keys(attrs)) rest = rest.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, "i"), "");
    const added = Object.entries(attrs)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => ` ${k}="${xmlEscape(v!)}"`)
      .join("");
    return `<fetch${rest.replace(/\s*\/?$/, "")}${added}>`;
  });
}

/**
 * The Web API returns the paging cookie wrapped and URL-encoded twice:
 * <cookie pagenumber="2" pagingcookie="%253ccookie..." />. FetchXML wants the inner cookie.
 */
export function pagingCookieFrom(annotation: string | undefined): string | undefined {
  if (!annotation) return undefined;
  const m = /pagingcookie="([^"]*)"/.exec(annotation);
  if (!m) return undefined;
  return decodeURIComponent(decodeURIComponent(m[1]));
}

/** Turns Web API rows into a grid, keeping both underlying and display values. */
export function shape(rows: Row[], columns: ResultColumn[] | "all", primaryId: string): { columns: string[]; rows: Cell[][]; rowIds: Array<string | undefined> } {
  let keys: Array<{ header: string; key: string }>;
  if (columns === "all") {
    const seen = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) if (!k.includes("@") && k !== primaryId) seen.add(k);
    keys = [...seen].map((key) => ({ key, header: /^_(.+)_value$/.exec(key)?.[1] ?? key }));
    if (rows.some((r) => primaryId in r)) keys.unshift({ key: primaryId, header: primaryId });
  } else {
    keys = columns.map((c) => {
      if (c.valueAlias) return { header: c.header, key: c.valueAlias };
      const base = c.entityAlias ? `${c.entityAlias}.${c.column}` : c.column!;
      const lookupKey = `_${c.column}_value`;
      const key = !c.entityAlias && rows.some((r) => lookupKey in r) && !rows.some((r) => base in r) ? lookupKey : base;
      return { header: c.header, key };
    });
  }

  const grid = rows.map((row) =>
    keys.map(({ key }): Cell => {
      const raw = row[key] ?? null;
      const formatted = row[`${key}${FORMATTED}`] as string | undefined;
      const lookupTable = row[`${key}${LOOKUP_TABLE}`] as string | undefined;
      const cell: Cell = { raw };
      if (formatted !== undefined && String(formatted) !== String(raw)) cell.formatted = formatted;
      if (lookupTable && typeof raw === "string") cell.ref = { table: lookupTable, id: raw };
      return cell;
    })
  );
  return { columns: keys.map((k) => k.header), rows: grid, rowIds: rows.map((r) => (typeof r[primaryId] === "string" ? (r[primaryId] as string) : undefined)) };
}

// ---------- export ----------

export function cellText(cell: Cell, formatted: boolean): string {
  if (formatted && cell.formatted !== undefined) return cell.formatted;
  if (cell.raw === null || cell.raw === undefined) return "";
  return typeof cell.raw === "object" ? JSON.stringify(cell.raw) : String(cell.raw);
}

export function toCsv(set: ResultSet, formatted: boolean): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [set.columns.map(esc).join(",")];
  for (const row of set.rows) lines.push(row.map((c) => esc(cellText(c, formatted))).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function toJson(set: ResultSet, formatted: boolean): string {
  const rows = set.rows.map((row) => Object.fromEntries(set.columns.map((col, i) => [col, formatted ? cellText(row[i], true) : row[i].raw])));
  return JSON.stringify(rows, null, 2) + "\n";
}
