import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
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
