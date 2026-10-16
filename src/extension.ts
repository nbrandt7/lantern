import * as path from "path";
import * as vscode from "vscode";
import { useClientStore } from "./core/clients";
import { languageForExtensionless } from "./core/solutions";
import { configureFolder, initWorkspace, newClient, openClientConfig, openInBrowser } from "./commands/clients";
import { generateEarlyBound, generateJsTypes } from "./commands/build";
import { compareDeployed, getPluginSource, pushPlugin } from "./commands/plugins";
import { compareWebResource, DataverseContentProvider, newFormScript, onSavePush, pushWebResources } from "./commands/webResources";
import { clearTokenCache, dataverseFor } from "./ui/auth";
import { WorkspaceTree } from "./ui/workspaceTree";
import { openPowerAutomateFlow } from "./commands/openPowerAutomateFlow";
import { openEnvironmentUrl } from "./ui/environmentBrowser";
import { useSecrets } from "./ui/auth";
import { registerAdminCommands } from "./commands/admin";
import { migrateLegacySettings, noticeLegacyExtension } from "./ui/migrate";
import { registerAnalysisCommands } from "./commands/analysis";
import { registerEnvironmentCommands } from "./commands/environments";
import { registerSolutionOps } from "./commands/solutionOps";
import { registerStepCommands } from "./commands/registerStep";
import { registerCsvImport } from "./commands/csvImport";
import { registerSecurityCommands } from "./commands/security";
import { registerTypeScript } from "./commands/typescript";
import { registerDocs } from "./commands/docs";
import { QueryHistory } from "./core/history";
import { ScriptDiagnostics } from "./ui/diagnostics";
import { FetchXmlCompletions } from "./ui/fetchXmlLanguage";
import { registerFetchInCode } from "./commands/fetchInCode";
import { registerScaffolding } from "./commands/scaffold";
import { registerPcfAndPages } from "./commands/pcfPages";
import { registerCustomApisAndForms } from "./commands/customApi";
import { registerCopilotTools } from "./ui/copilot";
import { clientForPath, reportError, resolveClient, SECTION, settings, withProgress, workspaceRoots, write } from "./ui/context";
import { ClientStatusBar, DataverseCodeLens } from "./ui/editor";
import { Client } from "./core/clients";
import { MetadataService } from "./core/metadata";
import { registerMetadataCommands, TableDocProvider } from "./commands/metadata";
import { MetadataCompletions, MetadataHover } from "./ui/metadataLanguage";
import { MetadataTree } from "./ui/metadataTree";
import { newQuery, openQuery, runQueryCommand, saveQuery, showFetchXml, SqlCompletions, useQueryHistory } from "./commands/query";
import { CellContext, ResultsView } from "./ui/results";
import { editUserSettings } from "./commands/userSettings";
import { openSearch } from "./commands/search";
import { addTenantCommand, selectTenantCommand } from "./commands/tenants";
import { configureTenantContext, importSavedTenants, removeTenant } from "./ui/tenantContext";
import { registerTraceCommands, TraceDocProvider, TraceTree } from "./ui/traceTree";
import { startFileLogging } from "./core/logger";

