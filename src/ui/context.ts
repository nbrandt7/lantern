import * as path from "path";
import * as vscode from "vscode";
import { appSecret } from "./auth";
import { Client, readClient, scanClients, FolderScan } from "../core/clients";
import { UserError } from "../core/errors";
import { findUp, isInside } from "../core/files";
import { PacContext } from "../core/pac";
import { Cancellation } from "../core/process";

export const SECTION = "lantern";

export function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    clientsFolder: c.get<string>("clientsFolder", ""),
    autoConfigureNewFolders: c.get<boolean>("autoConfigureNewFolders", true),
    authMethod: c.get<"vscode" | "azureCli">("authMethod", "vscode"),
    publishAfterPush: c.get<boolean>("publishAfterPush", true),
    pushOnSave: c.get<boolean>("pushOnSave", false),
    buildConfiguration: c.get<string>("plugins.buildConfiguration", "Release"),
    pacPath: c.get<string>("pacPath", "pac") || "pac",
    dotnetPath: c.get<string>("dotnetPath", "dotnet") || "dotnet",
    ilspyPath: c.get<string>("ilspyPath", ""),
    azPath: c.get<string>("azPath", "az") || "az",
    xrmDefinitelyTypedPath: c.get<string>("xrmDefinitelyTypedPath", ""),
    codeLens: c.get<boolean>("codeLens.enabled", true),
    metadataCompletions: c.get<boolean>("metadata.completions", true),
    queryMaxRows: Math.max(1, c.get<number>("query.maxRows", 5000)),
    diagnostics: c.get<boolean>("diagnostics.enabled", true),
    clientSettingsLocation: c.get<"outside" | "folder">("clientSettingsLocation", "outside"),
    createJsconfig: c.get<boolean>("createJsconfig", true),
    typescriptPushOnSave: c.get<boolean>("typescript.pushOnSave", true),
  };
}

let output: vscode.OutputChannel | undefined;
export function log(): vscode.OutputChannel {
  if (!output) output = vscode.window.createOutputChannel("Lantern");
  return output;
}
export const write = (text: string): void => log().append(text);

/**
 * The folder that holds client folders: the configured clientsFolder, else the
 * first workspace folder. A workspace folder that is itself a client also works.
 */
export function workspaceRoots(): string[] {
  const configured = settings().clientsFolder;
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f: vscode.WorkspaceFolder) => f.uri.fsPath);
  if (configured) {
    const resolved = path.isAbsolute(configured) ? configured : folders[0] ? path.join(folders[0], configured) : configured;
    return [resolved];
  }
  return folders;
}

export function primaryRoot(): string | undefined {
  return workspaceRoots()[0];
}

export function scanAll(): FolderScan {
  const result: FolderScan = { clients: [], unconfigured: [] };
  for (const root of workspaceRoots()) {
    const scan = scanClients(root);
    result.clients.push(...scan.clients);
    result.unconfigured.push(...scan.unconfigured);
  }
  return result;
}

export function clientForPath(file: string): Client | undefined {
  for (const root of workspaceRoots()) {
    if (!isInside(file, root)) continue;
    const dir = findUp(file, (d) => !!readClient(d), root);
    if (dir) return readClient(dir);
  }
  return undefined;
}

/** Client from a tree node, a file URI, the active editor, or a quick pick, in that order. */
export async function resolveClient(arg?: unknown): Promise<Client | undefined> {
  const fromArg = clientFromArg(arg);
  if (fromArg) return fromArg;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    const c = clientForPath(active.fsPath);
    if (c) return c;
  }
  const { clients } = scanAll();
  if (clients.length === 1) return clients[0];
  if (!clients.length) {
    vscode.window.showWarningMessage('No client folders yet. Run "Dataverse: New Client" first.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    clients.map((c) => ({ label: c.name, description: c.orgHost, client: c })),
    { placeHolder: "Which client?" }
  );
  return pick?.client;
}

function clientFromArg(arg: unknown): Client | undefined {
  if (!arg) return undefined;
  if (arg instanceof Client) return arg;
  const a = arg as { client?: Client; fsPath?: string; resourceUri?: vscode.Uri };
  if (a.client instanceof Client) return a.client;
  if (typeof a.fsPath === "string") return clientForPath(a.fsPath);
  if (a.resourceUri?.fsPath) return clientForPath(a.resourceUri.fsPath);
  return undefined;
}

/**
 * Runs a task with a progress notification and the output channel. UserErrors show
 * as plain messages; anything else also points to the output panel.
 */
export async function withProgress<T>(
  title: string,
  task: (ctx: PacContext & { cancel: Cancellation }, progress: vscode.Progress<{ message?: string }>) => Promise<T>,
  options: { quiet?: boolean } = {}
): Promise<T | undefined> {
  write(`\n=== ${title} (${new Date().toLocaleTimeString()}) ===\n`);
  try {
    return await vscode.window.withProgress(
      {
        // Quiet tasks (push on save) show in the status bar instead of a notification.
        location: options.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
        title,
        cancellable: !options.quiet,
      },
      (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) =>
        task({ pacPath: settings().pacPath, log: write, token, cancel: token, confirmProfileAccount, appSecret: (c: Client) => appSecret(c) }, progress)
    );
  } catch (err) {
    reportError(err);
    return undefined;
  }
}

/**
 * Extra confirmation before changing anything in a protected environment (PROD, say).
 * Returns true straight away for unprotected environments.
 */
export async function confirmProtected(client: Client, action: string): Promise<boolean> {
  if (!client.isProtected) return true;
  const button = `${action} in ${client.envName}`;
  const choice = await vscode.window.showWarningMessage(
    `${client.name} is on ${client.envName} (${client.orgHost}), a protected environment. ${action} there?`,
    { modal: true },
    button
  );
  return choice === button;
}

/** pac profile signed in as the wrong account: ask before deleting and recreating it. */
async function confirmProfileAccount(profile: string, current: string, wanted: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `The pac profile "${profile}" is signed in as ${current}, but this client uses ${wanted}. Recreate it and sign in as ${wanted}?`,
    { modal: true },
    "Recreate Profile"
  );
  return choice === "Recreate Profile";
}

export function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  write(`ERROR: ${err instanceof Error && !(err instanceof UserError) ? err.stack : message}\n`);
  void vscode.window.showErrorMessage(message, "Show Output").then((choice: string | undefined) => {
    if (choice) log().show(true);
  });
}
