import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client, ensureClientConfig, isClientFolderName, normalizeOrg, slugify } from "../core/clients";
import { UserError } from "../core/errors";
import { findFiles, writeJson } from "../core/files";
import { connectRepo, repoNameFromUrl } from "../core/git";
import { run } from "../core/process";
import { primaryRoot, resolveClient, settings, withProgress, write } from "../ui/context";

/** Sets up the parent folder: package.json with @types/xrm, a .gitignore that keeps client clones out. */
export async function initWorkspace(): Promise<void> {
  const root = primaryRoot();
  if (!root) {
    void vscode.window.showWarningMessage("Open the folder that will hold your client folders first.");
    return;
  }
  await withProgress("Initializing Dataverse workspace", async (ctx) => {
    const pkg = path.join(root, "package.json");
    if (!fs.existsSync(pkg)) {
      writeJson(pkg, { name: "lantern-workspace", private: true, devDependencies: { "@types/xrm": "^9.0.0" } });
    }
    const gitignore = path.join(root, ".gitignore");
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(
        gitignore,
        "# Client folders are their own repos (or local-only) and never belong here.\n/*/\n!/.vscode/\n"
      );
    }
    fs.mkdirSync(path.join(root, "tools", "xdt"), { recursive: true });
    ctx.log("> npm install\n");
    const r = await run("npm", ["install"], { cwd: root, onOutput: ctx.log, token: ctx.token });
    if (r.missing) throw new UserError("npm isn't installed. Install Node.js, then run this again.");
    if (r.code !== 0) throw new UserError("npm install failed. See the Lantern output panel.");
  });
  void vscode.window.showInformationMessage("Workspace ready. @types/xrm is installed for JavaScript IntelliSense.");
}

/** Multi-step: name, optional ADO repo, optional org + solutions. */
export async function newClient(onDone: () => void): Promise<void> {
  const root = primaryRoot();
  if (!root) {
    void vscode.window.showWarningMessage("Open the folder that will hold your client folders first.");
    return;
  }
  const title = "New Dataverse client";

  const repoUrl = await vscode.window.showInputBox({
    title: `${title} (1/4)`,
    prompt: "ADO repo clone URL. Leave blank for a local-only folder.",
    placeHolder: "https://dev.azure.com/org/project/_git/Repo",
    ignoreFocusOut: true,
  });
  if (repoUrl === undefined) return;

  const suggested = repoUrl ? slugify(repoNameFromUrl(repoUrl)) : "";
  const name = await vscode.window.showInputBox({
    title: `${title} (2/4)`,
    prompt: "Folder name",
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (v: string) => {
      const s = slugify(v);
      if (!s) return "Enter a name.";
      if (!isClientFolderName(s)) return `"${s}" is reserved.`;
      if (fs.existsSync(path.join(root, s)) && !repoUrl) return `${s} already exists. Use "Configure as Client" on it instead.`;
      return undefined;
    },
  });
  if (!name) return;

  const org = await vscode.window.showInputBox({
    title: `${title} (3/4)`,
    prompt: "Dataverse org URL. Optional; you can add it to .lantern/config.json later.",
    placeHolder: "https://contoso.crm.dynamics.com",
    ignoreFocusOut: true,
  });
  if (org === undefined) return;

  const solutions = org
    ? await vscode.window.showInputBox({
        title: `${title} (4/4)`,
        prompt: "Solution unique name(s), comma-separated. Optional.",
        placeHolder: "ContosoCore, ContosoPlugins",
        ignoreFocusOut: true,
      })
    : "";
  if (solutions === undefined) return;

  const dir = path.join(root, slugify(name));
  const client = await withProgress(`Setting up ${slugify(name)}`, async (ctx, progress) => {
    if (repoUrl.trim()) {
      progress.report({ message: "connecting the repo..." });
      await connectRepo(dir, repoUrl.trim(), ctx.log);
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
    const c = ensureClientConfig(dir, { org: normalizeOrg(org), solutions: solutions.split(",").map((s: string) => s.trim()).filter(Boolean) }, { jsconfig: settings().createJsconfig });
    progress.report({ message: "restoring .NET packages..." });
    await restoreDotnet(c, ctx.log);
    return c;
  });
  onDone();
  if (!client) return;

  const actions = client.config.org && client.config.solutions.length ? ["Pull from Dataverse", "Open .lantern/config.json"] : ["Open .lantern/config.json"];
  const choice = await vscode.window.showInformationMessage(`${client.name} is ready.`, ...actions);
  if (choice === "Pull from Dataverse") await vscode.commands.executeCommand("lantern.pull", client);
  if (choice === "Open .lantern/config.json") await openClientConfig(client);
}

export async function configureFolder(arg: unknown, onDone: () => void): Promise<void> {
  const dir = (arg as { dir?: string })?.dir ?? (arg as vscode.Uri)?.fsPath;
  if (!dir) return;
  const client = ensureClientConfig(dir, {}, { jsconfig: settings().createJsconfig });
  await restoreDotnet(client, write);
  onDone();
  void vscode.window.showInformationMessage(`${client.name} is configured. Add the org URL to .lantern/config.json to connect it.`);
}

export async function openClientConfig(arg?: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client) return;
  await vscode.window.showTextDocument(vscode.Uri.file(client.configFile));
}

export async function openInBrowser(arg?: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client?.config.org) return;
  await vscode.env.openExternal(vscode.Uri.parse(`${client.config.org}/main.aspx`));
}

/** Restores NuGet packages for any C# solutions so C# Dev Kit has IntelliSense right away. Non-fatal. */
export async function restoreDotnet(client: Client, log: (text: string) => void): Promise<void> {
  const slns = findFiles(client.dir, (n) => /\.slnx?$/i.test(n));
  for (const sln of slns) {
    log(`> dotnet restore ${path.relative(client.dir, sln)}\n`);
    const r = await run(settings().dotnetPath, ["restore", sln], { onOutput: log });
    if (r.missing) {
      log("The .NET SDK isn't installed, so C# restore was skipped.\n");
      return;
    }
    if (r.code !== 0) log("Restore failed. Older packages.config projects need \"nuget restore\" or Visual Studio.\n");
  }
}
