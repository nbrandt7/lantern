import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client, isClientFolderName, normalizeOrg, slugify, writeJsconfig } from "../core/clients";
import { UserError } from "../core/errors";
import { findFiles, isInside, writeJson } from "../core/files";
import { connectRepo, repoNameFromUrl } from "../core/git";
import { run } from "../core/process";
import { primaryRoot, resolveClient, settings, withProgress, workspaceRoots, write } from "../ui/context";
import { activeTenant, addTenant, tenantConfigFile, tenantMode } from "../ui/tenantContext";
import { openEnvironmentUrl } from "../ui/environmentBrowser";

/** Sets up the parent folder: package.json with @types/xrm, a .gitignore that keeps client clones out. */
export async function initWorkspace(): Promise<void> {
  const root = primaryRoot();
  if (!root) {
    void vscode.window.showWarningMessage("Open a project folder first.");
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
    void vscode.window.showWarningMessage("Open a project folder first.");
    return;
  }
  const title = "New Dataverse tenant folder";

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
      if (fs.existsSync(path.join(root, s)) && !repoUrl) return `${s} already exists. Use "Configure as Tenant" on it instead.`;
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
    if (settings().createJsconfig && !fs.existsSync(path.join(dir, "jsconfig.json"))) writeJsconfig(dir, "generic");
    const c = addTenant(slugify(name), {
      folder: tenantMode() === "folder" ? path.relative(root, dir) : dir,
      org: normalizeOrg(org),
      solutions: solutions.split(",").map((s: string) => s.trim()).filter(Boolean),
    }, root);
    progress.report({ message: "restoring .NET packages..." });
    await restoreDotnet(c, ctx.log);
    return c;
  });
  if (!client) return;
  onDone();

  const choice = await vscode.window.showInformationMessage(`${client.name} is ready.`, "Edit Tenant Configuration");
  if (choice === "Edit Tenant Configuration") await openClientConfig(client);
}

export async function configureFolder(arg: unknown, onDone: () => void): Promise<void> {
  const dir = (arg as { dir?: string })?.dir ?? (arg as vscode.Uri)?.fsPath;
  if (!dir) return;
  const root = workspaceRoots().find((folder) => isInside(dir, folder));
  if (!root) throw new UserError("Open the project in a workspace folder first.");
  if (settings().createJsconfig && !fs.existsSync(path.join(dir, "jsconfig.json"))) writeJsconfig(dir, "generic");
  const client = addTenant(path.basename(dir), { folder: tenantMode() === "folder" ? path.relative(root, dir) || "." : dir }, root);
  await restoreDotnet(client, write);
  onDone();
  void vscode.window.showInformationMessage(`${client.name} is configured. Add its org URL in the tenant configuration to connect it.`);
}

export async function openClientConfig(arg?: unknown): Promise<void> {
  const file = activeTenant()?.configFile ?? tenantConfigFile();
  if (!file || !fs.existsSync(file)) {
    void vscode.window.showInformationMessage("No tenant configuration exists yet. Use Lantern: Add Tenant to create one.");
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

export async function openInBrowser(arg?: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client?.config.org) return;
  await openEnvironmentUrl(client, `${client.config.org}/main.aspx`);
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
