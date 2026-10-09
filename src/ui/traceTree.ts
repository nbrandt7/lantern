import * as vscode from "vscode";
import { Client } from "../core/clients";
import { DEFAULT_FILTER, fetchTraces, fetchTraceSetting, formatTrace, setTraceSetting, shortTypeName, TraceFilter, TraceLog } from "../core/traces";
import { dataverseFor } from "./auth";
import { scanAll, withProgress } from "./context";

export type TraceNode =
  | { kind: "client"; client: Client }
  | { kind: "trace"; client: Client; trace: TraceLog }
  | { kind: "message"; text: string; icon: string; command?: vscode.Command; client?: Client };

/** Newest plug-in trace log entries per client, with filters for errors, time, and plug-in name. */
export class TraceTree implements vscode.TreeDataProvider<TraceNode> {
  private readonly changed = new vscode.EventEmitter<TraceNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  filter: TraceFilter = { ...DEFAULT_FILTER };
  /** Called when filters change, so the tree showing traces can reload them. */
  onRefresh: () => void = () => undefined;

  refresh(): void {
    this.changed.fire(undefined);
    this.onRefresh();
  }

  /** "errors only, last 24 hours", shown next to the Traces node under Plug-ins. */
  describe(): string {
    const parts = [
      this.filter.errorsOnly ? "errors only" : "",
      this.filter.hours ? `last ${this.filter.hours === 1 ? "hour" : this.filter.hours < 48 ? `${this.filter.hours} hours` : `${this.filter.hours / 24} days`}` : "any time",
      this.filter.typeName ? `"${this.filter.typeName}"` : "",
    ].filter(Boolean);
    return parts.join(", ");
  }

  async getChildren(node?: TraceNode): Promise<TraceNode[]> {
    if (!node) {
      const clients = scanAll().clients.filter((c) => c.config.org);
      if (!clients.length) return [{ kind: "message", text: "No clients with an org URL yet", icon: "info" }];
      return clients.map((client) => ({ kind: "client", client }));
    }
    if (node.kind !== "client") return [];
    try {
      const dv = dataverseFor(node.client);
      const [traces, setting] = await Promise.all([fetchTraces(dv, this.filter), fetchTraceSetting(dv).catch(() => undefined)]);
      const out: TraceNode[] = [];
      if (setting && setting.setting === 0) {
        out.push({
          kind: "message",
          text: "Trace logging is off in this org. Turn it on",
          icon: "warning",
          client: node.client,
          command: { command: "lantern.traces.enableLogging", title: "Turn on", arguments: [node.client, setting.orgId] },
        });
      } else if (setting && setting.setting === 1) {
        out.push({ kind: "message", text: "Logging exceptions only (successful runs aren't traced)", icon: "info" });
      }
      if (!traces.length) out.push({ kind: "message", text: "No traces match the filter", icon: "info" });
      out.push(...traces.map((trace) => ({ kind: "trace" as const, client: node.client, trace })));
      return out;
    } catch (err) {
      return [{
        kind: "message",
        text: `Couldn't load: ${err instanceof Error ? err.message : String(err)}`,
        icon: "error",
        command: { command: "lantern.traces.refresh", title: "Retry" },
      }];
    }
  }

  getTreeItem(node: TraceNode): vscode.TreeItem {
    if (node.kind === "client") {
      const item = new vscode.TreeItem(node.client.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = node.client.orgHost;
      item.iconPath = new vscode.ThemeIcon("pulse");
      item.contextValue = "trace.client";
      return item;
    }
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = node.command;
      return item;
    }
    const t = node.trace;
    const failed = !!t.exception.trim();
    const item = new vscode.TreeItem(shortTypeName(t.typeName), vscode.TreeItemCollapsibleState.None);
    item.description = `${t.message}${t.table ? ` ${t.table}` : ""}, ${t.durationMs} ms, ${relative(t.createdOn)}`;
    item.iconPath = new vscode.ThemeIcon(failed ? "error" : "pass", new vscode.ThemeColor(failed ? "errorForeground" : "charts.green"));
    item.tooltip = `${t.typeName.split(",")[0]}\n${new Date(t.createdOn).toLocaleString()}\n${failed ? t.exception.split("\n")[0] : "Succeeded"}`;
    item.contextValue = "trace";
    item.command = { command: "lantern.traces.open", title: "Open trace", arguments: [node] };
    return item;
  }
}

function relative(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Read-only documents for individual traces: dataverse-trace:/<client>/<id>.log */
export class TraceDocProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "dataverse-trace";
  private readonly docs = new Map<string, string>();

  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }
}

export function registerTraceCommands(tree: TraceTree, docs: TraceDocProvider): vscode.Disposable[] {
  const r = vscode.commands.registerCommand;
  return [
    r("lantern.traces.refresh", () => tree.refresh()),
    r("lantern.traces.open", async (node: { client: Client; trace: TraceLog }) => {
      const uri = vscode.Uri.from({ scheme: TraceDocProvider.scheme, path: `/${node.client.name}/${shortTypeName(node.trace.typeName)}-${node.trace.id}.log` });
      docs.set(uri, formatTrace(node.trace));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    r("lantern.traces.filter", async () => {
      const f = tree.filter;
      const picks = [
        { label: f.errorsOnly ? "$(check) Errors only" : "Errors only", action: () => (f.errorsOnly = !f.errorsOnly) },
        { label: "Last hour", action: () => (f.hours = 1) },
        { label: "Last 24 hours", action: () => (f.hours = 24) },
        { label: "Last 7 days", action: () => (f.hours = 168) },
        { label: "Any time", action: () => (f.hours = 0) },
        { label: "Plug-in name contains…", action: async () => {
          const v = await vscode.window.showInputBox({ prompt: "Part of the plug-in type name, e.g. AccountPostUpdate", value: f.typeName });
          if (v !== undefined) f.typeName = v;
        } },
        { label: "Clear filters", action: () => Object.assign(f, DEFAULT_FILTER) },
      ];
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Filter plug-in traces" });
      if (!pick) return;
      await pick.action();
      tree.refresh();
    }),
    r("lantern.traces.enableLogging", async (client: Client, orgId: string) => {
      const choice = await vscode.window.showWarningMessage(
        `Turn on plug-in trace logging for ${client.orgHost}${client.isProtected ? ` (${client.envName}, a protected environment)` : ""}? This changes an org-wide setting (System Settings, Customization tab) and needs the System Administrator role.`,
        { modal: true },
        "Log everything",
        "Log exceptions only"
      );
      if (!choice) return;
      const ok = await withProgress("Turning on trace logging", async () => {
        await setTraceSetting(dataverseFor(client), orgId, choice === "Log everything" ? 2 : 1);
        return true;
      });
      if (ok) {
        tree.refresh();
        void vscode.window.showInformationMessage(`Trace logging is on for ${client.orgHost}. Run the plug-in again to see traces.`);
      }
    }),
  ];
}
