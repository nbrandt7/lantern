import * as path from "path";
import * as vscode from "vscode";

const browserStylesExtension = "boylett.integrated-browser-extensions";

/** Register Lantern's bundled userscript with the browser injection extension once per VS Code profile. */
export async function configurePowerAutomateStyling(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.extensions.getExtension(browserStylesExtension)) {
    const install = "Install browser styling support";
    const choice = await vscode.window.showInformationMessage(
      "To apply Lantern's Power Automate dark style, install Integrated Browser Extensions and enable its proposed browser API. This setup is shared across clients and flows.",
      install
    );
    if (choice === install) {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", browserStylesExtension);
    }
    return;
  }

  const scriptsDirectory = path.join(context.extensionPath, "resources", "browser-styles");
  const config = vscode.workspace.getConfiguration("integratedBrowserExtensions");
  const existing = config.inspect<string[]>("extensionDirectory")?.globalValue ?? [];
  const previouslyRegistered = context.globalState.get<string>("powerAutomateStylesDirectory");
  const directories = existing.filter((entry) => !previouslyRegistered || path.resolve(entry) !== path.resolve(previouslyRegistered));
  if (!directories.some((entry) => path.resolve(entry) === path.resolve(scriptsDirectory))) {
    directories.push(scriptsDirectory);
  }

  if (directories.length !== existing.length || directories.some((entry, index) => entry !== existing[index])) {
    await config.update("extensionDirectory", directories, vscode.ConfigurationTarget.Global);
  }
  await context.globalState.update("powerAutomateStylesDirectory", scriptsDirectory);
}
