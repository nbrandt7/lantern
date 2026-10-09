import * as path from "path";
import * as vscode from "vscode";
import { isTextWebResource, isWebResourceCandidate, resolveWebResourceName, webResourceType } from "../core/solutions";
import { Client } from "../core/clients";
import { findFunction } from "../core/handlers";
import { MetadataService } from "../core/metadata";
import { tableForDocument } from "./metadataLanguage";
import { fetchLiteralLenses } from "../commands/fetchInCode";
import { isCustomApiFile } from "../commands/customApi";
import { csharpTypes, pluginClassesIn, projectSourceFiles, typesInFiles } from "../core/csharp";
import { forgetOrgPlugins, orgPlugins, projectStatus, ProjectStatus } from "../core/pluginStatus";
import { assemblyNameOf, projectForFile } from "../core/solutions";
import { findFiles } from "../core/files";
import { dataverseFor } from "./auth";
import { clientForPath, settings } from "./context";
import { clientForQuery, isFetchXml, queryCodeLenses } from "../commands/query";

/** Shows the active editor's client and org; click for that client's actions. */
export class ClientStatusBar {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  update(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const isQuery = !!doc && (doc.languageId === "sql" || isFetchXml(doc.getText()));
    const client = (doc?.uri.scheme === "file" ? clientForPath(doc.uri.fsPath) : undefined) ?? (doc && isQuery ? clientForQuery(doc) : undefined);
    void vscode.commands.executeCommand("setContext", "lantern.activeIsQuery", isQuery && !!client?.config.org);
    const isWebResource = !!(client && doc && isWebResourceCandidate(doc.uri.fsPath, client));
    const isPluginSource = !!(client && doc && /\.cs$/i.test(doc.uri.fsPath));
    void vscode.commands.executeCommand("setContext", "lantern.activeIsWebResource", isWebResource && !!client?.config.org);
    void vscode.commands.executeCommand("setContext", "lantern.activeInClient", !!client);
    void vscode.commands.executeCommand("setContext", "lantern.activeIsPluginSource", isPluginSource);

    if (!client) {
      this.item.hide();
      return;
    }
    this.item.text = `$(cloud) ${client.name}${client.envName ? ` (${client.envName})` : client.orgHost ? ` (${client.orgHost.split(".")[0]})` : ""}`;
    this.item.backgroundColor = client.isProtected ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.item.tooltip = client.config.org ? `${client.name}\n${client.config.org}\nClick for actions` : `${client.name}: no org set`;
    this.item.command = { command: "lantern.clientActions", title: "Client actions", arguments: [client] };
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * Push/compare links at the top of web resource files, and a build-and-push link
 * above plug-in classes.
 */
export class DataverseCodeLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly serviceFor?: (c: Client) => MetadataService) {}

  refresh(): void {
    this.changed.fire();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!settings().codeLens) return [];
    if (doc.languageId === "sql" || (doc.languageId === "xml" && isFetchXml(doc.getText()))) return queryCodeLenses(doc);
    if (doc.uri.scheme !== "file") return [];
    const file = doc.uri.fsPath;
    const client = clientForPath(file);
    if (!client?.config.org) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    if (isCustomApiFile(file)) {
      return [
        new vscode.CodeLens(top, { title: "$(cloud-upload) Deploy Custom API", command: "lantern.customApi.deploy", arguments: [doc.uri] }),
        new vscode.CodeLens(top, { title: "Generate C# handler", command: "lantern.customApi.generateCSharp", arguments: [doc.uri] }),
        new vscode.CodeLens(top, { title: "Generate TypeScript client", command: "lantern.customApi.generateTypeScript", arguments: [doc.uri] }),
      ];
    }
    // FetchXML written in code: Run / Edit lenses above each one, in any JS, TS, or C# file.
    const fetchLenses = fetchLiteralLenses(doc);

    if (isWebResourceCandidate(file, client)) {
      const lenses = [...fetchLenses, new vscode.CodeLens(top, { title: "$(cloud-upload) Push to Dataverse", command: "lantern.pushWebResource", arguments: [doc.uri] })];
      if (isTextWebResource(file)) {
        lenses.push(new vscode.CodeLens(top, { title: "$(git-compare) Compare with Dataverse", command: "lantern.compareWebResource", arguments: [doc.uri] }));
      }
      if (this.serviceFor && webResourceType(file) === 3) lenses.push(...(await this.registrations(doc, client)));
      return lenses;
    }
    if (fetchLenses.length && !/\.cs$/i.test(file)) return fetchLenses;

