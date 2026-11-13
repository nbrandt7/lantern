import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { UserError } from "../core/errors";
import { MetadataService, TableMeta } from "../core/metadata";
import { fetchXmlStart, QueryContext, runQuery, ResultSet } from "../core/query";
import { QueryHistory } from "../core/history";
import { fillIn, originOf } from "./fetchInCode";
import { parseStatement, splitStatements, SqlError, Statement, translate } from "../core/sql";
import { applyWrite, hintText, limits, planWrite } from "../core/write";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, clientForPath, resolveClient, scanAll, settings, withProgress } from "../ui/context";
import { columnMarkdown } from "../ui/metadataTree";
import { ResultsView } from "../ui/results";
import { activeTenant } from "../ui/tenantContext";

/** Queries always run against the selected tenant, including saved queries and old query documents. */
export function clientForQuery(doc: vscode.TextDocument): Client | undefined {
  return activeTenant();
}

export function isFetchXml(text: string): boolean {
  return fetchXmlStart(text) >= 0;
}

export async function newQuery(arg?: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client?.config.org) {
    if (client) void vscode.window.showWarningMessage(`Set "org" in the ${client.name} tenant configuration first.`);
    return;
  }
  const content = [
    `-- Tenant: ${client.name}`,
    "-- Run with F5 (or the Run link above). Select text to run just that part. Queries are read-only.",
    "",
    "SELECT TOP 50 name, createdon",
    "FROM account",
    "ORDER BY createdon DESC",
    "",
  ].join("\n");
  const doc = await vscode.workspace.openTextDocument({ language: "sql", content });
  await vscode.window.showTextDocument(doc);
}

/** Opens a new query document for the client with the given SQL, and runs it unless told not to. */
export async function openQuery(client: Client, sql: string, run: boolean, serviceFor: (c: Client) => MetadataService, results: ResultsView): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: "sql", content: `-- Dataverse: ${client.name}\n${sql}\n` });
  await vscode.window.showTextDocument(doc);
  if (run) await runQueryCommand(serviceFor, results, doc.uri);
}

/** Runs the selection, or every statement in the document. FetchXML documents run as one query. */
let history: QueryHistory | undefined;
let onHistory: () => void = () => undefined;

/** Where finished queries get recorded, and what to refresh afterwards. */
export function useQueryHistory(h: QueryHistory, changed: () => void): void {
  history = h;
  onHistory = changed;
}

export interface RunAs {
  userId: string;
  name: string;
}

