import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { toPosix } from "../core/files";
import { ColumnMeta, FormMeta, MetadataService, TableMeta } from "../core/metadata";
import { clientForPath, resolveClient, withProgress } from "../ui/context";
import { findUsages, usageMarkdown } from "../core/references";
import { dataverseFor } from "../ui/auth";
import { findFunction, findWebResourceFile } from "../core/handlers";
import { resolveWebResourceName } from "../core/solutions";
import { DataverseContentProvider } from "./webResources";
import { MetaNode, MetadataTree } from "../ui/metadataTree";

/** Read-only markdown documents describing a table: dataverse-meta:/<client>/<table>.md */
export class TableDocProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "dataverse-meta";
  private readonly docs = new Map<string, string>();

  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }
}

/** Opens a query document for a client, optionally running it. */
export type QueryRunner = (client: Client, sql: string, run: boolean) => Promise<void>;

type CopyWhat = "logicalName" | "schemaName" | "displayName" | "entitySetName" | "webApiUrl" | "name" | "label" | "value" | "id";

/** The text a "Copy > ..." submenu item copies for a node, or undefined when it doesn't apply. */
export function copyText(node: MetaNode, what: CopyWhat): string | undefined {
  switch (node.kind) {
    case "table": {
      const t = node.table;
      const values: Partial<Record<CopyWhat, string>> = {
        logicalName: t.logicalName, schemaName: t.schemaName, displayName: t.displayName, entitySetName: t.entitySetName,
        webApiUrl: t.entitySetName ? `${node.client.config.org}/api/data/v9.2/${t.entitySetName}` : undefined, id: t.metadataId,
      };
      return values[what];
    }
    case "column":
      return ({ logicalName: node.column.logicalName, schemaName: node.column.schemaName, displayName: node.column.displayName } as Partial<Record<CopyWhat, string>>)[what];
    case "option":
      return what === "value" ? String(node.value) : what === "label" ? node.label : undefined;
    case "tab":
      return what === "name" ? node.tab.name : what === "label" ? node.tab.label : undefined;
    case "section":
      return what === "name" ? node.section.name : what === "label" ? node.section.label : undefined;
    case "control":
      return what === "name" ? node.control.id : what === "label" ? node.control.label : undefined;
    case "form":
      return what === "name" ? node.form.name : what === "id" ? node.form.id : undefined;
    default:
      return undefined;
  }
}

/** SELECT listing a table's readable columns: primary ID and name first, then the rest by logical name. */
export function scriptSelect(table: TableMeta, columns: ColumnMeta[]): string {
  const names = columns.filter((c) => !c.attributeOf && c.readable !== false).map((c) => c.logicalName);
  const first = [table.primaryId, table.primaryName].filter((n) => n && names.includes(n));
  const rest = names.filter((n) => !first.includes(n)).sort();
  return `SELECT TOP 100\n${[...first, ...rest].map((n) => `    ${n}`).join(",\n")}\nFROM ${table.logicalName}`;
}

/**
 * Opens the function a form event runs: in the client folder's copy of the library,
 * or, when there's no local copy, a read-only copy fetched from Dataverse.
 */
export async function goToHandler(client: Client, libraryName: string, functionName: string, remote: DataverseContentProvider): Promise<void> {
  const local = findWebResourceFile(client, libraryName);
  let doc: vscode.TextDocument;
  if (local) {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(local));
  } else {
    const choice = await vscode.window.showInformationMessage(
      `${libraryName} isn't in the ${client.name} folder. Pull the solution that contains it to edit it locally.`,
      "Open from Dataverse"
    );
    if (choice !== "Open from Dataverse") return;
    const wr = await withProgress(`Fetching ${libraryName}`, () => dataverseFor(client).findWebResource(libraryName));
    if (wr === undefined) return;
    if (!wr) {
      void vscode.window.showWarningMessage(`${libraryName} doesn't exist in ${client.orgHost}.`);
      return;
    }
    const name = /\.[a-z]+$/i.test(libraryName) ? libraryName : `${libraryName}.js`;
    const uri = vscode.Uri.from({ scheme: DataverseContentProvider.scheme, path: `/${client.name}/${name}` });
    remote.set(uri, Buffer.from(wr.content, "base64").toString("utf8"));
    doc = await vscode.workspace.openTextDocument(uri);
  }
  const at = findFunction(doc.getText(), functionName);
  if (!at) {
    await vscode.window.showTextDocument(doc);
    void vscode.window.showWarningMessage(
      `Couldn't find a definition of ${functionName} in ${libraryName}. If the form runs this handler, it will fail with "${functionName} is not a function" or similar.`
    );
    return;
  }
  const range = new vscode.Range(at.line, at.character, at.line, at.character + at.length);
  await vscode.window.showTextDocument(doc, { selection: range, preview: false });
}

