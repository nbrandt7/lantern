import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ensureClientConfig, excludeLocally, isClientFolderName, readClient, removeClientConfig, shouldAutoConfigure, useClientStore } from "./core/clients";
import { languageForExtensionless } from "./core/solutions";
import { configureFolder, initWorkspace, newClient, openClientConfig, openInBrowser, restoreDotnet } from "./commands/clients";
import { generateEarlyBound, generateJsTypes } from "./commands/build";
import { compareDeployed, getPluginSource, pushPlugin } from "./commands/plugins";
import { pullCommand, registerReviewCommands } from "./commands/pull";
import { compareWebResource, DataverseContentProvider, newFormScript, onSavePush, pushWebResources } from "./commands/webResources";
import { clearTokenCache, dataverseFor } from "./ui/auth";
import { WorkspaceTree } from "./ui/workspaceTree";
import { useSecrets } from "./ui/auth";
import { registerAdminCommands } from "./commands/admin";
import { migrateLegacySettings, noticeLegacyExtension } from "./ui/migrate";
import { registerAnalysisCommands } from "./commands/analysis";
import { registerEnvironmentCommands } from "./commands/environments";
import { registerSolutionOps } from "./commands/solutionOps";
import { openFlow } from "./commands/flows";
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
import { clientForPath, reportError, resolveClient, scanAll, SECTION, settings, withProgress, workspaceRoots, write } from "./ui/context";
import { ClientStatusBar, DataverseCodeLens } from "./ui/editor";
import { ReviewTree } from "./ui/review";
import { Client } from "./core/clients";
import { MetadataService } from "./core/metadata";
import { registerMetadataCommands, TableDocProvider } from "./commands/metadata";
import { MetadataCompletions, MetadataHover } from "./ui/metadataLanguage";
import { MetadataTree } from "./ui/metadataTree";
import { newQuery, openQuery, runQueryCommand, saveQuery, showFetchXml, SqlCompletions, useQueryHistory } from "./commands/query";
import { CellContext, ResultsView } from "./ui/results";
import { editUserSettings } from "./commands/userSettings";
import { registerTraceCommands, TraceDocProvider, TraceTree } from "./ui/traceTree";

export function activate(context: vscode.ExtensionContext): void {
  const review = new ReviewTree();
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
  const reviewView = vscode.window.createTreeView("lantern.review", { treeDataProvider: review, canSelectMany: true });
  review.attach(reviewView);

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
    reviewView,
    vscode.workspace.registerTextDocumentContentProvider(TableDocProvider.scheme, tableDocs),
    vscode.workspace.registerTextDocumentContentProvider(TraceDocProvider.scheme, traceDocs),
    vscode.languages.registerCompletionItemProvider({ language: "sql" }, new SqlCompletions(serviceFor), "."),
    ...registerTraceCommands(traces, traceDocs),
    ...registerAdminCommands(clients, serviceFor, results, traceDocs, contentProvider),
    ...registerAnalysisCommands(serviceFor, tableDocs),
    ...registerEnvironmentCommands(serviceFor, tableDocs, contentProvider, () => {
      refreshAll();
      for (const doc of vscode.workspace.textDocuments) diagnostics.schedule(doc, 0);
    }),
    ...registerSolutionOps(tableDocs, checker),
    cmd("flows.open", (node) => openFlow(node, context)),
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
        `Stop treating ${client.name} as a Lantern client? Lantern removes its settings for the folder and the jsconfig.json it created. Your files and the repo aren't touched.`,
        { modal: true },
        "Remove"
      );
      if (ok !== "Remove") return;
      removeClientConfig(client.dir);
      refreshAll();
      void vscode.window.showInformationMessage(`${client.name} is no longer a Lantern client. Use Configure as Client to add it back.`);
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

    // Pull and review
    cmd("pull", (arg) => pullCommand(review, arg, refreshAll)),
    ...registerReviewCommands(review, refreshAll),

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
      if (doc.uri.fsPath.endsWith(".lantern-client.json") ||
        (path.basename(doc.uri.fsPath) === "config.json" && path.basename(path.dirname(doc.uri.fsPath)) === ".lantern")) refreshAll();
      onSavePush(doc);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watchRoots(context, refreshAll);
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
  autoConfigureExisting();
  watchRoots(context, refreshAll);
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

let rootWatchers: vscode.Disposable[] = [];

/** Watches each clients folder so new subfolders get configured as soon as they appear. */
function watchRoots(context: vscode.ExtensionContext, onChange: () => void): void {
  rootWatchers.forEach((w) => w.dispose());
  rootWatchers = [];
  for (const root of workspaceRoots()) {
    if (readClient(root)) continue; // the workspace folder is itself a client
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), "*"));
    watcher.onDidCreate((uri: vscode.Uri) => {
      const name = path.basename(uri.fsPath);
      let isDir = false;
      try {
        isDir = fs.statSync(uri.fsPath).isDirectory();
      } catch {
        return;
      }
      if (!isDir || !isClientFolderName(name)) return;
      if (settings().clientSettingsLocation === "folder" && settings().autoConfigureNewFolders && !readClient(uri.fsPath) && shouldAutoConfigure(uri.fsPath, root)) {
        const client = ensureClientConfig(uri.fsPath, {}, { jsconfig: settings().createJsconfig });
        void restoreDotnet(client, write);
        void vscode.window.showInformationMessage(`Configured new client folder ${name}.`, "Edit Client Settings").then((choice: string | undefined) => {
          if (choice) void openClientConfig(client);
        });
      }
      onChange();
    });
    watcher.onDidDelete(() => onChange());
    rootWatchers.push(watcher);
  }
  context.subscriptions.push({ dispose: () => rootWatchers.forEach((w) => w.dispose()) });
}

/** Folders created while VS Code was closed get configured on startup. */
/**
 * Selects the configured storage mode without importing or moving local files.
 * Every initialized client's Lantern files are added to its repo's local exclude list.
 */
function setUpClientSettingsStore(context: vscode.ExtensionContext): void {
  const base = context.globalStorageUri.fsPath;
  const outside = settings().clientSettingsLocation !== "folder";
  useClientStore(outside ? path.join(base, "clients") : undefined, path.join(base, "ignored-folders.json"));
  for (const root of workspaceRoots()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of [root, ...entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name))]) {
      if (readClient(dir)) excludeLocally(dir);
    }
  }
}

function autoConfigureExisting(): void {
  if (settings().clientSettingsLocation !== "folder" || !settings().autoConfigureNewFolders) return;
  for (const dir of scanAll().unconfigured) {
    const root = workspaceRoots().find((r) => path.dirname(path.resolve(dir)) === path.resolve(r));
    // Project folders inside a repo opened directly aren't clients.
    if (!root || !shouldAutoConfigure(dir, root)) continue;
    try {
      ensureClientConfig(dir, {}, { jsconfig: settings().createJsconfig });
      write(`Configured client folder ${path.basename(dir)}\n`);
    } catch (err) {
      write(`Couldn't configure ${dir}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
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
    { label: "$(cloud-download) Pull from Dataverse", command: "pull", args: [client] },
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