    if (path.extname(file).toLowerCase() === ".cs") {
      const lenses = [...fetchLenses, ...(await this.pluginLenses(doc, client))];
      return lenses;
    }
    return fetchLenses;
  }

  /**
   * Above each function a form runs: which forms and events call it. Handlers that
   * point at a function this file doesn't define get a warning at the top.
   * Uses the forms of the script's table (from the file name, an annotation, or client.json).
   */
  /**
   * Each plug-in class in the file: Build and Push, its registration in the
   * active environment (steps, or "not registered yet"), Register Step, and
   * Compare with Deployed. Classes are matched to registered types by full name.
   */
  private async pluginLenses(doc: vscode.TextDocument, client: Client): Promise<vscode.CodeLens[]> {
    const file = doc.uri.fsPath;
    const project = projectForFile(file, client.dir);
    const own = csharpTypes(doc.getText(), file);
    if (!own.some((t) => t.bases.length)) return [];
    const others = project ? typesInFiles(projectSourceFiles(project).filter((f) => path.resolve(f) !== path.resolve(file))) : [];
    let classes = pluginClassesIn(own, others);
    if (!classes.length && own.some((t) => t.exported && t.bases.length)) {
      // Base class kept elsewhere in the folder (a shared library or linked file).
      const known = new Set([file, ...others.map((t) => t.file)].map((f) => path.resolve(f)));
      classes = pluginClassesIn(own, [...others, ...typesInFiles(findFiles(client.dir, (n, full) => n.toLowerCase().endsWith(".cs") && !known.has(path.resolve(full))))]);
    }
    if (!classes.length) return [];
    const plugin = project ? { project, assembly: assemblyNameOf(project) } : undefined;
    let status: ProjectStatus | undefined;
    if (plugin && client.config.org) {
      try {
        status = projectStatus(client, plugin, await orgPlugins(client, dataverseFor(client, { silent: true })));
      } catch {
        status = undefined; // signed out or offline: just the local actions
      }
    }
    const where = client.envName || client.orgHost;
    const lenses: vscode.CodeLens[] = [];
    for (const cls of classes) {
      const at = new vscode.Range(cls.line, 0, cls.line, 0);
      const target = plugin ? { client, plugin } : doc.uri;
      lenses.push(new vscode.CodeLens(at, { title: "$(rocket) Build and push", command: "lantern.pushPlugin", arguments: [target] }));
      const match = status?.classes.find((c) => c.typeName === cls.fullName);
      if (status && !match?.type) {
        lenses.push(new vscode.CodeLens(at, {
          title: status.registered ? `$(cloud-upload) Not registered in ${where} yet` : `$(cloud-upload) ${plugin!.assembly} isn't registered in ${where}`,
          tooltip: "Build and Push registers it",
          command: "lantern.pushPlugin",
          arguments: [target],
        }));
        continue;
      }
      if (match && cls.pluginKind === "plugin") {
        const steps = match.steps;
        const title = steps.length
          ? `$(plug) ${steps.length} step${steps.length === 1 ? "" : "s"}: ${steps.slice(0, 3).map((s) => `${s.message}${s.table ? ` of ${s.table}` : ""}${s.enabled ? "" : " (off)"}`).join(", ")}${steps.length > 3 ? ", …" : ""}`
          : "$(plug) No steps registered";
        lenses.push(new vscode.CodeLens(at, { title, tooltip: "Show this class and its steps in the Lantern view", command: "lantern.focusSteps", arguments: [{ client, typeName: cls.fullName }] }));
      }
      if (cls.pluginKind === "plugin") {
        lenses.push(new vscode.CodeLens(at, { title: "$(add) Register step", command: "lantern.steps.register", arguments: [{ client, assembly: plugin?.assembly, typeName: cls.fullName }] }));
      }
      if (match?.type && plugin) {
        lenses.push(new vscode.CodeLens(at, { title: "$(git-compare) Compare with deployed", command: "lantern.plugins.compareDeployed", arguments: [{ client, plugin, typeName: cls.fullName }] }));
      }
    }
    return lenses;
  }

  private async registrations(doc: vscode.TextDocument, client: Client): Promise<vscode.CodeLens[]> {
    const name = resolveWebResourceName(doc.uri.fsPath, client)?.name;
    if (!name || !this.serviceFor) return [];
    const st = await tableForDocument(doc, this.serviceFor, true).catch(() => undefined);
    if (!st) return [];
    const forms = await st.service.forms(st.table, { silent: true }).catch(() => undefined);
    if (!forms) return [];
    const byFunction = new Map<string, string[]>();
    for (const f of forms) {
      for (const e of f.events) {
        for (const h of e.handlers) {
          if (h.libraryName.toLowerCase() !== name.toLowerCase()) continue;
          const label = `${f.name} (${f.type}) ${eventLabel(e.name, e.attribute)}`;
          byFunction.set(h.functionName, [...(byFunction.get(h.functionName) ?? []), label]);
        }
      }
    }
    const text = doc.getText();
    const lenses: vscode.CodeLens[] = [];
    for (const [fn, where] of byFunction) {
      const at = findFunction(text, fn);
      const unique = [...new Set(where)];
      if (at) {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(at.line, 0, at.line, 0), {
            title: `$(zap) Runs on ${unique.join("; ")}`,
            tooltip: "Show what this function touches",
            command: "lantern.code.analyzeFunction",
            arguments: [doc.uri, fn],
          })
        );
      } else {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
            title: `$(warning) ${unique.join("; ")} calls ${fn}, which isn't defined in this file`,
            command: "",
          })
        );
      }
    }
    return lenses;
  }
}

/** Registered plug-ins are cached in pluginStatus; this drops them so CodeLens and the tree reload. */
export function forgetRegisteredSteps(): void {
  forgetOrgPlugins();
}

function eventLabel(name: string, attribute?: string): string {
  const pretty: Record<string, string> = { onload: "OnLoad", onsave: "OnSave", onchange: "OnChange", tabstatechange: "TabStateChange", onreadystatecomplete: "OnReadyStateComplete" };
  const label = pretty[name] ?? name;
  return attribute ? `${label} of ${attribute}` : label;
}