/** Column name if the table has it, for building queries that only use what exists. */
function has(columns: ColumnMeta[], name: string): string {
  return columns.some((c) => c.logicalName === name) ? name : "";
}

function primaryNameColumn(table: TableMeta, columns: ColumnMeta[]): string {
  return (table.primaryName && has(columns, table.primaryName)) || table.primaryId;
}

/** Column types Dataverse can GROUP BY (long text, files, images, and multi-select choices can't). */
const GROUPABLE = (type: string) => !["Memo", "File", "Image", "Virtual", "MultiSelectPicklist", "PartyList", "EntityName"].includes(type);

/** Groups of rows that share the same values, largest first. Empty values are left out. */
export function duplicatesSql(table: TableMeta, columns: string[]): string {
  const list = columns.join(", ");
  const label = columns.length === 1 ? `the same ${columns[0]}` : `the same ${columns.slice(0, -1).join(", ")} and ${columns[columns.length - 1]}`;
  return (
    `-- ${table.displayName} rows that share ${label} (empty values left out)\n` +
    `SELECT ${list}, COUNT(*) AS count\nFROM ${table.logicalName}\n` +
    `WHERE ${columns.map((c) => `${c} IS NOT NULL`).join(" AND ")}\n` +
    `GROUP BY ${list}\nHAVING COUNT(*) > 1\nORDER BY count DESC`
  );
}

