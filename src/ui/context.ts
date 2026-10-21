import * as path from "path";
import * as vscode from "vscode";
import { appSecret } from "./auth";
import { Client, FolderScan } from "../core/clients";
import { UserError } from "../core/errors";
import { isInside } from "../core/files";
import { PacContext } from "../core/pac";
import { Cancellation } from "../core/process";
import { activeTenant } from "./tenantContext";
import { appendLog, logEvent } from "../core/logger";

export const SECTION = "lantern";

export function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
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
    clientSettingsLocation: c.get<"global" | "folder" | "outside">("clientSettingsLocation", "global") === "folder" ? "folder" as const : "global" as const,
    createJsconfig: c.get<boolean>("createJsconfig", true),
    typescriptPushOnSave: c.get<boolean>("typescript.pushOnSave", true),
  };
}

let output: vscode.OutputChannel | undefined;
export function log(): vscode.OutputChannel {
  if (!output) output = vscode.window.createOutputChannel("Lantern");
  return output;
}
export const write = (text: string): void => {
  log().append(text);
  appendLog(text);
};

/** The folders currently open in VS Code. */
export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f: vscode.WorkspaceFolder) => f.uri.fsPath);
}

export function primaryRoot(): string | undefined {
  return workspaceRoots()[0];
}

export function scanAll(): FolderScan {
  const tenant = activeTenant();
  return { clients: tenant ? [tenant] : [], unconfigured: [] };
}

export function clientForPath(file: string): Client | undefined {
  const tenant = activeTenant();
  return tenant && isInside(file, tenant.dir) ? tenant : undefined;
}

/** The one tenant selected for this VS Code window. */
export async function resolveClient(_arg?: unknown): Promise<Client | undefined> {
  const tenant = activeTenant();
  if (!tenant) vscode.window.showWarningMessage('Select a tenant in Lantern before using this command.');
  return tenant;
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
  const started = Date.now();
  write(`\n=== ${title} (${new Date().toLocaleTimeString()}) ===\n`);
  try {
    const result = await vscode.window.withProgress(
      {
        // Quiet tasks (push on save) show in the status bar instead of a notification.
        location: options.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
        title,
        cancellable: !options.quiet,
      },
      (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) =>
        task({ pacPath: settings().pacPath, log: write, token, cancel: token, confirmProfileAccount, appSecret: (c: Client) => appSecret(c) }, progress)
    );
    logEvent(`Task completed: ${title} (${Date.now() - started} ms)`);
    return result;
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
