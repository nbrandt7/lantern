import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CheckerIssue, readCheckerOutput } from "../core/checker";
import { Client } from "../core/clients";
import { findFiles, toPosix } from "../core/files";
import { findWebResourceFile } from "../core/handlers";
import { ensureAuth, solutionCheck, solutionExport, solutionImport } from "../core/pac";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, reportError, resolveClient, withProgress } from "../ui/context";
import { TableDocProvider } from "./metadata";

type SolutionArg = { client: Client; unique: string; folder?: string };

export function registerSolutionOps(docs: TableDocProvider, checker: vscode.DiagnosticCollection): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });

  return [
    r("lantern.solutions.export", async (node: SolutionArg) => {
      const managed = await pickManaged();
      if (managed === undefined) return;
      const version = await solutionVersion(node.client, node.unique);
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(node.client.dir, "exports", `${[node.unique, version?.replace(/\./g, "_"), managed ? "managed" : ""].filter(Boolean).join("_")}.zip`)),
        filters: { "Solution zip": ["zip"] },
      });
      if (!target) return;
      fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
      const ok = await withProgress(`Exporting ${node.unique} from ${label(node.client)}`, async (ctx) => {
        await ensureAuth(ctx, node.client);
        await solutionExport(ctx, node.client, node.unique, target.fsPath, managed);
        return true;
      });
      if (!ok) return;
      const choice = await vscode.window.showInformationMessage(`Exported ${node.unique} ${version ?? ""} (${managed ? "managed" : "unmanaged"}).`, "Show in Folder");
      if (choice) await vscode.commands.executeCommand("revealFileInOS", target);
    }),

    r("lantern.solutions.import", async (arg?: unknown) => {
      const client = (arg as SolutionArg | undefined)?.client ?? (await resolveClient(arg));
      if (!client?.config.org) return;
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: vscode.Uri.file(path.join(client.dir, "exports")),
        filters: { "Solution zip": ["zip"] },
        openLabel: "Import",
      });
      if (!picked?.[0]) return;
      const target = await pickEnvironment(client, "Import into which environment?");
      if (!target) return;
      await importZip(target, picked[0].fsPath);
    }),

    r("lantern.solutions.copyTo", async (node: SolutionArg) => {
      const others = node.client.environments.filter((e) => e.name !== node.client.envName);
      if (!others.length) {
        void vscode.window.showInformationMessage(`${node.client.name} has no other environment to copy to. Add one from the client's Environments menu.`);
        return;
      }
      const managed = await pickManaged("Most deployments to TEST and PROD use managed.");
      if (managed === undefined) return;
      const to = await vscode.window.showQuickPick(others.map((e) => ({ label: e.name, description: e.org })), { placeHolder: `Copy ${node.unique} from ${node.client.envName} to…` });
      if (!to) return;
      const target = node.client.withEnvironment(to.label);
      if (!(await confirmProtected(target, `Import ${node.unique}`))) return;
      const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lantern-copy-")), `${node.unique}${managed ? "_managed" : ""}.zip`);
      const ok = await withProgress(`Copying ${node.unique}: ${node.client.envName} to ${target.envName}`, async (ctx, progress) => {
        progress.report({ message: `exporting from ${node.client.envName}...` });
        await ensureAuth(ctx, node.client);
        await solutionExport(ctx, node.client, node.unique, zip, managed);
        progress.report({ message: `importing into ${target.envName}...` });
        await ensureAuth(ctx, target);
        await solutionImport(ctx, target, zip);
        return true;
      });
      fs.rmSync(path.dirname(zip), { recursive: true, force: true });
      if (ok) void vscode.window.showInformationMessage(`Copied ${node.unique} (${managed ? "managed" : "unmanaged"}) from ${node.client.envName} to ${target.envName}.`);
    }),

    r("lantern.solutions.bumpVersion", async (node: SolutionArg) => {
      const dv = dataverseFor(node.client);
      const rows = await withProgress(`Reading ${node.unique}'s version`, () =>
        dv.getAll<{ solutionid: string; version: string }>(`solutions?$select=solutionid,version&$filter=uniquename eq '${node.unique.replace(/'/g, "''")}'`)
      );
      const row = rows?.[0];
      if (!row) return;
      const [a = 1, b = 0, c = 0, d = 0] = row.version.split(".").map((n) => Number(n) || 0);
      const options = [
        { label: `${a}.${b}.${c}.${d + 1}`, description: "revision" },
        { label: `${a}.${b}.${c + 1}.0`, description: "build" },
        { label: `${a}.${b + 1}.0.0`, description: "minor" },
        { label: `${a + 1}.0.0.0`, description: "major" },
        { label: "Other…", description: "type a version" },
      ];
      const pick = await vscode.window.showQuickPick(options, { placeHolder: `${node.unique} is ${row.version}. New version:` });
      if (!pick) return;
      const version =
        pick.label === "Other…"
          ? await vscode.window.showInputBox({ prompt: "New version", value: row.version, validateInput: (v: string) => (/^\d+(\.\d+){1,3}$/.test(v.trim()) ? undefined : "Use numbers like 1.2.3.4.") })
          : pick.label;
      if (!version || !(await confirmProtected(node.client, `Change ${node.unique}'s version`))) return;
      await withProgress(`Setting ${node.unique} to ${version}`, async () => {
        await dv.update(`solutions(${row.solutionid})`, { version: version.trim() });
        return true;
      });
      vscode.window.setStatusBarMessage(`$(tag) ${node.unique} is now ${version}`, 5000);
    }),

    r("lantern.solutions.check", async (node: SolutionArg) => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-check-"));
      const zip = path.join(work, `${node.unique}.zip`);
      const out = path.join(work, "results");
      const issues = await withProgress(`Running the solution checker on ${node.unique} (this takes a few minutes)`, async (ctx, progress) => {
        progress.report({ message: "exporting..." });
        await ensureAuth(ctx, node.client);
        await solutionExport(ctx, node.client, node.unique, zip, false);
        progress.report({ message: "checking..." });
        fs.mkdirSync(out, { recursive: true });
        await solutionCheck(ctx, zip, out);
        return readCheckerOutput(out);
      });
      if (issues === undefined) {
        fs.rmSync(work, { recursive: true, force: true });
        return;
      }
      showCheckerProblems(node, issues, checker);
      const uri = vscode.Uri.from({ scheme: TableDocProvider.scheme, path: `/${node.client.name}/checker-${node.unique}.md` });
      docs.set(uri, checkerMarkdown(node, issues));
      fs.rmSync(work, { recursive: true, force: true });
      try {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
      } catch {
        await vscode.window.showTextDocument(uri, { preview: true });
      }
    }),
  ];
}