export function registerMetadataCommands(
  tree: MetadataTree,
  serviceFor: (c: Client) => MetadataService,
  docs: TableDocProvider,
  clearAll: () => void,
  runQuery: QueryRunner,
  remote: DataverseContentProvider
): vscode.Disposable[] {
  const r = vscode.commands.registerCommand;

  /** Loads the table's columns, builds a query (or a reason it doesn't apply), and runs it. */
  const tableQuery = async (node: MetaNode, build: (t: TableMeta, cols: ColumnMeta[]) => string): Promise<void> => {
    if (node.kind !== "table") return;
    const cols = await withProgress(`Loading ${node.table.logicalName} columns`, () => serviceFor(node.client).columns(node.table.logicalName));
    if (!cols) return;
    const sql = build(node.table, cols);
    if (!/^(--|SELECT)/.test(sql)) {
      void vscode.window.showInformationMessage(sql);
      return;
    }
    await runQuery(node.client, sql, true);
  };
  const copyCommands = (["logicalName", "schemaName", "displayName", "entitySetName", "webApiUrl", "name", "label", "value", "id"] as CopyWhat[]).map((what) =>
    r(`lantern.metadata.copy.${what}`, async (node: MetaNode) => {
      const text = copyText(node, what);
      if (text === undefined || text === "") return;
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`$(copy) Copied ${text.length > 60 ? text.slice(0, 57) + "..." : text}`, 3000);
    })
  );
  return [
    ...copyCommands,

    r("lantern.metadata.goToHandler", (node: MetaNode) => {
      if (node.kind === "handler") return goToHandler(node.client, node.handler.libraryName, node.handler.functionName, remote);
    }),

    r("lantern.metadata.selectTop", (node: MetaNode) => {
      if (node.kind === "table") return runQuery(node.client, `SELECT TOP 1000 *\nFROM ${node.table.logicalName}`, true);
    }),

    r("lantern.metadata.scriptSelect", async (node: MetaNode) => {
      if (node.kind !== "table") return;
      const columns = await withProgress(`Loading ${node.table.logicalName} columns`, () => serviceFor(node.client).columns(node.table.logicalName));
      if (columns) await runQuery(node.client, scriptSelect(node.table, columns), false);
    }),

    r("lantern.metadata.countRows", async (node: MetaNode) => {
      if (node.kind !== "table") return;
      const t = node.table.logicalName;
      const result = await withProgress(`Counting ${t} rows`, () =>
        dataverseFor(node.client).getJson<{ EntityRecordCountCollection: { Keys: string[]; Values: number[] } }>(
          `RetrieveTotalRecordCount(EntityNames=@p1)?@p1=${encodeURIComponent(JSON.stringify([t]))}`
        )
      );
      if (!result) return;
      const { Keys, Values } = result.EntityRecordCountCollection;
      const count = Values[Keys.indexOf(t)] ?? Values[0] ?? 0;
      const choice = await vscode.window.showInformationMessage(
        `${node.table.displayName} has about ${count.toLocaleString()} rows. Dataverse refreshes this count periodically, so very recent changes may be missing.`,
        "Count Exactly"
      );
      if (choice) await runQuery(node.client, `SELECT COUNT(*) AS count\nFROM ${t}`, true);
    }),

    r("lantern.metadata.openTableInBrowser", async (node: MetaNode) => {
      if (node.kind === "table") await vscode.env.openExternal(vscode.Uri.parse(`${node.client.config.org}/main.aspx?pagetype=entitylist&etn=${node.table.logicalName}`));
    }),

    r("lantern.metadata.newRecordInBrowser", async (node: MetaNode) => {
      if (node.kind === "table") await vscode.env.openExternal(vscode.Uri.parse(`${node.client.config.org}/main.aspx?pagetype=entityrecord&etn=${node.table.logicalName}`));
    }),

    r("lantern.metadata.addEarlyBound", async (node: MetaNode) => {
      if (node.kind !== "table") return;
      const client = node.client;
      client.reload();
      const list = client.config.earlyBound.entities;
      if (!list.includes(node.table.logicalName)) list.push(node.table.logicalName);
      client.save();
      const choice = await vscode.window.showInformationMessage(
        `${node.table.logicalName} is in the C# early-bound tables (${list.length} total).`,
        "Generate Now"
      );
      if (choice) await vscode.commands.executeCommand("lantern.generateEarlyBound", client);
    }),

    // ---------- debugging queries (Query submenu) ----------

    r("lantern.metadata.query.recentlyCreated", (node: MetaNode) =>
      tableQuery(node, (t, cols) => {
        const pick = [primaryNameColumn(t, cols), has(cols, "createdon"), has(cols, "createdby")].filter(Boolean).join(", ");
        if (!has(cols, "createdon")) return `${t.displayName} doesn't track when rows are created.`;
        return `-- The 100 newest ${t.displayName} rows\nSELECT TOP 100 ${pick}\nFROM ${t.logicalName}\nORDER BY createdon DESC`;
      })
    ),

    r("lantern.metadata.query.recentlyModified", (node: MetaNode) =>
      tableQuery(node, (t, cols) => {
        const pick = [primaryNameColumn(t, cols), has(cols, "modifiedon"), has(cols, "modifiedby")].filter(Boolean).join(", ");
        if (!has(cols, "modifiedon")) return `${t.displayName} doesn't track when rows change.`;
        return `-- The 100 most recently changed ${t.displayName} rows\nSELECT TOP 100 ${pick}\nFROM ${t.logicalName}\nORDER BY modifiedon DESC`;
      })
    ),

    r("lantern.metadata.query.inactive", (node: MetaNode) =>
      tableQuery(node, (t, cols) => {
        if (!has(cols, "statecode")) return `${t.displayName} has no active/inactive status.`;
        const pick = [primaryNameColumn(t, cols), has(cols, "statuscode"), has(cols, "modifiedon")].filter(Boolean).join(", ");
        return `-- Deactivated ${t.displayName} rows\nSELECT TOP 1000 ${pick}\nFROM ${t.logicalName}\nWHERE statecode = 1${has(cols, "modifiedon") ? "\nORDER BY modifiedon DESC" : ""}`;
      })
    ),

    r("lantern.metadata.query.byStatus", (node: MetaNode) =>
      tableQuery(node, (t, cols) => {
        if (!has(cols, "statuscode")) return `${t.displayName} has no status reason column.`;
        return `-- How many ${t.displayName} rows have each status reason\nSELECT statuscode, COUNT(*) AS count\nFROM ${t.logicalName}\nGROUP BY statuscode\nORDER BY count DESC`;
      })
    ),

    r("lantern.metadata.query.byOwner", (node: MetaNode) =>
      tableQuery(node, (t, cols) => {
        if (!has(cols, "ownerid")) return `${t.displayName} rows aren't owned by users or teams (it's organization-owned).`;
        return `-- How many ${t.displayName} rows each user or team owns\nSELECT ownerid, COUNT(*) AS count\nFROM ${t.logicalName}\nGROUP BY ownerid\nORDER BY count DESC`;
      })
    ),

    r("lantern.metadata.query.missingRequired", (node: MetaNode) =>
      tableQuery(node, (t, cols) => {
        const required = cols
          .filter((c) => c.requiredLevel === "ApplicationRequired" && !c.attributeOf && c.readable !== false && c.logicalName !== t.primaryId)
          .map((c) => c.logicalName);
        if (!required.length) return `${t.displayName} has no business-required columns.`;
        const name = primaryNameColumn(t, cols);
        const shown = [...new Set([name, ...required].filter(Boolean))].join(", ");
        return (
          `-- ${t.displayName} rows with a business-required column left empty\n` +
          `-- (the form enforces these, but imports, flows, and plug-ins can skip them)\n` +
          `SELECT TOP 1000 ${shown}\nFROM ${t.logicalName}\nWHERE ${required.map((c) => `${c} IS NULL`).join("\n   OR ")}`
        );
      })
    ),

    r("lantern.metadata.query.findDuplicates", async (node: MetaNode) => {
      if (node.kind !== "table") return;
      const cols = await withProgress(`Loading ${node.table.logicalName} columns`, () => serviceFor(node.client).columns(node.table.logicalName));
      if (!cols) return;
      const groupable = cols.filter((c) => !c.attributeOf && c.readable !== false && GROUPABLE(c.type) && c.logicalName !== node.table.primaryId);
      const picks = await vscode.window.showQuickPick(
        groupable.map((c) => ({ label: c.displayName || c.logicalName, description: c.logicalName, picked: c.logicalName === node.table.primaryName, column: c })),
        { canPickMany: true, placeHolder: "Rows count as duplicates when all of these columns match", matchOnDescription: true }
      );
      if (!picks?.length) return;
      const names = picks.map((p: { column: ColumnMeta }) => p.column.logicalName);
      return runQuery(node.client, duplicatesSql(node.table, names), true);
    }),

    r("lantern.metadata.query.duplicateValues", (node: MetaNode) => {
      if (node.kind !== "column") return;
      return runQuery(node.client, duplicatesSql(node.table, [node.column.logicalName]), true);
    }),

    r("lantern.metadata.query.missingValue", async (node: MetaNode) => {
      if (node.kind !== "column") return;
      const cols = await serviceFor(node.client).columns(node.table.logicalName);
      const c = node.column.logicalName;
      const pick = [primaryNameColumn(node.table, cols), has(cols, "createdon"), has(cols, "modifiedon")].filter((x) => x && x !== c).join(", ") || node.table.primaryId;
      return runQuery(
        node.client,
        `-- ${node.table.displayName} rows where ${node.column.displayName || c} is empty\nSELECT TOP 1000 ${pick}\nFROM ${node.table.logicalName}\nWHERE ${c} IS NULL${has(cols, "modifiedon") ? "\nORDER BY modifiedon DESC" : ""}`,
        true
      );
    }),

    r("lantern.metadata.query.extraSpaces", (node: MetaNode) => {
      if (node.kind !== "column") return;
      const c = node.column.logicalName;
      const name = node.table.primaryName && node.table.primaryName !== c ? `${node.table.primaryName}, ` : "";
      return runQuery(
        node.client,
        `-- Values that start or end with a space (a common cause of "duplicates" that don't match)\nSELECT TOP 1000 ${name}${c}\nFROM ${node.table.logicalName}\nWHERE ${c} LIKE ' %' OR ${c} LIKE '% '`,
        true
      );
    }),

    r("lantern.metadata.valueCounts", (node: MetaNode) => {
      if (node.kind !== "column") return;
      const c = node.column.logicalName;
      return runQuery(node.client, `SELECT ${c}, COUNT(*) AS count\nFROM ${node.table.logicalName}\nGROUP BY ${c}\nORDER BY count DESC`, true);
    }),

    r("lantern.metadata.selectWithColumn", (node: MetaNode) => {
      if (node.kind !== "column") return;
      const c = node.column.logicalName;
      const name = node.table.primaryName && node.table.primaryName !== c ? `${node.table.primaryName}, ` : "";
      return runQuery(node.client, `SELECT TOP 1000 ${name}${c}\nFROM ${node.table.logicalName}\nWHERE ${c} IS NOT NULL`, true);
    }),

    r("lantern.metadata.insertSetValue", (node: MetaNode) => {
      if (node.kind === "option") return insert(`formContext.getAttribute("${node.column.logicalName}").setValue(${node.value}); // ${node.label}`);
    }),

    r("lantern.metadata.insertUiGet", (node: MetaNode) => {
      if (node.kind === "tab") return insert(`formContext.ui.tabs.get("${node.tab.name}")`);
      if (node.kind === "section") return insert(`formContext.ui.tabs.get("${node.tab.name}").sections.get("${node.section.name}")`);
    }),

    r("lantern.metadata.refresh", (node?: MetaNode | { kind: "section"; client: Client; section: string }) => {
      if (node && node.kind === "section" && !("tab" in node)) {
        // The Tables node of a client: reload everything cached for that org.
        serviceFor(node.client).clear();
        tree.refresh();
        return;
      }
      const meta = node as MetaNode | undefined;
      if (meta && "client" in meta && "table" in meta && meta.table) {
        serviceFor(meta.client).clear(meta.table.logicalName);
        tree.refresh(meta.kind === "table" ? meta : undefined);
        return;
      }
      if (meta && meta.kind === "client") serviceFor(meta.client).clear();
      else clearAll();
      tree.refresh();
    }),

    r("lantern.metadata.copyName", async (node: MetaNode) => {
      const name = nameOf(node);
      if (name === undefined) return;
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(`$(copy) Copied ${name}`, 3000);
    }),

    r("lantern.metadata.insertGetAttribute", (node: MetaNode) => {
      const name = node.kind === "column" ? node.column.logicalName : node.kind === "control" ? node.control.field : undefined;
      if (name) return insert(`formContext.getAttribute("${name}")`);
    }),

    r("lantern.metadata.insertGetControl", (node: MetaNode) => {
      const name = node.kind === "control" ? node.control.id : node.kind === "column" ? node.column.logicalName : undefined;
      if (name) return insert(`formContext.getControl("${name}")`);
    }),

    r("lantern.metadata.openTable", async (node?: MetaNode) => {
      if (node?.kind === "table") return openTableDoc(node.client, node.table, serviceFor(node.client), docs);
      return findTable(serviceFor, docs);
    }),

    // From a client's All tables row: search that client, not the one the open editor belongs to.
    r("lantern.metadata.findTable", (node?: unknown) => findTable(serviceFor, docs, node)),

    r("lantern.metadata.findUsages", async (node?: MetaNode) => {
      let client: Client | undefined;
      let table: TableMeta | undefined;
      let column: ColumnMeta | undefined;
      if (node?.kind === "column") ({ client, table, column } = node);
      else {
        client = await resolveClient(node);
        if (!client?.config.org) return;
        table = await pickTable(client, serviceFor(client), "Find usages of a column in which table?");
        if (!table) return;
        const columns = await withProgress(`Loading ${table.logicalName} columns`, () => serviceFor(client!).columns(table!.logicalName));
        if (!columns) return;
        const pick = await vscode.window.showQuickPick(
          columns.filter((c) => !c.attributeOf).map((c) => ({ label: c.displayName || c.logicalName, description: c.logicalName, column: c })),
          { placeHolder: "Which column?", matchOnDescription: true }
        );
        column = pick?.column;
      }
      if (!client || !table || !column) return;
      const c = client;
      const t = table;
      const col = column;
      const report = await withProgress(`Finding where ${col.logicalName} is used`, async () =>
        findUsages(dataverseFor(c), t.logicalName, col.logicalName, await serviceFor(c).forms(t.logicalName), c.dir, (file) => resolveWebResourceName(file, c)?.name)
      );
      if (!report) return;
      const uri = vscode.Uri.from({ scheme: TableDocProvider.scheme, path: `/${c.name}/${t.logicalName}.${col.logicalName}.usages.md` });
      docs.set(uri, usageMarkdown(report, col.displayName || col.logicalName, (file, line) => vscode.Uri.file(file).with({ fragment: `L${line}` }).toString(), c.dir));
      try {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
      } catch {
        await vscode.window.showTextDocument(uri, { preview: true });
      }
    }),

    r("lantern.metadata.setFileTable", async (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      const client = file ? clientForPath(file) : undefined;
      if (!file || !client) {
        void vscode.window.showWarningMessage("Open a script inside a client folder first.");
        return;
      }
      const table = await pickTable(client, serviceFor(client), `Which table does ${path.basename(file)} work with?`);
      if (!table) return;
      client.config.fileTables[toPosix(path.relative(client.dir, file))] = table.logicalName;
      client.save();
      vscode.window.setStatusBarMessage(`$(table) ${path.basename(file)} → ${table.logicalName}`, 4000);
    }),
  ];
}