export async function runQueryCommand(
  serviceFor: (c: Client) => MetadataService,
  results: ResultsView,
  arg?: vscode.Uri,
  runAs?: RunAs
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const doc = arg ? vscode.workspace.textDocuments.find((d: vscode.TextDocument) => d.uri.toString() === arg.toString()) ?? editor?.document : editor?.document;
  if (!doc) return;
  let client = clientForQuery(doc);
  if (!client) {
    client = await resolveClient();
    if (!client) return;
  }
  if (!client.config.org) {
    void vscode.window.showWarningMessage(`Set "org" in the ${client.name} tenant configuration first.`);
    return;
  }
  const selection = editor && editor.document === doc && !editor.selection.isEmpty ? doc.getText(editor.selection) : undefined;
  const text = selection ?? doc.getText();
  const statements = isFetchXml(text) ? [text.trim()] : splitStatements(text);
  if (!statements.length) {
    void vscode.window.showInformationMessage("There's no query to run.");
    return;
  }

  const target = client;
  const service = serviceFor(target);
  const outcome = await withProgress(`Running ${statements.length === 1 ? "query" : `${statements.length} queries`} on ${target.orgHost}`, async (ctx, progress) => {
    const tables = await service.tables();
    const byName = new Map(tables.map((t: TableMeta) => [t.logicalName, t]));
    const base = dataverseFor(target);
    const queryCtx = {
      // Impersonation: Dataverse runs the request with that user's security roles.
      dv: runAs ? base.withHeaders({ MSCRMCallerID: runAs.userId }) : base,
      maxRows: settings().queryMaxRows,
      cancel: ctx.token,
      onPage: (rows: number) => progress.report({ message: `${rows.toLocaleString()} rows so far…` }),
      primaryIdOf: (t: string) => byName.get(t)?.primaryId,
      entitySetOf: async (t: string) => {
        const meta = byName.get(t.toLowerCase());
        if (!meta?.entitySetName) throw new UserError(`There's no table named "${t}" in ${target.orgHost}.`);
        return meta.entitySetName;
      },
    };
    const sets: ResultSet[] = [];
    const errors: Array<{ source: string; message: string }> = [];
    const order: Array<["set" | "error", number]> = [];
    for (let [i, statement] of statements.entries()) {
      if (ctx.token?.isCancellationRequested) break;
      progress.report({ message: statements.length > 1 ? `${i + 1} of ${statements.length}` : undefined });
      try {
        // Only the FetchXML counts, not comments above it.
        const fetchPart = isFetchXml(statement) ? statement.slice(fetchXmlStart(statement)) : "";
        if (fetchPart && /\$\{[^}]+\}|\{\{[^}]+\}\}|\{\d+\}/.test(fetchPart)) {
          const filled = await fillIn(fetchPart);
          if (filled === undefined) throw new UserError("Cancelled: the FetchXML has placeholders that need values.");
          statement = filled;
        }
        const parsed = isFetchXml(statement) ? undefined : tryParse(statement);
        const set =
          parsed && parsed.kind !== "select"
            ? await runWrite(parsed, statement, target, service, queryCtx, ctx, progress)
            : await runQuery(statement, queryCtx);
        order.push(["set", sets.length]);
        sets.push(set);
        ctx.log(`${set.rows.length} rows from ${set.table} in ${set.elapsedMs} ms\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        order.push(["error", errors.length]);
        errors.push({ source: statement, message });
        ctx.log(`Query failed: ${message}\n`);
      }
    }
    return { sets, errors, order };
  });
  if (!outcome) return;
  const name = doc.isUntitled ? "Untitled query" : path.basename(doc.uri.fsPath);
  for (const set of outcome.sets) {
    if (!set.kind) history?.add(target.name, { sql: set.source, when: new Date().toISOString(), environment: target.envName, rows: set.rows.length });
  }
  if (outcome.sets.length) onHistory();
  await results.show(`${name} (${target.name}${target.envName ? ` ${target.envName}` : ""}${runAs ? `, as ${runAs.name}` : ""})`, target, outcome);
}

/** Comments before a statement: new query documents start with "-- Tenant:" lines. */
const LEADING_COMMENTS = /^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*(?:(?!\*\/)[\s\S])*\*\/))*/;
/** An UPDATE, DELETE or INSERT, whatever comments come before it. */
export const isWriteStatement = (s: string) => /^\s*(update|delete|insert)\b/i.test(s.replace(LEADING_COMMENTS, ""));
const WRITE_STATEMENT = { test: isWriteStatement };

function tryParse(statement: string): Statement | undefined {
  try {
    return parseStatement(statement);
  } catch (err) {
    // A write statement's own syntax error is the useful message; left to runQuery, it would say UPDATE has no FetchXML.
    if (WRITE_STATEMENT.test(statement)) throw err instanceof SqlError ? new UserError(err.message) : err;
    return undefined; // runQuery reports the parse error with its own message
  }
}

/**
 * UPDATE or DELETE: finds the matching rows first, shows how many and which,
 * and only changes them after you confirm.
 */
async function runWrite(
  stmt: Extract<Statement, { kind: "update" | "delete" | "insert" }>,
  source: string,
  client: Client,
  service: MetadataService,
  queryCtx: QueryContext,
  ctx: { token?: { isCancellationRequested: boolean; onCancellationRequested(l: () => void): unknown }; log: (t: string) => void },
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ResultSet> {
  const table = (await service.tables()).find((t) => t.logicalName === stmt.table);
  if (!table?.entitySetName) throw new UserError(`There's no table named "${stmt.table}" in ${client.orgHost}.`);
  const columns = await service.columns(table.logicalName);
  const planning = Date.now();
  const plan = await planWrite(stmt, source, table, columns, queryCtx);
  const verb = plan.kind === "update" ? "Update" : plan.kind === "insert" ? "Create" : "Delete";
  if (plan.kind !== "insert") ctx.log(`Found ${plan.rows.length.toLocaleString()} ${table.logicalName} row${plan.rows.length === 1 ? "" : "s"} to ${verb.toLowerCase()} in ${Date.now() - planning} ms\n`);
  if (!plan.rows.length) throw new UserError(`No ${table.logicalName} rows match, so nothing was ${plan.kind === "update" ? "updated" : "deleted"}.`);
  if (!(await confirmProtected(client, `${verb} ${table.displayName} rows`))) throw new UserError("Cancelled. Nothing was changed.");

  const n = plan.rows.length;
  const rowsText = `${n.toLocaleString()} ${table.displayName} row${n === 1 ? "" : "s"}`;
  const sample = plan.rows.slice(0, 10).map((r) => `• ${r.name}`).join("\n") + (n > 10 ? `\n…and ${(n - 10).toLocaleString()} more` : "");
  const warning = plan.hasWhere ? "" : "\n\nThere's no WHERE clause, so this affects every row in the table.";
  const bypass = plan.hints?.length ? `\n\n${hintText(plan.hints)}` : "";
  const change =
    plan.kind === "update"
      ? `Set ${plan.summary} on ${rowsText}?`
      : plan.kind === "insert"
        ? `Create ${rowsText} (${plan.summary})?`
        : `Delete ${rowsText}? This can't be undone.`;
  const button = `${verb} ${n.toLocaleString()} Row${n === 1 ? "" : "s"}`;
  const choice = await vscode.window.showWarningMessage(change, { modal: true, detail: `${sample}${warning}${bypass}` }, button);
  if (choice !== button) throw new UserError("Cancelled. Nothing was changed.");

  ctx.log(`${verb} ${n.toLocaleString()} ${table.logicalName} rows in batches of ${limits.startBatchSize} to start (then sized to take about ${Math.round(limits.batchMs / 1000)} s each), ${limits.concurrency} at a time to start\n`);
  const doing = plan.kind === "update" ? "Updating" : plan.kind === "insert" ? "Creating" : "Deleting";
  let reported = 0;
  const result = await applyWrite(
    plan,
    queryCtx,
    (done) => {
      progress.report({ message: `${doing} ${done.toLocaleString()} of ${n.toLocaleString()} rows`, increment: ((done - reported) / n) * 100 });
      reported = done;
    },
    ctx.token,
    ctx.log
  );
  const failed = result.rows.filter((r) => String(r[1].raw).startsWith("Failed")).length;
  const skipped = result.rows.filter((r) => String(r[1].raw).startsWith("Skipped")).length;
  ctx.log(`${verb}d ${(n - failed - skipped).toLocaleString()} of ${n.toLocaleString()} rows in ${result.elapsedMs} ms${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped (cancelled)` : ""}\n`);
  return result;
}

/** Opens the FetchXML a SQL query (or the selected part) translates to. */
export async function showFetchXml(serviceFor: (c: Client) => MetadataService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  const client = clientForQuery(editor.document);
  const tables = client ? serviceFor(client).cached<TableMeta[]>("tables") ?? [] : [];
  const primary = new Map(tables.map((t) => [t.logicalName, t.primaryId]));
  try {
    const xml = splitStatements(text)
      .map((s) => {
        if (WRITE_STATEMENT.test(s)) return `<!-- ${s.replace(LEADING_COMMENTS, "").trim().split(/\r?\n/)[0].trim().replace(/-{2,}/g, "-")} … changes data, so it has no FetchXML. -->`;
        const t = translate(s, { primaryIdOf: (name) => primary.get(name) });
        const note = t.having ? `<!-- FetchXML has no HAVING. The extension keeps only the rows where ${t.having.map((h) => h.text).join(" and ")}. -->\n` : "";
        return note + t.fetchXml;
      })
      .join("\n\n");
    const doc = await vscode.workspace.openTextDocument({ language: "xml", content: xml + "\n" });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
  }
}

const KEYWORDS = ["SELECT", "DISTINCT", "TOP", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "BETWEEN", "EXISTS", "NOT EXISTS", "OPTION", "BYPASS PLUGINS", "BYPASS SYNC PLUGINS", "BYPASS ASYNC PLUGINS", "BYPASS FLOWS",
  "INNER JOIN", "LEFT JOIN", "ON", "AS", "GROUP BY", "ORDER BY", "ASC", "DESC", "COUNT(*)", "SUM", "AVG", "MIN", "MAX"];

/** Tables after FROM/JOIN, columns after "alias." or anywhere else in a query, from the cached metadata. */
export class SqlCompletions implements vscode.CompletionItemProvider {
  constructor(private readonly serviceFor: (c: Client) => MetadataService) {}

  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const client = clientForQuery(doc);
    if (!client?.config.org) return undefined;
    const svc = this.serviceFor(client);
    const before = doc.getText(new vscode.Range(0, 0, position.line, position.character));
    const word = /[\w]*$/.exec(before)![0];
    const range = new vscode.Range(position.line, position.character - word.length, position.line, position.character);
    const tables = await svc.tables({ silent: true }).catch(() => undefined);
    if (!tables) return undefined;

    if (/\b(from|join)\s+[\w]*$/i.test(before)) {
      return tables.map((t) => {
        const item = new vscode.CompletionItem({ label: t.logicalName, description: t.displayName }, vscode.CompletionItemKind.Struct);
        item.range = range;
        item.filterText = `${t.logicalName} ${t.displayName.replace(/\s+/g, "")}`;
        item.sortText = (t.isCustom ? "0" : "1") + t.logicalName;
        return item;
      });
    }

    const aliases = aliasMap(doc.getText());
    const dotted = /(\w+)\.(\w*)$/.exec(before);
    const targets = dotted ? [aliases.get(dotted[1].toLowerCase())].filter((t): t is string => !!t) : [...new Set(aliases.values())];
    const items: vscode.CompletionItem[] = [];
    for (const table of targets) {
      const columns = await svc.columns(table, { silent: true }).catch(() => []);
      for (const c of columns) {
        if (c.attributeOf) continue;
        const item = new vscode.CompletionItem({ label: c.logicalName, description: `${c.displayName} (${table})` }, vscode.CompletionItemKind.Field);
        item.range = range;
        item.detail = `${c.displayName || c.logicalName} · ${c.type}`;
        item.documentation = columnMarkdown(c);
        item.filterText = `${c.logicalName} ${c.displayName.replace(/\s+/g, "")}`;
        items.push(item);
      }
    }
    if (!dotted) {
      for (const k of KEYWORDS) {
        const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
        item.range = range;
        item.sortText = `~${k}`;
        items.push(item);
      }
    }
    return items;
  }
}

/** alias (and table name) -> table, from FROM and JOIN clauses. */
export function aliasMap(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:from|join)\s+\[?([\w]+)\]?(?:\s+(?:as\s+)?(?!(?:on|where|inner|left|join|order|group|outer|right)\b)([\w]+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const table = m[1].toLowerCase();
    map.set(table, table);
    if (m[2]) map.set(m[2].toLowerCase(), table);
  }
  return map;
}

export function queryCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const text = doc.getText();
  const sql = doc.languageId === "sql";
  const fetch = !sql && isFetchXml(text);
  if (!sql && !fetch) return [];
  const client = clientForQuery(doc);
  if (!client?.config.org) return [];
  const top = new vscode.Range(0, 0, 0, 0);
  const origin = originOf(doc);
  const writeBack = origin ? [new vscode.CodeLens(top, { title: `$(reply) Write back to ${path.basename(origin.file)}`, command: "lantern.fetchxml.writeBack", arguments: [doc.uri] })] : [];
  const lenses = [
    ...writeBack,
    new vscode.CodeLens(top, { title: `$(play) Run on ${client.name}${client.envName ? ` (${client.envName})` : ""}`, command: "lantern.query.run", arguments: [doc.uri] }),
    new vscode.CodeLens(top, { title: "Run as…", command: "lantern.query.runAs", arguments: [doc.uri] }),
  ];
  if (sql) lenses.push(new vscode.CodeLens(top, { title: "Show FetchXML", command: "lantern.query.showFetchXml" }));
  lenses.push(new vscode.CodeLens(top, { title: "Copy as code", command: "lantern.query.copyAs" }));
  return lenses;
}

/** Saves the active query into the client's queries folder, which the tree lists. */
export async function saveQuery(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const client = clientForQuery(doc);
  if (!client) {
    void vscode.window.showWarningMessage("Open a Dataverse query first.");
    return;
  }
  const name = await vscode.window.showInputBox({
    title: `Save query to ${client.name}/queries`,
    prompt: "Name",
    value: doc.isUntitled ? "" : path.basename(doc.uri.fsPath).replace(/\.(sql|xml)$/i, ""),
    validateInput: (v: string) => (/^[\w .-]+$/.test(v.trim()) ? undefined : "Use letters, numbers, spaces, dots, and dashes."),
  });
  if (!name) return;
  const ext = isFetchXml(doc.getText()) ? ".xml" : ".sql";
  const file = path.join(client.dir, "queries", `${name.trim()}${ext}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.getText());
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  onHistory();
}
