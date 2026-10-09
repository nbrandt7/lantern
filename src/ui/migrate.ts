import * as vscode from "vscode";

/** Settings carried over from when this extension was called Dataverse Workspace (prefix dataverseWorkspace.*). */
const KEYS = [
  "clientsFolder", "autoConfigureNewFolders", "authMethod", "publishAfterPush", "pushOnSave", "plugins.buildConfiguration",
  "pacPath", "dotnetPath", "azPath", "xrmDefinitelyTypedPath", "codeLens.enabled", "metadata.completions", "query.maxRows",
];
const LEGACY_SECTION = "dataverseWorkspace";
const LEGACY_EXTENSION = "local.dataverse-workspace";
const DONE = "lantern.migratedLegacySettings";

interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Copies user and workspace settings from the old dataverseWorkspace.* names to lantern.*,
 * once, without overwriting anything already set under the new names. Returns how many moved.
 */
export async function migrateLegacySettings(state: Memento | undefined): Promise<number> {
  if (!state || state.get<boolean>(DONE)) return 0;
  const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);
  const current = vscode.workspace.getConfiguration("lantern");
  let moved = 0;
  for (const key of KEYS) {
    const old = legacy.inspect<unknown>(key);
    const now = current.inspect<unknown>(key);
    if (old?.globalValue !== undefined && now?.globalValue === undefined) {
      await current.update(key, old.globalValue, vscode.ConfigurationTarget.Global);
      moved++;
    }
    if (old?.workspaceValue !== undefined && now?.workspaceValue === undefined) {
      await current.update(key, old.workspaceValue, vscode.ConfigurationTarget.Workspace);
      moved++;
    }
  }
  await state.update(DONE, true);
  return moved;
}

/** Points out the old extension if it's still installed, since both would run side by side. */
export async function noticeLegacyExtension(): Promise<void> {
  if (!vscode.extensions.getExtension(LEGACY_EXTENSION)) return;
  const choice = await vscode.window.showWarningMessage(
    "Lantern replaces Dataverse Workspace. Uninstall Dataverse Workspace so the two don't run side by side.",
    "Show Extension"
  );
  if (choice) await vscode.commands.executeCommand("workbench.extensions.search", "@installed Dataverse Workspace");
}