function nameOf(node: MetaNode): string | undefined {
  switch (node.kind) {
    case "table": return node.table.logicalName;
    case "column": return node.column.logicalName;
    case "option": return String(node.value);
    case "form": return node.form.id;
    case "tab": return node.tab.name;
    case "section": return node.section.name;
    case "control": return node.control.id;
    default: return undefined;
  }
}

async function insert(text: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(`No editor open, so ${text} was copied to the clipboard.`);
    return;
  }
  // appendText escapes everything snippets treat specially ($, }, \), so labels insert as written.
  await editor.insertSnippet(new vscode.SnippetString().appendText(text));
}

export async function pickTable(client: Client, service: MetadataService, placeHolder: string): Promise<TableMeta | undefined> {
  const tables = await withProgress(`Loading tables from ${client.orgHost}`, () => service.tables());
  if (!tables) return undefined;
  const inSolution = new Set(await service.solutionTables(client.config.solutions).catch(() => [] as string[]));
  const items = tables
    .map((t) => ({ label: t.displayName, description: t.logicalName, detail: inSolution.has(t.logicalName) ? "In your solution" : undefined, table: t }))
    .sort((a, b) => Number(!!b.detail) - Number(!!a.detail));
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  return pick?.table;
}

async function findTable(serviceFor: (c: Client) => MetadataService, docs: TableDocProvider, from?: unknown): Promise<void> {
  const client = await resolveClient(from);
  if (!client?.config.org) return;
  const service = serviceFor(client);
  const table = await pickTable(client, service, "Find a table (type a display name or logical name)");
  if (table) await openTableDoc(client, table, service, docs);
}