export function activate(context: vscode.ExtensionContext): void {
  try {
    const file = startFileLogging();
    write(`Lantern log: ${file}\n`);
  } catch (error) {
    reportError(error);
  }
  const statusBar = new ClientStatusBar();
  const contentProvider = new DataverseContentProvider();

  // One metadata cache per org, kept in the extension's storage (never in client repos).
  const services = new Map<string, MetadataService>();
  const serviceFor = (client: Client): MetadataService => {
    const key = client.orgHost || client.name;
    let svc = services.get(key);
    if (!svc) {
      svc = new MetadataService(path.join(context.globalStorageUri.fsPath, "metadata", key.replace(/[^a-zA-Z0-9.-]/g, "_")), (silent) =>
        dataverseFor(client, { silent })
      );
      services.set(key, svc);
    }
    return svc;
  };
  const metadata = new MetadataTree(serviceFor);
  const results = new ResultsView();
  const tableDocs = new TableDocProvider();
  const codeLens = new DataverseCodeLens(serviceFor);

  // One tree per workspace: each client holds its local folder and its org (tables, steps, traces, jobs...).
  const traces = new TraceTree();
  const traceDocs = new TraceDocProvider();
  if (context.secrets) useSecrets(context.secrets);
  const history = new QueryHistory(path.join(context.globalStorageUri.fsPath, "query-history.json"));
  const clients = new WorkspaceTree(serviceFor, metadata, traces, history);
  useQueryHistory(history, () => clients.refresh());
  const diagnostics = new ScriptDiagnostics(serviceFor);
  const checker = vscode.languages.createDiagnosticCollection("lantern-checker");
  const clientsView = vscode.window.createTreeView("lantern.clients", { treeDataProvider: clients, showCollapseAll: true });

  const refreshAll = (): void => {
    clients.refresh();
    statusBar.update();
    codeLens.refresh();
  };
  /** After a plug-in push or download: plug-in projects, steps, and plug-in CodeLens all change. */
  const pluginsChanged = (): void => {
    clients.reloadPlugins();
    clients.reloadSections("steps");
    codeLens.refresh();
  };

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(`${SECTION}.${id}`, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });

  context.subscriptions.push(
    clientsView,
    vscode.workspace.registerTextDocumentContentProvider(TableDocProvider.scheme, tableDocs),
    vscode.workspace.registerTextDocumentContentProvider(TraceDocProvider.scheme, traceDocs),
    vscode.languages.registerCompletionItemProvider({ language: "sql" }, new SqlCompletions(serviceFor), "."),
    ...registerTraceCommands(traces, traceDocs),
    cmd("search", () => openSearch()),
    cmd("openPowerAutomateFlow", (node: { client: Client; flow: { id: string } }) => openPowerAutomateFlow(node.client, node.flow.id)),
    cmd("openEnvironmentLink", (client: Client, url: string) => openEnvironmentUrl(client, url)),
    cmd("addTenant", () => addTenantCommand(refreshAll)),
    cmd("selectTenant", () => selectTenantCommand(refreshAll)),
    ...registerAdminCommands(clients, serviceFor, results, traceDocs, contentProvider),
    ...registerAnalysisCommands(serviceFor, tableDocs),
    ...registerEnvironmentCommands(serviceFor, tableDocs, contentProvider, () => {
      refreshAll();
      for (const doc of vscode.workspace.textDocuments) diagnostics.schedule(doc, 0);
    }),
    ...registerSolutionOps(tableDocs, checker),
    ...registerStepCommands(serviceFor, () => clients.reloadSections("steps")),
    ...registerCsvImport(serviceFor, results),
    ...registerSecurityCommands(serviceFor, results, tableDocs),
    ...registerTypeScript(),
    ...registerDocs(serviceFor),
    cmd("queries.save", () => saveQuery()),
    cmd("removeClient", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client) return;
      const ok = await vscode.window.showWarningMessage(
        `Remove ${client.name} from Lantern's tenant list?`,
        { modal: true },
        "Remove"
      );
      if (ok !== "Remove") return;
      removeTenant(client);
      refreshAll();
      void vscode.window.showInformationMessage(`${client.name} was removed from Lantern's tenant list.`);
    }),
    // From a plug-in class's "N steps" CodeLens: show that class under Plug-ins > Projects, steps expanded.
    cmd("focusSteps", async (arg?: Client | { client?: Client; typeName?: string }) => {
      await vscode.commands.executeCommand("lantern.clients.focus");
      clients.reloadSections("steps");
      const client = arg instanceof Client ? arg : arg?.client;
      if (!client) return;
      const target = await clients.revealTarget(client, arg instanceof Client ? undefined : arg?.typeName);
      if (target) await clientsView.reveal(target, { select: true, focus: true, expand: true });
    }),
    ...registerFetchInCode(),
    ...registerScaffolding(refreshAll),
    ...registerPcfAndPages(refreshAll),
    ...registerCustomApisAndForms(serviceFor, () => {
      clients.refresh();
      codeLens.refresh();
    }),
    ...registerCopilotTools(serviceFor),
    cmd("queries.openRecent", (node: { client: Client; entry: { sql: string } }) => openQuery(node.client, node.entry.sql, false, serviceFor, results)),
    vscode.languages.registerCompletionItemProvider({ language: "xml" }, new FetchXmlCompletions(serviceFor), '"', "'"),
    diagnostics.collection,
    checker,
    vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => diagnostics.schedule(doc, 0)),
    vscode.workspace.onDidChangeTextDocument((e: { document: vscode.TextDocument }) => diagnostics.schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => diagnostics.schedule(doc, 0)),
    vscode.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => diagnostics.clear(doc)),
    vscode.languages.registerCompletionItemProvider(
      [{ scheme: "file", language: "javascript" }, { scheme: "file", language: "typescript" }],
      new MetadataCompletions(serviceFor),
      '"', "'", "`"
    ),
    vscode.languages.registerHoverProvider(
      [{ scheme: "file", language: "javascript" }, { scheme: "file", language: "typescript" }],
      new MetadataHover(serviceFor)
    ),
    ...registerMetadataCommands(
      metadata,
      serviceFor,
      tableDocs,
      () => services.forEach((svc) => svc.clear()),
      (client, sql, run) => openQuery(client, sql, run, serviceFor, results),
      contentProvider
    ),
    vscode.window.registerWebviewViewProvider(ResultsView.id, results, { webviewOptions: { retainContextWhenHidden: true } }),
    cmd("results.copyCell", (c: CellContext) => results.copyCell(c)),
    cmd("results.copyRow", (c: CellContext) => results.copyRow(c)),
    cmd("results.copyColumn", (c: CellContext) => results.copyColumn(c)),
    cmd("results.openRecord", (c: CellContext) => results.openRecord(c)),
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(DataverseContentProvider.scheme, contentProvider),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", language: "javascript" }, { scheme: "file", language: "html" }, { scheme: "file", language: "css" },
        { scheme: "file", language: "xml" }, { scheme: "file", language: "csharp" }, { scheme: "file", pattern: "**/*.{svg,resx}" },
        { scheme: "file", pattern: "**/WebResources/**" }, { language: "sql" }, { scheme: "untitled", language: "xml" }],
      codeLens
    ),

    // Clients
    cmd("initWorkspace", () => initWorkspace()),
    cmd("newClient", () => newClient(refreshAll)),
    cmd("configureClient", (arg) => configureFolder(arg, refreshAll)),
    cmd("openClientConfig", (arg) => openClientConfig(arg)),
    cmd("openInBrowser", (arg) => openInBrowser(arg)),
    cmd("refresh", () => refreshAll()),
    cmd("clientActions", (arg) => clientActions(arg)),
    cmd("testConnection", (arg) => testConnection(arg)),
    cmd("signOut", () => {
      clearTokenCache();
      void vscode.window.showInformationMessage("Cleared cached Dataverse tokens. Manage the Microsoft account itself from the Accounts menu.");
    }),


    // Web resources
    cmd("pushWebResource", (arg, selection) => pushWebResources(arg, selection)),
    cmd("compareWebResource", (arg) => compareWebResource(contentProvider, arg)),
    cmd("newFormScript", (arg) => newFormScript(arg)),

    // Queries and admin tools
    cmd("query.new", (arg) => newQuery(arg)),
    cmd("query.run", (arg) => runQueryCommand(serviceFor, results, arg)),
    cmd("query.showFetchXml", () => showFetchXml(serviceFor)),
    cmd("editUserSettings", (arg) => editUserSettings(arg)),

    // C# and types
    cmd("pushPlugin", (arg) => pushPlugin(arg, pluginsChanged)),
    cmd("plugins.getSource", (arg) => getPluginSource(arg, pluginsChanged)),
    cmd("plugins.compareDeployed", (arg) => compareDeployed(arg)),
    cmd("plugins.openProject", (node: { plugin: { project: string } }) => vscode.window.showTextDocument(vscode.Uri.file(node.plugin.project))),
    cmd("generateJsTypes", (arg) => generateJsTypes(arg, refreshAll)),
    cmd("generateEarlyBound", (arg) => generateEarlyBound(arg)),

    // Keep everything in sync with what's on disk and on screen
    vscode.window.onDidChangeActiveTextEditor(() => statusBar.update()),
    vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => setExtensionlessLanguage(doc)),
    vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
      if (doc.uri.fsPath.endsWith(".lantern-client.json") || doc.uri.fsPath === path.join(context.globalStorageUri.fsPath, "tenants.json") ||
        (path.basename(doc.uri.fsPath) === "config.json" && path.basename(path.dirname(doc.uri.fsPath)) === ".lantern")) {
        configureTenantContext(path.join(context.globalStorageUri.fsPath, "tenants.json"), settings().clientSettingsLocation, workspaceRoots);
        refreshAll();
      }
      onSavePush(doc);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setUpClientSettingsStore(context);
      refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration(SECTION)) {
        if (e.affectsConfiguration(`${SECTION}.clientSettingsLocation`)) setUpClientSettingsStore(context);
        clearTokenCache();
        refreshAll();
      }
    })
  );

  void migrateLegacySettings(context.globalState).then((moved) => {
    if (moved) void vscode.window.showInformationMessage(`Lantern carried over ${moved} setting${moved === 1 ? "" : "s"} from Dataverse Workspace.`);
  });
  void noticeLegacyExtension();
  setUpClientSettingsStore(context);
  vscode.workspace.textDocuments.forEach((doc: vscode.TextDocument) => setExtensionlessLanguage(doc));
  statusBar.update();
  for (const doc of vscode.workspace.textDocuments) diagnostics.schedule(doc, 0);
}

