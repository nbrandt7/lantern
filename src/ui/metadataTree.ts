import * as vscode from "vscode";
import { Client } from "../core/clients";
import { ColumnMeta, ControlMeta, EventMeta, FormMeta, HandlerMeta, MetadataService, SectionMeta, TableMeta, TabMeta } from "../core/metadata";
import { scanAll } from "./context";

export type MetaNode =
  | { kind: "client"; client: Client }
  | { kind: "tableGroup"; client: Client; group: "solution" | "all" }
  | { kind: "table"; client: Client; table: TableMeta }
  | { kind: "columns"; client: Client; table: TableMeta }
  | { kind: "column"; client: Client; table: TableMeta; column: ColumnMeta }
  | { kind: "option"; column: ColumnMeta; value: number; label: string }
  | { kind: "forms"; client: Client; table: TableMeta }
  | { kind: "form"; client: Client; table: TableMeta; form: FormMeta }
  | { kind: "events"; client: Client; form: FormMeta }
  | { kind: "event"; client: Client; event: EventMeta }
  | { kind: "handler"; client: Client; event: EventMeta; handler: HandlerMeta }
  | { kind: "header"; client: Client; table: TableMeta; form: FormMeta }
  | { kind: "tab"; client: Client; table: TableMeta; tab: TabMeta }
  | { kind: "section"; client: Client; table: TableMeta; section: SectionMeta; tab: TabMeta }
  | { kind: "control"; client: Client; table: TableMeta; control: ControlMeta }
  | { kind: "message"; text: string; icon: string; command?: vscode.Command };

/**
 * Browses a client's Dataverse metadata: tables (the solution's first), their
 * columns with types and choice values, and their forms down to individual controls
 * and registered event handlers.
 */