/** A readable reference sheet for one table: columns, choices, and every form's layout and handlers. */
async function openTableDoc(client: Client, table: TableMeta, service: MetadataService, docs: TableDocProvider): Promise<void> {
  const loaded = await withProgress(`Loading ${table.logicalName}`, async () => ({
    columns: await service.columns(table.logicalName),
    forms: await service.forms(table.logicalName),
  }));
  if (!loaded) return;
  const uri = vscode.Uri.from({ scheme: TableDocProvider.scheme, path: `/${client.name}/${table.logicalName}.md` });
  docs.set(uri, tableMarkdown(client, table, loaded.columns, loaded.forms));
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    await vscode.window.showTextDocument(uri, { preview: true });
  }
}

const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function tableMarkdown(client: Client, t: TableMeta, columns: ColumnMeta[], forms: FormMeta[]): string {
  const lines: string[] = [];
  lines.push(`# ${t.displayName} (\`${t.logicalName}\`)`, "");
  lines.push(`${client.name} · ${client.orgHost}`, "");
  lines.push("| | |", "|---|---|");
  lines.push(`| Schema name | ${t.schemaName} |`, `| Entity set (Web API) | ${t.entitySetName || "n/a"} |`);
  lines.push(`| Primary ID | ${t.primaryId} |`, `| Primary name | ${t.primaryName} |`, `| Custom | ${t.isCustom ? "yes" : "no"} |`, "");

  const visible = columns.filter((c) => !c.attributeOf);
  lines.push(`## Columns (${visible.length})`, "");
  lines.push("| Display name | Logical name | Type | Required | Details |", "|---|---|---|---|---|");
  for (const c of visible) {
    const details = [
      c.maxLength ? `max ${c.maxLength}` : "",
      c.targets?.length ? `→ ${c.targets.join(", ")}` : "",
      c.isCustom ? "custom" : "",
    ].filter(Boolean).join(" · ");
    lines.push(`| ${cell(c.displayName)} | \`${c.logicalName}\` | ${c.type} | ${c.requiredLevel === "None" ? "" : c.requiredLevel} | ${cell(details)} |`);
  }

  const choices = visible.filter((c) => c.options?.length);
  if (choices.length) {
    lines.push("", `## Choice values`, "");
    for (const c of choices) {
      lines.push(`**${cell(c.displayName)}** \`${c.logicalName}\`: ${c.options!.map((o) => `${o.value} = ${cell(o.label)}`).join(", ")}`, "");
    }
  }

  lines.push("", `## Forms (${forms.length})`);
  for (const f of forms) {
    lines.push("", `### ${f.name} (${f.type})`, "");
    if (f.libraries.length) lines.push(`Libraries: ${f.libraries.map((l) => `\`${l}\``).join(", ")}`, "");
    for (const e of f.events) {
      for (const h of e.handlers) {
        lines.push(
          `- **${e.name}${e.attribute ? ` (${e.attribute})` : ""}**: \`${h.libraryName}\` → \`${h.functionName}\`` +
            `${h.passExecutionContext ? "" : " (execution context not passed)"}${h.enabled ? "" : " (disabled)"}`
        );
      }
    }
    if (f.events.length) lines.push("");
    if (f.header.length) lines.push(`**Header:** ${f.header.map((c) => `\`${c.id}\``).join(", ")}`, "");
    for (const tab of f.tabs) {
      lines.push(`- Tab **${cell(tab.label || tab.name)}** \`${tab.name}\`${tab.visible ? "" : " (hidden)"}`);
      for (const s of tab.sections) {
        lines.push(`  - Section **${cell(s.label || s.name)}** \`${s.name}\`${s.visible ? "" : " (hidden)"}`);
        for (const c of s.controls) {
          const label = c.kind === "composite-part" ? `part: ${c.field}` : cell(c.label || c.kind);
          lines.push(`    - ${label}: \`${c.id}\`${c.visible ? "" : " (hidden)"}`);
        }
      }
    }
  }
  return lines.join("\n") + "\n";
}