const label = (c: Client) => (c.envName ? `${c.envName} (${c.orgHost})` : c.orgHost);

async function pickManaged(note?: string): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Unmanaged", description: "editable; for moving work between dev environments or source control", managed: false },
      { label: "Managed", description: "locked; for TEST, UAT, and PROD", managed: true },
    ],
    { placeHolder: note ? `Export as… ${note}` : "Export as…" }
  );
  return pick?.managed;
}

async function solutionVersion(client: Client, unique: string): Promise<string | undefined> {
  const rows = await dataverseFor(client)
    .getAll<{ version: string }>(`solutions?$select=version&$filter=uniquename eq '${unique.replace(/'/g, "''")}'`)
    .catch(() => []);
  return rows[0]?.version;
}

async function pickEnvironment(client: Client, placeHolder: string): Promise<Client | undefined> {
  if (!client.environments.length) return client;
  const pick = await vscode.window.showQuickPick(
    client.environments.map((e) => ({ label: e.name, description: [e.org, e.protected ? "protected" : "", e.name === client.envName ? "current" : ""].filter(Boolean).join(", ") })),
    { placeHolder }
  );
  return pick ? client.withEnvironment(pick.label) : undefined;
}

async function importZip(target: Client, zip: string): Promise<void> {
  if (!(await confirmProtected(target, `Import ${path.basename(zip)}`))) return;
  const ok = await withProgress(`Importing ${path.basename(zip)} into ${label(target)}`, async (ctx) => {
    await ensureAuth(ctx, target);
    await solutionImport(ctx, target, zip);
    return true;
  });
  if (ok) void vscode.window.showInformationMessage(`Imported ${path.basename(zip)} into ${label(target)} and published.`);
}

/** Puts checker issues on the matching files in the Problems panel (web resources, mostly). */
function showCheckerProblems(node: SolutionArg, issues: CheckerIssue[], checker: vscode.DiagnosticCollection): void {
  checker.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const local = node.folder ? findFiles(node.folder, () => true) : [];
  for (const issue of issues) {
    if (!issue.artifact) continue;
    const want = issue.artifact.toLowerCase();
    const file =
      local.find((f) => toPosix(f).toLowerCase().endsWith(`/${want}`)) ??
      findWebResourceFile(node.client, issue.artifact.replace(/^WebResources\//i, ""));
    if (!file) continue;
    const line = Math.max(0, (issue.line ?? 1) - 1);
    const d = new vscode.Diagnostic(
      new vscode.Range(line, 0, line, 1000),
      `${issue.message || issue.description} (${issue.rule})`,
      issue.level === "error" ? vscode.DiagnosticSeverity.Error : issue.level === "note" ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning
    );
    d.source = "Solution checker";
    byFile.set(file, [...(byFile.get(file) ?? []), d]);
  }
  for (const [file, list] of byFile) checker.set(vscode.Uri.file(file), list);
}

export function checkerMarkdown(node: { client: Client; unique: string }, issues: CheckerIssue[]): string {
  const lines = [`# Solution checker: ${node.unique}`, "", `${node.client.envName ? `${node.client.envName}, ` : ""}${node.client.orgHost}. ${issues.length} issue${issues.length === 1 ? "" : "s"}.`, ""];
  if (!issues.length) return lines.concat("Nothing to fix.", "").join("\n");
  for (const level of ["error", "warning", "note"] as const) {
    const list = issues.filter((i) => i.level === level);
    if (!list.length) continue;
    lines.push(`## ${level === "error" ? "Errors" : level === "warning" ? "Warnings" : "Notes"} (${list.length})`, "", "| Rule | Where | Message |", "|---|---|---|");
    for (const i of list) {
      const rule = i.helpUri ? `[${i.rule}](${i.helpUri})` : i.rule;
      lines.push(`| ${rule} | ${(i.artifact ?? "").replace(/\|/g, "\\|")}${i.line ? `:${i.line}` : ""} | ${(i.message || i.description).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`);
    }
    lines.push("");
  }
  lines.push("Issues in files you've pulled also appear in the Problems panel.", "");
  return lines.join("\n");
}