/**
 * Web resources named without an extension are written to disk without one, so VS Code
 * opens them as plain text. Switch them to the language their .data.xml says they are.
 */
function setExtensionlessLanguage(doc: vscode.TextDocument): void {
  if (doc.uri.scheme !== "file") return;
  const language = languageForExtensionless(doc.uri.fsPath);
  if (language && doc.languageId !== language) {
    void Promise.resolve(vscode.languages.setTextDocumentLanguage(doc, language)).catch(() => undefined);
  }
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}

/** Selects the configured storage mode without importing or moving local files. */
function setUpClientSettingsStore(context: vscode.ExtensionContext): void {
  const base = context.globalStorageUri.fsPath;
  const global = settings().clientSettingsLocation === "global";
  useClientStore(global ? path.join(base, "clients") : undefined, path.join(base, "ignored-folders.json"));
  configureTenantContext(path.join(base, "tenants.json"), global ? "global" : "folder", workspaceRoots);
  if (global) importSavedTenants(path.join(base, "clients"));
}

async function testConnection(arg: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client) return;
  const who = await withProgress(`Connecting to ${client.orgHost}`, () => dataverseFor(client).whoAmI());
  if (who) void vscode.window.showInformationMessage(`Connected to ${client.orgHost} as user ${who.UserId}.`);
}