export class MetadataTree implements vscode.TreeDataProvider<MetaNode> {
  private readonly changed = new vscode.EventEmitter<MetaNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly serviceFor: (client: Client) => MetadataService) {}

  refresh(node?: MetaNode): void {
    this.changed.fire(node);
  }

  async getChildren(node?: MetaNode): Promise<MetaNode[]> {
    try {
      return await this.children(node);
    } catch (err) {
      return [{
        kind: "message",
        text: `Couldn't load: ${err instanceof Error ? err.message : String(err)}`,
        icon: "error",
        command: { command: "lantern.metadata.refresh", title: "Retry", arguments: [node] },
      }];
    }
  }

  private async children(node?: MetaNode): Promise<MetaNode[]> {
    if (!node) {
      const clients = scanAll().clients.filter((c) => c.config.org);
      if (!clients.length) return [{ kind: "message", text: "No clients with an org URL yet", icon: "info" }];
      return clients.map((client) => ({ kind: "client", client }));
    }
    switch (node.kind) {
      case "client": {
        const groups: MetaNode[] = [];
        if (node.client.config.solutions.length) groups.push({ kind: "tableGroup", client: node.client, group: "solution" });
        groups.push({ kind: "tableGroup", client: node.client, group: "all" });
        return groups;
      }
      case "tableGroup": {
        const svc = this.serviceFor(node.client);
        const tables = await svc.tables();
        if (node.group === "all") return tables.map((table) => ({ kind: "table", client: node.client, table }));
        const inSolution = new Set(await svc.solutionTables(node.client.config.solutions));
        const list = tables.filter((t) => inSolution.has(t.logicalName));
        if (!list.length) return [{ kind: "message", text: "No tables in the solution", icon: "info" }];
        return list.map((table) => ({ kind: "table", client: node.client, table }));
      }
      case "table":
        return [
          { kind: "columns", client: node.client, table: node.table },
          { kind: "forms", client: node.client, table: node.table },
        ];
      case "columns": {
        const columns = await this.serviceFor(node.client).columns(node.table.logicalName);
        return columns
          .filter((column) => !column.attributeOf)
          .map((column) => ({ kind: "column", client: node.client, table: node.table, column }));
      }
      case "column":
        return (node.column.options ?? []).map((o) => ({ kind: "option", column: node.column, value: o.value, label: o.label }));
      case "forms": {
        const forms = await this.serviceFor(node.client).forms(node.table.logicalName);
        if (!forms.length) return [{ kind: "message", text: "No active forms", icon: "info" }];
        return forms.map((form) => ({ kind: "form", client: node.client, table: node.table, form }));
      }
      case "form": {
        const out: MetaNode[] = [];
        if (node.form.events.length) out.push({ kind: "events", client: node.client, form: node.form });
        if (node.form.header.length) out.push({ kind: "header", client: node.client, table: node.table, form: node.form });
        for (const tab of node.form.tabs) out.push({ kind: "tab", client: node.client, table: node.table, tab });
        return out;
      }
      case "events":
        return node.form.events.map((event) => ({ kind: "event", client: node.client, event }));
      case "event":
        return node.event.handlers.map((handler) => ({ kind: "handler", client: node.client, event: node.event, handler }));
      case "header":
        return node.form.header.map((control) => ({ kind: "control", client: node.client, table: node.table, control }));
      case "tab":
        return node.tab.sections.map((section) => ({ kind: "section", client: node.client, table: node.table, section, tab: node.tab }));
      case "section":
        return node.section.controls.map((control) => ({ kind: "control", client: node.client, table: node.table, control }));
      default:
        return [];
    }
  }

  getTreeItem(node: MetaNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case "client": {
        const item = new vscode.TreeItem(node.client.name, C.Collapsed);
        item.description = node.client.orgHost;
        item.iconPath = new vscode.ThemeIcon("database");
        item.contextValue = "meta.client";
        return item;
      }
      case "tableGroup": {
        const item = new vscode.TreeItem(node.group === "solution" ? "Solution tables" : "All tables", node.group === "solution" ? C.Expanded : C.Collapsed);
        item.description = node.group === "solution" ? node.client.config.solutions.join(", ") : undefined;
        item.iconPath = new vscode.ThemeIcon(node.group === "solution" ? "package" : "list-flat");
        return item;
      }
      case "table": {
        const t = node.table;
        const item = new vscode.TreeItem(t.displayName, C.Collapsed);
        item.description = t.logicalName;
        item.iconPath = new vscode.ThemeIcon("table");
        item.contextValue = "meta.table";
        item.tooltip = markdown(
          `**${t.displayName}** \`${t.logicalName}\`\n\n` +
            `| | |\n|---|---|\n| Schema name | ${t.schemaName} |\n| Entity set (Web API) | ${t.entitySetName || "n/a"} |\n` +
            `| Primary ID | ${t.primaryId} |\n| Primary name | ${t.primaryName} |\n| Custom | ${t.isCustom ? "yes" : "no"} |`
        );
        return item;
      }
      case "columns": {
        const item = new vscode.TreeItem("Columns", C.Collapsed);
        item.iconPath = new vscode.ThemeIcon("symbol-field");
        return item;
      }
      case "column": {
        const c = node.column;
        const item = new vscode.TreeItem(c.displayName || c.logicalName, c.options?.length ? C.Collapsed : C.None);
        item.description = `${c.logicalName} · ${c.type}${c.requiredLevel !== "None" ? " · required" : ""}`;
        item.iconPath = new vscode.ThemeIcon(columnIcon(c.type));
        // .text: string columns (extra-spaces check); .memo: long text, which Dataverse can't group by.
        item.contextValue = c.type === "String" ? "meta.column.text" : c.type === "Memo" ? "meta.column.memo" : "meta.column";
        item.tooltip = columnMarkdown(c);
        return item;
      }
      case "option": {
        const item = new vscode.TreeItem(node.label || "(no label)", C.None);
        item.tooltip = `${node.column.logicalName} = ${node.value}`;
        item.description = String(node.value);
        item.iconPath = new vscode.ThemeIcon("symbol-enum-member");
        item.contextValue = "meta.option";
        return item;
      }
      case "forms": {
        const item = new vscode.TreeItem("Forms", C.Collapsed);
        item.iconPath = new vscode.ThemeIcon("window");
        return item;
      }
      case "form": {
        const item = new vscode.TreeItem(node.form.name, C.Collapsed);
        item.description = node.form.type;
        item.iconPath = new vscode.ThemeIcon("browser");
        item.contextValue = "meta.form";
        if (node.form.libraries.length) item.tooltip = `Libraries: ${node.form.libraries.join(", ")}`;
        return item;
      }
      case "events": {
        const item = new vscode.TreeItem("Event handlers", C.Collapsed);
        item.iconPath = new vscode.ThemeIcon("zap");
        return item;
      }
      case "event": {
        const item = new vscode.TreeItem(node.event.name, C.Expanded);
        item.description = node.event.attribute;
        item.iconPath = new vscode.ThemeIcon("symbol-event");
        return item;
      }
      case "handler": {
        const h = node.handler;
        const item = new vscode.TreeItem(h.functionName, C.None);
        item.description = [h.libraryName, h.passExecutionContext ? "" : "execution context NOT passed", h.enabled ? "" : "disabled"]
          .filter(Boolean)
          .join(", ");
        item.iconPath = new vscode.ThemeIcon("symbol-function", h.passExecutionContext ? undefined : new vscode.ThemeColor("charts.orange"));
        item.contextValue = "meta.handler";
        item.tooltip = `Click to open ${h.functionName} in ${h.libraryName}`;
        item.command = { command: "lantern.metadata.goToHandler", title: "Go to Function", arguments: [node] };
        return item;
      }
      case "header": {
        const item = new vscode.TreeItem("Header", C.Collapsed);
        item.iconPath = new vscode.ThemeIcon("layout");
        return item;
      }
      case "tab": {
        const item = new vscode.TreeItem(node.tab.label || node.tab.name, C.Collapsed);
        item.description = node.tab.name + (node.tab.visible ? "" : " · hidden");
        item.iconPath = new vscode.ThemeIcon("folder-library");
        item.contextValue = "meta.tab";
        return item;
      }
      case "section": {
        const item = new vscode.TreeItem(node.section.label || node.section.name, C.Collapsed);
        item.description = node.section.name + (node.section.visible ? "" : " · hidden");
        item.iconPath = new vscode.ThemeIcon("symbol-namespace");
        item.contextValue = "meta.section";
        return item;
      }
      case "control": {
        const c = node.control;
        const label = c.label || (c.kind === "composite-part" ? `↳ ${c.field}` : c.id);
        const item = new vscode.TreeItem(label, C.None);
        item.description = c.id + (c.visible ? "" : " · hidden");
        item.iconPath = new vscode.ThemeIcon(
          c.kind === "subgrid" ? "list-unordered" : c.kind === "webresource" ? "globe" : c.kind === "composite-part" ? "indent" : "symbol-field"
        );
        item.contextValue = "meta.control";
        item.tooltip =
          c.kind === "composite-part"
            ? `Runtime control inside the composite field. getControl("${c.id}"); its column is "${c.field}".`
            : `getControl("${c.id}")${c.field ? `\nColumn: ${c.field}` : ""}`;
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.text, C.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.command = node.command;
        return item;
      }
    }
  }
}

