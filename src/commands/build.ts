import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client, toList } from "../core/clients";
import { ensureAuth, modelBuilder } from "../core/pac";
import { findPluginProjects } from "../core/solutions";
import { findXdtExe, generateFormTypes } from "../core/xdt";
import { resolveClient, settings, withProgress, workspaceRoots } from "../ui/context";

export async function generateJsTypes(arg: unknown, onDone: () => void): Promise<void> {
  const client = await resolveClient(arg);
  if (!client) return;
  const exe = findXdtExe(settings().xrmDefinitelyTypedPath, workspaceRoots());
  if (!exe) {
    const choice = await vscode.window.showWarningMessage(
      "XrmDefinitelyTyped.exe wasn't found. Download the Delegate.XrmDefinitelyTyped NuGet package, extract it into tools/xdt in your workspace, or set lantern.xrmDefinitelyTypedPath.",
      "Open NuGet page"
    );
    if (choice) await vscode.env.openExternal(vscode.Uri.parse("https://www.nuget.org/packages/Delegate.XrmDefinitelyTyped"));
    return;
  }
  const ok = await withProgress(`Generating form types for ${client.name}`, async (ctx) => {
    await generateFormTypes(client, exe, ctx.log, ctx.token);
    return true;
  });
  onDone();
  if (ok) void vscode.window.showInformationMessage(`${client.name} now uses org-specific form types. Use "New Form Script" to start a typed script.`);
}

/** C# early-bound classes via pac modelbuilder. Prompts for missing settings and saves them. */
export async function generateEarlyBound(arg: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client) return;
  const eb = client.config.earlyBound;

  if (!eb.outDir) {
    const projects = findPluginProjects(client.dir);
    const suggestion = projects[0] ? path.join(path.relative(client.dir, path.dirname(projects[0].project)), "Model") : "Model";
    const outDir = await vscode.window.showInputBox({
      title: "Early-bound classes: output folder",
      prompt: `Folder for the generated .cs files, relative to ${client.name}/`,
      value: suggestion,
      ignoreFocusOut: true,
    });
    if (!outDir) return;
    eb.outDir = outDir;
  }
  const outDir = path.resolve(client.dir, eb.outDir);
  const settingsFile = path.join(outDir, "builderSettings.json");
  const useSettingsFile = fs.existsSync(settingsFile);

  if (!useSettingsFile && !eb.entities.length) {
    const tables = await vscode.window.showInputBox({
      title: "Early-bound classes: tables",
      prompt: "Table logical names, comma-separated. Generating every table makes a huge, slow model.",
      placeHolder: "account, contact, acme_project",
      ignoreFocusOut: true,
    });
    if (!tables) return;
    eb.entities = toList(tables);
    if (!eb.namespace) {
      const ns = await vscode.window.showInputBox({ title: "Early-bound classes: namespace", value: `${client.name.replace(/[^a-zA-Z0-9]/g, "")}.Model` });
      if (ns === undefined) return;
      eb.namespace = ns;
    }
  }
  client.save();

  const args = ["--outdirectory", outDir];
  if (useSettingsFile) args.push("--settingsTemplateFile", settingsFile);
  else {
    if (eb.namespace) args.push("--namespace", eb.namespace);
    args.push("--entitynamesfilter", eb.entities.join(";"));
  }

  const ok = await withProgress(`Generating early-bound classes for ${client.name}`, async (ctx) => {
    fs.mkdirSync(outDir, { recursive: true });
    await ensureAuth(ctx, client); // modelbuilder uses the active auth profile
    await modelBuilder(ctx, args);
    return true;
  });
  if (ok) void vscode.window.showInformationMessage(`Early-bound classes generated in ${path.relative(client.dir, outDir)}.`);
}