async function clientActions(arg: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client) return;
  const doc = vscode.window.activeTextEditor?.document;
  const items: Array<{ label: string; command: string; args: unknown[] }> = [
  ];
  // Only offer the open file when it belongs to this client.
  if (doc && doc.uri.scheme === "file" && clientForPath(doc.uri.fsPath)?.dir === client.dir) {
    items.push({ label: "$(cloud-upload) Push this file to Dataverse", command: "pushWebResource", args: [doc.uri] });
    items.push({ label: "$(git-compare) Compare this file with Dataverse", command: "compareWebResource", args: [doc.uri] });
  }
  items.push(
    { label: "$(rocket) Build and push plug-ins", command: "pushPlugin", args: [client] },
    { label: "$(symbol-interface) Generate JS form types", command: "generateJsTypes", args: [client] },
    { label: "$(symbol-class) Generate C# early-bound classes", command: "generateEarlyBound", args: [client] },
    { label: "$(database) New query", command: "query.new", args: [client] },
    { label: "$(references) Find where a column is used", command: "metadata.findUsages", args: [client] },
    ...(client.environments.length ? [{ label: `$(server-environment) Switch environment (now ${client.envName})…`, command: "environments.switch", args: [client] }] : []),
    { label: "$(search) Inspect a record…", command: "record.inspect", args: [client] },
    { label: "$(history) Audit history for a record…", command: "record.audit", args: [client] },
    { label: "$(broadcast) Publish all customizations", command: "publishAll", args: [client] },
    { label: "$(person) Edit user settings", command: "editUserSettings", args: [client] },
    { label: "$(plug) Test connection", command: "testConnection", args: [client] },
    { label: "$(globe) Open in browser", command: "openInBrowser", args: [client] },
    { label: "$(settings-gear) Edit .lantern/config.json", command: "openClientConfig", args: [client] }
  );
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `${client.name} · ${client.config.org || "no org set"}` });
  if (pick) await vscode.commands.executeCommand(`${SECTION}.${pick.command}`, ...pick.args);
}
