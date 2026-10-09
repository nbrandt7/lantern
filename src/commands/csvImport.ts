import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { parseCsv } from "../core/csv";
import { ColumnMeta, MetadataService, TableMeta } from "../core/metadata";
import { Cell, QueryContext, ResultSet } from "../core/query";
import { LookupResolver, prepareValues } from "../core/write";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, reportError, settings, withProgress } from "../ui/context";
import { ResultsView } from "../ui/results";

export interface CsvPlan {
  /** Column for each CSV header, or undefined when it doesn't match one. */
  mapping: Array<ColumnMeta | undefined>;
  ignored: string[];
  /** Index of the primary ID column, when the file has one: those rows update instead of create. */
  idIndex: number;
  rows: string[][];
}

/** Matches headers to columns by logical name, schema name, or display name (case-insensitive). */
export function planCsv(table: TableMeta, columns: ColumnMeta[], csv: string[][]): CsvPlan {
  const [headers = [], ...rows] = csv;
  const find = (h: string) => {
    const k = h.trim().toLowerCase();
    return columns.find((c) => !c.attributeOf && (c.logicalName === k || c.schemaName?.toLowerCase() === k || c.displayName.toLowerCase() === k));
  };
  const mapping = headers.map(find);
  // The primary ID column (e.g. accountid) means "update this row"; it's never written as a value.
  const idIndex = headers.findIndex((h) => h.trim().toLowerCase() === table.primaryId);
  if (idIndex >= 0) mapping[idIndex] = undefined;
  return { mapping, ignored: headers.filter((_, i) => !mapping[i] && i !== idIndex), idIndex, rows };
}

export function registerCsvImport(serviceFor: (c: Client) => MetadataService, results: ResultsView): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("lantern.metadata.importCsv", async (node: { kind: string; client: Client; table: TableMeta }) => {
      try {
        if (node?.kind !== "table") return;
        await importCsv(node.client, node.table, serviceFor(node.client), results);
      } catch (err) {
        reportError(err);
      }
    }),
  ];
}

async function importCsv(client: Client, table: TableMeta, service: MetadataService, results: ResultsView): Promise<void> {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ["csv", "txt"] }, openLabel: `Import into ${table.displayName}` });
  if (!picked?.[0]) return;
  const file = picked[0].fsPath;
  const columns = await service.columns(table.logicalName);
  const plan = planCsv(table, columns, parseCsv(fs.readFileSync(file, "utf8")));
  const mapped = plan.mapping.filter(Boolean) as ColumnMeta[];
  if (!mapped.length) {
    void vscode.window.showWarningMessage(`None of the CSV's headers match ${table.logicalName} columns. Use logical names (like "name") or display names (like "Account Name").`);
    return;
  }
  if (!plan.rows.length) {
    void vscode.window.showInformationMessage("The CSV has headers but no rows.");
    return;
  }
  const updates = plan.idIndex >= 0 ? plan.rows.filter((r) => (r[plan.idIndex] ?? "").trim()).length : 0;
  const creates = plan.rows.length - updates;

  // Preview first, in the results panel.
  const headers = plan.mapping.map((c, i) => (c ? c.logicalName : "")).filter(Boolean);
  const preview: ResultSet = {
    source: `Import preview: ${path.basename(file)} into ${table.logicalName}`,
    table: table.logicalName,
    fetchXml: "",
    columns: ["Action", ...headers],
    rows: plan.rows.slice(0, 200).map((r) => [
      { raw: plan.idIndex >= 0 && (r[plan.idIndex] ?? "").trim() ? "Update" : "Create" },
      ...plan.mapping.flatMap((c, i): Cell[] => (c ? [{ raw: (r[i] ?? "") === "" ? null : r[i] }] : [])),
    ]),
    rowIds: [],
    truncated: plan.rows.length > 200,
    elapsedMs: 0,
    kind: "report",
  };
  await results.show(`Import preview (${client.name})`, client, { sets: [preview], errors: [] });

  const parts = [creates ? `${creates.toLocaleString()} new` : "", updates ? `${updates.toLocaleString()} updated by ID` : ""].filter(Boolean).join(", ");
  const detail = [
    `Columns: ${headers.join(", ")}.`,
    plan.ignored.length ? `Ignored (no matching column): ${plan.ignored.join(", ")}.` : "",
    "Empty cells are left as they are. Lookups take a GUID, or table:GUID for customer and owner columns; choices take the number or the label.",
  ].filter(Boolean).join("\n\n");
  const button = `Import ${plan.rows.length.toLocaleString()} Rows`;
  const ok = await vscode.window.showWarningMessage(`Import ${plan.rows.length.toLocaleString()} ${table.displayName} rows (${parts})?`, { modal: true, detail }, button);
  if (ok !== button || !(await confirmProtected(client, `Import ${table.displayName} rows`))) return;

  const dv = dataverseFor(client);
  const tables = await service.tables();
  const ctx: QueryContext = {
    dv,
    maxRows: settings().queryMaxRows,
    primaryIdOf: (t: string) => tables.find((x) => x.logicalName === t)?.primaryId,
    entitySetOf: async (t: string) => tables.find((x) => x.logicalName === t.toLowerCase())?.entitySetName ?? `${t}s`,
  };
  const lookups = new LookupResolver(ctx);
  const outcome = await withProgress(`Importing into ${table.displayName}`, async (pctx, progress) => {
    const rows: Cell[][] = [];
    const ids: Array<string | undefined> = [];
    for (const [i, r] of plan.rows.entries()) {
      if (pctx.token?.isCancellationRequested) break;
      const id = plan.idIndex >= 0 ? (r[plan.idIndex] ?? "").trim() : "";
      const assignments = plan.mapping.flatMap((c, j) => (c && j !== plan.idIndex && (r[j] ?? "") !== "" ? [{ column: c.logicalName, value: r[j] }] : []));
      const name = table.primaryName ? r[plan.mapping.findIndex((c) => c?.logicalName === table.primaryName)] ?? `row ${i + 1}` : `row ${i + 1}`;
      try {
        const p = await prepareValues(table, columns, assignments, ctx, lookups);
        if (id) {
          await dv.update(`${table.entitySetName}(${id})`, p.body);
          rows.push([{ raw: i + 2 }, { raw: name }, { raw: "Updated" }]);
          ids.push(id);
        } else {
          ids.push(await dv.create(table.entitySetName, p.body));
          rows.push([{ raw: i + 2 }, { raw: name }, { raw: "Created" }]);
        }
      } catch (err) {
        rows.push([{ raw: i + 2 }, { raw: name }, { raw: `Failed: ${err instanceof Error ? err.message : String(err)}` }]);
        ids.push(id || undefined);
      }
      if (i % 10 === 0) progress.report({ message: `${i + 1} of ${plan.rows.length}` });
    }
    return { rows, ids };
  });
  if (!outcome) return;
  const failed = outcome.rows.filter((r) => String(r[2].raw).startsWith("Failed")).length;
  await results.show(`Import (${client.name})`, client, {
    sets: [{
      source: `Import ${path.basename(file)} into ${table.logicalName}`,
      table: table.logicalName,
      fetchXml: "",
      columns: ["CSV line", table.primaryName || "record", "Result"],
      rows: outcome.rows,
      rowIds: outcome.ids,
      truncated: false,
      elapsedMs: 0,
      kind: "write",
    }],
    errors: [],
  });
  void vscode.window.showInformationMessage(`Imported ${outcome.rows.length - failed} of ${plan.rows.length} rows${failed ? `; ${failed} failed (see the results)` : ""}.`);
}