function markdown(text: string): vscode.MarkdownString {
  return new vscode.MarkdownString(text);
}

export function columnIcon(type: string): string {
  switch (type) {
    case "Lookup": case "Customer": case "Owner": case "PartyList": return "references";
    case "Picklist": case "State": case "Status": case "MultiSelectPicklist": return "symbol-enum";
    case "Boolean": return "symbol-boolean";
    case "Integer": case "BigInt": case "Decimal": case "Double": case "Money": return "symbol-number";
    case "DateTime": return "calendar";
    case "Memo": return "note";
    case "Uniqueidentifier": return "key";
    default: return "symbol-string";
  }
}

/** Markdown summary of a column, shared by the tree tooltip and the editor hover. */
export function columnMarkdown(c: ColumnMeta): vscode.MarkdownString {
  const rows = [
    ["Logical name", `\`${c.logicalName}\``],
    ["Schema name", c.schemaName],
    ["Type", c.type],
    ["Required", c.requiredLevel],
  ];
  if (c.maxLength) rows.push(["Max length", String(c.maxLength)]);
  if (c.targets?.length) rows.push(["Targets", c.targets.map((t) => `\`${t}\``).join(", ")]);
  if (c.isCustom) rows.push(["Custom", "yes"]);
  let md = `**${c.displayName || c.logicalName}**\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}\n`;
  if (c.options?.length) {
    md += `\n| Value | Label |\n|---|---|\n${c.options.map((o) => `| ${o.value} | ${o.label} |`).join("\n")}\n`;
  }
  if (c.description) md += `\n${c.description}\n`;
  const result = new vscode.MarkdownString(md);
  result.supportThemeIcons = true;
  return result;
}
