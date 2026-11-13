import { Cancellation } from "./process";
import { BATCH_LIMIT, BatchItem, BatchResult, DataverseClient } from "./dataverse";
import { UserError } from "./errors";
import { ColumnMeta, TableMeta } from "./metadata";
import { Cell, executeFetch, QueryContext, ResultSet } from "./query";
import { Literal, SelectQuery, Statement, translateQuery, WriteHint } from "./sql";

const LOOKUP_TYPES = ["Lookup", "Customer", "Owner"];
const NUMERIC = new Set(["Integer", "BigInt", "Decimal", "Double", "Money", "Picklist", "State", "Status"]);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values ready for the Web API: plain fields, lookup binds, and lookups to clear. */
export interface Prepared {
  body: Record<string, unknown>;
  /** Navigation properties to disassociate (setting a lookup to NULL). */
  clears: string[];
  /** File columns to clear. Dataverse doesn't take null for a File column in an update; the file is deleted with a DELETE on the column. */
  files: string[];
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
    const text = typeof value === "string" ? value.trim() : value;
    // A blank cell is no value, not 0 (Number(" ") is 0).
    if (text === "") return null;
    if (typeof text === "string" && column.options?.length && Number.isNaN(Number(text))) {
      const option = column.options.find((o) => o.label.toLowerCase() === text.toLowerCase());
      if (!option) throw new UserError(`${column.logicalName} has no choice labeled '${value}'. Options: ${column.options.map((o) => `${o.value} ${o.label}`).join(", ")}.`);
      return option.value;
    }
    // Only thousands separators are dropped: "1,000.50" is 1000.5, but a decimal comma ("1234,56") is refused rather than read as 123456.
    const n = typeof text === "number" ? text : Number(/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replace(/,/g, "") : text);
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
  const out: Prepared = { body: {}, clears: [], files: [], summary: [] };
  for (const a of assignments) {
    const column = columns.find((c) => c.logicalName === a.column.toLowerCase());
    if (!column) throw new UserError(`${table.logicalName} has no column named ${a.column}.`);
    if (column.type === "File") {
      if (a.value !== null && a.value !== "") {
        throw new UserError(`${column.logicalName} is a file column: SET ${column.logicalName} = NULL deletes the file, and files are uploaded from the app or the Web API, not set here.`);
      }
      out.files.push(column.logicalName);
      out.summary.push(`${column.logicalName} = NULL (file deleted)`);
      continue;
    }
    if (!LOOKUP_TYPES.includes(column.type)) {
      const value = coerce(column, a.value);
      out.body[column.logicalName] = value;
      out.summary.push(`${column.logicalName} = ${describe(column, value)}`);
      continue;
    }
    let navs = await lookups.navs(table.logicalName, column.logicalName);
    // ownerid's one many-to-one relationship points at the abstract "owner" table; the record bound is a user or a team.
    if (column.type === "Owner" && navs.length === 1 && navs[0].target === "owner") {
      const nav = navs[0].nav;
      navs = ["systemuser", "team"].map((target) => ({ nav, target }));
    }
    if (!navs.length) throw new UserError(`Couldn't find how ${column.logicalName} links to its table.`);
    if (a.value === null || a.value === "") {
      out.clears.push(...new Set(navs.map((n) => n.nav)));
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

/**
 * The request headers for a statement's OPTION (BYPASS ...) hints: Dataverse's optional parameters
 * MSCRM.BypassBusinessLogicExecution (needs the prvBypassCustomBusinessLogic privilege, which system
 * administrators have) and MSCRM.SuppressCallbackRegistrationExpanderJob (no privilege needed).
 */
export function hintHeaders(hints: WriteHint[] = []): Record<string, string> {
  const headers: Record<string, string> = {};
  const logic = [
    hints.includes("bypass plugins") || hints.includes("bypass sync plugins") ? "CustomSync" : "",
    hints.includes("bypass plugins") || hints.includes("bypass async plugins") ? "CustomAsync" : "",
  ].filter(Boolean);
  if (logic.length) headers["MSCRM.BypassBusinessLogicExecution"] = logic.join(",");
  if (hints.includes("bypass flows")) headers["MSCRM.SuppressCallbackRegistrationExpanderJob"] = "true";
  return headers;
}

/** What the hints mean, for the confirmation: "Custom plug-ins and workflows won't run; Power Automate flows won't be triggered." */
export function hintText(hints: WriteHint[] = []): string {
  const parts: string[] = [];
  const sync = hints.includes("bypass plugins") || hints.includes("bypass sync plugins");
  const async = hints.includes("bypass plugins") || hints.includes("bypass async plugins");
  if (sync && async) parts.push("Custom plug-ins and workflows won't run (BYPASS PLUGINS; needs the system administrator's bypass privilege)");
  else if (sync) parts.push("Custom synchronous plug-ins won't run (BYPASS SYNC PLUGINS; needs the system administrator's bypass privilege)");
  else if (async) parts.push("Custom asynchronous plug-ins and workflows won't run (BYPASS ASYNC PLUGINS; needs the system administrator's bypass privilege)");
  if (hints.includes("bypass flows")) parts.push("Power Automate flows won't be triggered (BYPASS FLOWS)");
  return parts.join(". ") + (parts.length ? "." : "");
}

export interface WritePlan {
  kind: "update" | "delete" | "insert";
  table: TableMeta;
  /** OPTION (BYPASS ...) on the statement; sent as headers with every row's requests. */
  hints?: WriteHint[];
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
      hints: stmt.hints,
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
  return { kind: stmt.kind, table, hints: stmt.hints, rows, prepared, summary: prepared?.summary.join(", ") ?? "", hasWhere: !!stmt.where, source };
}

/**
 * How changes are sent. Dataverse runs a batch's items one after another on one server, so
 * throughput comes from the number of batches in flight (lanes), not their size. The lanes are
 * tuned for rows per second: `concurrency` to start, doubling every `tickMs` while a row takes
 * no longer than it did with fewer lanes, then a quarter at a time, up while the rate still
 * rises and back when it falls (past some point more lanes only make every row slower, as the
 * server saturates). Dataverse's own recommendation (the x-ms-dop-hint header) and
 * `maxConcurrency` cap it, `minConcurrency` floors it, and a 429 halves it. Batch size only
 * sets how long each request lasts: `startBatchSize` rows, then sized so a batch takes about
 * `batchMs` (between `minBatchSize` and `batchSize` rows), so quick updates go in big batches
 * with few round trips, and slow ones (a File delete can take half a second per row) in small
 * batches that keep the progress moving and stay clear of the execution-time service protection
 * limit. Replaced in tests.
 */
export const limits = { batchSize: 100, startBatchSize: 20, minBatchSize: 5, batchMs: 5000, concurrency: 4, minConcurrency: 2, maxConcurrency: 52, tickMs: 10_000 };

/** The Web API requests one row needs: one, or for an UPDATE that clears lookups or files, the PATCH plus a DELETE per lookup (…/$ref) or file column. */
function requestsFor(plan: WritePlan, index: number): BatchItem[] {
  const set = plan.table.entitySetName;
  const row = plan.rows[index];
  const bypass = hintHeaders(plan.hints);
  const items: BatchItem[] = [];
  if (plan.kind === "insert") items.push({ method: "POST", path: set, body: plan.inserts![index].body });
  else if (plan.kind === "delete") items.push({ method: "DELETE", path: `${set}(${row.id})` });
  else {
    const p = plan.prepared!;
    if (Object.keys(p.body).length) items.push({ method: "PATCH", path: `${set}(${row.id})`, body: p.body, headers: { "If-Match": "*" } });
    for (const nav of p.clears) items.push({ method: "DELETE", path: `${set}(${row.id})/${nav}/$ref` });
    for (const column of p.files ?? []) items.push({ method: "DELETE", path: `${set}(${row.id})/${column}` });
  }
  if (Object.keys(bypass).length) for (const item of items) item.headers = { ...item.headers, ...bypass };
  return items;
}

/** Row indexes grouped so that each group's requests fit in one batch; a row is never split across two. */
export function chunkRows(requestCounts: number[], batchSize: number): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let size = 0;
  requestCounts.forEach((count, i) => {
    if (current.length && size + count > batchSize) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += count;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

/** One row's share of a write: its requests, and how to report it. */
export interface RowWrite {
  /** "Created", "Updated" or "Deleted": the row's Result when every request succeeds. */
  verb: string;
  /** The requests the row needs, in order. A DELETE of a …/$ref or a file column that answers 404 (already empty) is fine. */
  items: BatchItem[];
  /** The ID to report for the row; a create takes it from the answer's OData-EntityId instead. */
  id?: string;
  /** Set when the row couldn't be prepared: it's reported as failed and nothing is sent for it. */
  failed?: string;
}

export interface RowOutcome {
  /** The verb, "Failed: …" or "Skipped (cancelled)". */
  result: string;
  id?: string;
}

/** What sendRows needs from the client: $batch, the parallelism Dataverse recommends once a response has said, and when a 429's Retry-After ends. */
export type BatchClient = Pick<DataverseClient, "batch"> & { recommendedParallelism?: number; throttledUntil?: number };

/**
 * Sends rows in $batch requests, as many in flight at once as gives the most rows per second
 * (see limits). Failures don't stop the rest; each row gets its own outcome, in order. When
 * Dataverse answers 429, no new batch starts until its Retry-After ends and the batches in
 * flight drop to half. Cancelling skips the batches that haven't been sent yet. `log` gets a
 * line per tuning step (rows per second, time per row, lanes, batch size) and on a 429.
 */
export async function sendRows(rows: RowWrite[], dv: BatchClient, onProgress: (done: number) => void, token?: Cancellation, log?: (line: string) => void): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = rows.map((row) => ({ result: row.failed !== undefined ? `Failed: ${row.failed}` : "Skipped (cancelled)", id: row.id }));
  const sendable = rows.map((_, i) => i).filter((i) => rows[i].failed === undefined);
  const maxSize = Math.max(1, Math.min(limits.batchSize, BATCH_LIMIT));
  const minSize = Math.max(1, Math.min(limits.minBatchSize, maxSize));
  let batchSize = Math.max(minSize, Math.min(limits.startBatchSize, maxSize));
  let msPerRow = 0;
  let cursor = 0;
  /** The next rows whose requests fit in a batch of the current size; a row is never split across two. */
  const takeChunk = (): number[] => {
    const chunk: number[] = [];
    let size = 0;
    while (cursor < sendable.length && (!chunk.length || size + rows[sendable[cursor]].items.length <= batchSize)) {
      chunk.push(sendable[cursor]);
      size += rows[sendable[cursor++]].items.length;
    }
    return chunk;
  };
  let done = rows.length - sendable.length;
  /** The rows and batch time finished since the last tuning step. */
  const win = { rows: 0, ms: 0, since: Date.now(), throttled: false };
  const send = async (chunk: number[]) => {
    const started = Date.now();
    let answers: BatchResult[];
    try {
      answers = await dv.batch(chunk.flatMap((i) => rows[i].items));
      // Size the next batches so one takes about limits.batchMs, from a smoothed time per row.
      const elapsed = Date.now() - started;
      const perRow = elapsed / chunk.length;
      msPerRow = msPerRow ? msPerRow * 0.7 + perRow * 0.3 : perRow;
      batchSize = Math.max(minSize, Math.min(maxSize, Math.floor(limits.batchMs / Math.max(msPerRow, 0.01))));
      win.rows += chunk.length;
      win.ms += elapsed;
      if (started < (dv.throttledUntil ?? 0)) win.throttled = true; // part of this batch's time was a Retry-After wait
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const i of chunk) outcomes[i] = { result: `Failed: ${message}`, id: rows[i].id };
      done += chunk.length;
      onProgress(done);
      return;
    }
    let at = 0;
    for (const i of chunk) {
      const row = rows[i];
      const mine = answers.slice(at, at + row.items.length);
      at += row.items.length;
      // A DELETE of a row's lookup (…/$ref) or file column that answers 404 was already empty: fine.
      const failed = mine.find((a, j) => !a.ok && !(row.items[j].method === "DELETE" && /\)\/[^/]+(\/\$ref)?$/.test(row.items[j].path) && a.status === 404));
      if (failed) outcomes[i] = { result: `Failed: ${failed.error ?? `HTTP ${failed.status}`}`, id: row.id };
      else outcomes[i] = { result: row.verb, id: row.id ?? /\(([0-9a-f-]{36})\)/i.exec(mine[0]?.headers["odata-entityid"] ?? "")?.[1] };
    }
    done += chunk.length;
    onProgress(done);
  };
  // The lanes (batches in flight) are tuned for rows per second, not for the most lanes. The
  // signal is the time a row takes: flat while the server keeps up, rising once more lanes only
  // queue. Every tick, lanes double while a row takes at most a quarter longer than its best
  // (slow start); after that they move a quarter at a time, up while a row is still within a
  // quarter of its best, back once it takes three quarters longer. If taking lanes away didn't
  // make rows quicker but did cut the rate, the server is slow on its own: the lanes go back and
  // the slower time becomes the new best. Dataverse's x-ms-dop-hint and limits.maxConcurrency cap
  // it; a 429 halves it and holds new batches until Retry-After ends.
  const cap = () => Math.max(1, Math.min(limits.maxConcurrency, Math.max(limits.concurrency, dv.recommendedParallelism ?? 0)));
  const clamp = (w: number) => Math.max(Math.min(limits.minConcurrency, cap()), Math.min(cap(), Math.round(w)));
  let width = clamp(limits.concurrency);
  let congested = false;
  let basePerRow = 0; // the quickest time per row seen (reset when the server turns out to be slower on its own)
  let prev: { rate: number; perRow: number; width: number } | undefined;
  let announced = 0;
  let throttleSeen = 0;
  const tick = () => {
    const now = Date.now();
    // Windows at least as long as a batch and a half, so a width change has shown in the rate.
    if (now - win.since < Math.max(limits.tickMs, msPerRow * batchSize * 1.5) || !win.rows) return;
    const seconds = (now - win.since) / 1000;
    const rate = win.rows / seconds;
    const perRow = win.ms / win.rows;
    const was = width;
    if (!win.throttled) {
      basePerRow = basePerRow ? Math.min(perRow, basePerRow) : perRow;
      const quarter = Math.max(1, Math.round(was / 4));
      if (prev && was < prev.width && perRow > prev.perRow * 0.9 && rate < prev.rate * 0.95) {
        // Fewer lanes didn't make rows quicker, only fewer: the server is slow on its own. Go back and accept the time.
        basePerRow = perRow;
        width = prev.width;
      } else if (perRow <= basePerRow * 1.25) width = congested ? was + quarter : was * 2;
      else {
        congested = true;
        if (perRow >= basePerRow * 1.75) width = was - quarter;
      }
      prev = { rate, perRow, width: was };
      width = clamp(width);
    }
    if (cursor < sendable.length) {
      log?.(
        `Last ${Math.round(seconds)} s: ${win.rows.toLocaleString()} rows (${rate.toFixed(1)}/s), ${(perRow / 1000).toFixed(2)} s per row${basePerRow ? ` (best ${(basePerRow / 1000).toFixed(2)})` : ""}, ${was}${width !== was ? ` → ${width}` : ""} batches at a time, ${batchSize} rows each${win.throttled ? ", throttled" : ""}\n`
      );
    }
    Object.assign(win, { rows: 0, ms: 0, since: now, throttled: false });
  };
  const target = () => {
    const hint = dv.recommendedParallelism ?? 0;
    if (hint > limits.concurrency && hint !== announced && cursor < sendable.length) {
      announced = hint;
      log?.(`Dataverse allows up to ${hint} requests at a time for this environment: using up to ${cap()} batches in parallel, tuned for rows per second\n`);
    }
    const until = dv.throttledUntil ?? 0;
    if (until > throttleSeen) {
      // A 429: halve what's in flight and start the climb again from there.
      throttleSeen = until;
      width = clamp(Math.floor(width / 2));
      congested = true;
      prev = undefined;
      win.throttled = true;
      if (cursor < sendable.length) log?.(`Dataverse asked for a pause (429): waiting ${Math.max(0, Math.ceil((until - Date.now()) / 1000))} s, then ${width} batches at a time\n`);
    }
    return clamp(width);
  };
  await new Promise<void>((resolve) => {
    let active = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fill = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      tick();
      const hold = (dv.throttledUntil ?? 0) - Date.now();
      if (hold > 0 && cursor < sendable.length && !token?.isCancellationRequested) {
        target(); // notes the 429 now, so the width is cut before anything else starts
        timer = setTimeout(fill, hold);
        return;
      }
      while (active < target() && cursor < sendable.length && !token?.isCancellationRequested) {
        const chunk = takeChunk();
        active++;
        void send(chunk).then(() => {
          active--;
          fill();
        });
      }
      if (!active) resolve();
    };
    fill();
  });
  return outcomes;
}

/**
 * Applies a plan in $batch requests of up to limits.batchSize rows, as many in flight at once as
 * Dataverse recommends (see sendRows). Failures don't stop the rest; each row's outcome is in the
 * result. Cancelling skips the batches that haven't been sent yet.
 */
export async function applyWrite(plan: WritePlan, ctx: QueryContext, onProgress: (done: number) => void, token?: Cancellation, log?: (line: string) => void): Promise<ResultSet> {
  const started = Date.now();
  const verb = plan.kind === "insert" ? "Created" : plan.kind === "update" ? "Updated" : "Deleted";
  const outcomes = await sendRows(
    plan.rows.map((row, i) => ({ verb, items: requestsFor(plan, i), id: plan.kind === "update" ? row.id : undefined })),
    ctx.dv,
    onProgress,
    token,
    log
  );
  return {
    source: plan.source,
    table: plan.table.logicalName,
    fetchXml: "",
    columns: [plan.table.primaryName || "record", "Result"],
    rows: plan.rows.map((row, i) => [{ raw: row.name }, { raw: outcomes[i].result }]),
    rowIds: outcomes.map((o) => o.id),
    truncated: false,
    elapsedMs: Date.now() - started,
    kind: "write",
  };
}
