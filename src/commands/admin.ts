import * as fs from "fs";
import * as vscode from "vscode";
import { findType, projectSourceFiles } from "../core/csharp";
import { findPluginProjects } from "../core/solutions";
import { auditHistory, fetchOrgSolutions, fetchUsers, formatJob, inspectRecord, parseRecordRef, publishAll, setEnvVar, setStepEnabled } from "../core/admin";
import { findWebResourceFile } from "../core/handlers";
import { DataverseContentProvider } from "./webResources";
import { Client } from "../core/clients";
import { CODE_FORMATS, generate } from "../core/codegen";
import { findFiles } from "../core/files";
import { MetadataService, TableMeta } from "../core/metadata";
import { ResultSet } from "../core/query";
import { splitStatements } from "../core/sql";
import { APP_REGISTRATION, chooseAccount, dataverseFor, forgetSignIn, getToken, storeAppSecret } from "../ui/auth";
import { ensureAuth } from "../core/pac";
import { confirmProtected, reportError, resolveClient, withProgress } from "../ui/context";
import { CellContext, ResultsView } from "../ui/results";
import { TraceDocProvider } from "../ui/traceTree";
import { LocalNode, WorkspaceTree } from "../ui/workspaceTree";
import { pickTable } from "./metadata";
import { clientForQuery, isFetchXml, runQueryCommand } from "./query";

type StepNode = Extract<LocalNode, { kind: "step" }>;
type JobNode = Extract<LocalNode, { kind: "job" }>;
type EnvVarNode = Extract<LocalNode, { kind: "envvar" }>;
type SolutionNode = Extract<LocalNode, { kind: "solution" }>;
type WebResourceNode = Extract<LocalNode, { kind: "webResource" }>;

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function registerAdminCommands(
  tree: WorkspaceTree,
  serviceFor: (c: Client) => MetadataService,
  results: ResultsView,
  docs: TraceDocProvider,
  remote: DataverseContentProvider
): vscode.Disposable[] {
  // Errors from any of these commands show as a message (with the details in the output panel).
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });

  /** Shows one record as a column-by-column grid. */
  const showRecord = async (client: Client, table: TableMeta, id: string): Promise<void> => {
    const set = await withProgress(`Loading ${table.logicalName} ${id}`, async () =>
      inspectRecord(dataverseFor(client), table, await serviceFor(client).columns(table.logicalName), id)
    );
    if (set) await results.show(`${table.displayName} record (${client.name})`, client, { sets: [set], errors: [] });
  };

  /** From what someone typed or pasted: a URL, "table:GUID", or a GUID. */
  const inspect = async (client: Client, input: string): Promise<void> => {
    const target = await resolveRecord(client, input, serviceFor(client));
    if (target) await showRecord(client, target.table, target.id);
  };

  const audit = async (client: Client, table: string, id: string, column?: string): Promise<void> => {
    const set = await withProgress(`Loading audit history`, () => auditHistory(dataverseFor(client), table, id, column));
    if (!set) return;
    if (!set.rows.length) {
      void vscode.window.showInformationMessage(
        `No audit history for this ${column ? "column" : "record"}. Auditing may be off for the org, the ${table} table${column ? ", or this column" : ""}.`
      );
      return;
    }
    await results.show(`Audit history (${client.name})`, client, { sets: [set], errors: [] });
  };

  return [
    r("lantern.refreshNode", (node?: Parameters<WorkspaceTree["refresh"]>[0]) => tree.refresh(node)),
    r("lantern.copyText", async (text: string) => {
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`$(copy) Copied ${text.length > 60 ? text.slice(0, 57) + "..." : text}`, 3000);
    }),

    // ---------- solutions ----------
    r("lantern.solutions.add", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org) return;
      const all = await withProgress(`Loading solutions from ${client.orgHost}`, () => fetchOrgSolutions(dataverseFor(client)));
      if (!all) return;
      const listed = new Set(client.config.solutions.map((s) => s.toLowerCase()));
      const available = all.filter((s) => !listed.has(s.uniqueName.toLowerCase()));
      if (!available.length) {
        void vscode.window.showInformationMessage(`Every solution in ${client.orgHost} is already added.`);
        return;
      }
      const picks = await vscode.window.showQuickPick(
        available.map((s) => ({
          label: s.friendlyName,
          description: s.uniqueName,
          detail: [
            s.managed ? "Managed (read-only)" : "Unmanaged",
            s.publisher,
            s.version && `version ${s.version}`,
            s.uniqueName === "Default" ? "contains every customization in the org, so it's slow to pull" : "",
          ].filter(Boolean).join(", "),
          solution: s,
        })),
        { canPickMany: true, placeHolder: "Add which solutions? (type to filter, space to select)", matchOnDescription: true, matchOnDetail: true }
      );
      if (!picks?.length) return;
      client.reload();
      for (const p of picks) client.config.solutions.push(p.solution.uniqueName);
      client.save();
      tree.refresh();
      const names = picks.map((p: { solution: { uniqueName: string } }) => p.solution.uniqueName).join(", ");
      const choice = await vscode.window.showInformationMessage(`Added ${names} to ${client.name}.`, "Pull Now");
      if (choice) await vscode.commands.executeCommand("lantern.pull", client);
    }),
    r("lantern.solutions.addLocal", (node: SolutionNode) => {
      node.client.reload();
      if (!node.client.config.solutions.some((s) => s.toLowerCase() === node.unique.toLowerCase())) node.client.config.solutions.push(node.unique);
      node.client.save();
      tree.refresh();
    }),
    r("lantern.solutions.remove", async (node: SolutionNode) => {
      const keep = node.folder ? " Its unpacked folder stays where it is." : "";
      const ok = await vscode.window.showWarningMessage(
        `Remove ${node.unique} from ${node.client.name}? Pull will stop syncing it.${keep}`,
        { modal: true },
        "Remove"
      );
      if (ok !== "Remove") return;
      node.client.reload();
      node.client.config.solutions = node.client.config.solutions.filter((s) => s.toLowerCase() !== node.unique.toLowerCase());
      node.client.save();
      tree.refresh();
    }),
    r("lantern.solutions.reveal", async (node: SolutionNode) => {
      if (node.folder) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(node.folder));
    }),
    r("lantern.webResources.open", async (node: WebResourceNode) => {
      const local = findWebResourceFile(node.client, node.resource.name);
      if (local) {
        await vscode.window.showTextDocument(vscode.Uri.file(local), { preview: true });
        return;
      }
      const wr = await withProgress(`Fetching ${node.resource.name}`, () => dataverseFor(node.client).findWebResource(node.resource.name));
      if (!wr) return;
      const name = /\.[a-z]+$/i.test(wr.name) ? wr.name : `${wr.name}.js`;
      const uri = vscode.Uri.from({ scheme: DataverseContentProvider.scheme, path: `/${node.client.name}/${name}` });
      remote.set(uri, Buffer.from(wr.content, "base64").toString("utf8"));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      vscode.window.setStatusBarMessage(`$(cloud) ${wr.name} is the Dataverse copy (read-only). Pull ${node.unique} to edit it locally.`, 6000);
    }),

    // ---------- accounts ----------
    r("lantern.signInAs", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org) return;
      const choice = await chooseAccount(client);
      if (choice === undefined) return;
      if (choice === APP_REGISTRATION) {
        await useAppRegistration(client, tree);
        return;
      }
      client.reload();
      client.config.account = choice ?? "";
      client.config.appId = "";
      client.save();
      forgetSignIn(client);
      tree.refresh();
      if (!choice) {
        void vscode.window.showInformationMessage(`${client.name} no longer pins an account; it uses whichever account VS Code picks.`);
        return;
      }
      const ok = await withProgress(`Signing in to ${client.orgHost} as ${choice}`, async (ctx) => {
        await getToken(client);
        try {
          await ensureAuth(ctx, client); // bring the pac profile in line too
        } catch (err) {
          if (!/isn't on your PATH/.test(err instanceof Error ? err.message : "")) throw err;
        }
        return true;
      });
      tree.refresh();
      if (ok) void vscode.window.showInformationMessage(`${client.name} now signs in as ${choice}.`);
    }),

    // ---------- publish ----------
    r("lantern.publishAll", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org || !(await confirmProtected(client, "Publish all customizations"))) return;
      const ok = await withProgress(`Publishing all customizations in ${client.orgHost}`, async () => {
        await publishAll(dataverseFor(client));
        return true;
      });
      if (ok) void vscode.window.showInformationMessage(`Published all customizations in ${client.orgHost}.`);
    }),

    // ---------- plug-in steps ----------
    r("lantern.steps.disable", (node: StepNode) => toggleStep(tree, node, false)),
    r("lantern.steps.enable", (node: StepNode) => toggleStep(tree, node, true)),
    r("lantern.steps.openCode", (node: StepNode) => openPluginClass(node.client, node.step.typeName, node.step.assembly)),
    r("lantern.traces.openClass", (node: { client: Client; trace: { typeName: string } }) => openPluginClass(node.client, node.trace.typeName)),

    // ---------- system jobs ----------
    r("lantern.jobs.filter", async () => {
      const f = tree.jobFilter;
      const picks = [
        { label: "Failed", action: () => (f.status = "failed") },
        { label: "Waiting or running", action: () => (f.status = "active") },
        { label: "All statuses", action: () => (f.status = "all") },
        { label: "Last hour", action: () => (f.hours = 1) },
        { label: "Last 24 hours", action: () => (f.hours = 24) },
        { label: "Last 7 days", action: () => (f.hours = 168) },
        { label: "Any time", action: () => (f.hours = 0) },
      ];
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Filter system jobs" });
      if (!pick) return;
      pick.action();
      tree.reloadSections("jobs");
    }),
    r("lantern.jobs.open", async (node: JobNode) => {
      const uri = vscode.Uri.from({ scheme: TraceDocProvider.scheme, path: `/${node.client.name}/job-${node.job.id}.log` });
      docs.set(uri, formatJob(node.job));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    }),
    r("lantern.jobs.openRegarding", async (node: JobNode) => {
      const reg = node.job.regarding;
      if (reg) await openInBrowser(node.client, reg.table, reg.id);
    }),

    // ---------- environment variables ----------
    r("lantern.envvars.edit", async (node: EnvVarNode) => {
      const v = node.variable;
      let value: string | undefined;
      if (v.type === "Yes/No") {
        value = await vscode.window.showQuickPick(["yes", "no"], { placeHolder: `${v.displayName} (currently ${v.value ?? v.defaultValue ?? "not set"})` });
      } else {
        value = await vscode.window.showInputBox({
          title: `${v.displayName} in ${node.client.orgHost}`,
          prompt: `${v.schemaName} (${v.type}). Default: ${v.defaultValue || "none"}`,
          value: v.value ?? v.defaultValue,
          ignoreFocusOut: true,
          validateInput: (text: string) => {
            if (v.type === "Number" && text.trim() && Number.isNaN(Number(text))) return "Enter a number.";
            if (v.type === "JSON") {
              try {
                JSON.parse(text);
              } catch {
                return "Enter valid JSON.";
              }
            }
            return undefined;
          },
        });
      }
      if (value === undefined || !(await confirmProtected(node.client, `Change ${v.schemaName}`))) return;
      const ok = await withProgress(`Saving ${v.schemaName}`, async () => {
        await setEnvVar(dataverseFor(node.client), v, value!);
        return true;
      });
      if (ok) {
        tree.reloadSections("envvars");
        vscode.window.setStatusBarMessage(`$(check) ${v.displayName} saved`, 4000);
      }
    }),

    // ---------- records ----------
    r("lantern.record.inspect", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org) return;
      const fromClipboard = await vscode.env.clipboard.readText();
      const input = await vscode.window.showInputBox({
        title: "Inspect a record",
        prompt: "Paste a record URL from the app, a GUID, or table:GUID",
        value: GUID.test(fromClipboard) ? fromClipboard.trim() : "",
        ignoreFocusOut: true,
        validateInput: (text: string) => (parseRecordRef(text) ? undefined : "Needs a record ID (GUID)."),
      });
      if (input) await inspect(client, input);
    }),
    r("lantern.record.openFromClipboard", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org) return;
      const text = await vscode.env.clipboard.readText();
      if (!parseRecordRef(text)) {
        void vscode.window.showWarningMessage("The clipboard doesn't contain a record ID (GUID) or record URL.");
        return;
      }
      const target = await resolveRecord(client, text, serviceFor(client));
      if (target) await openInBrowser(client, target.table.logicalName, target.id);
    }),
    r("lantern.record.audit", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org) return;
      const fromClipboard = await vscode.env.clipboard.readText();
      const input = await vscode.window.showInputBox({
        title: "Audit history",
        prompt: "Paste a record URL from the app, a GUID, or table:GUID",
        value: GUID.test(fromClipboard) ? fromClipboard.trim() : "",
        ignoreFocusOut: true,
        validateInput: (text: string) => (parseRecordRef(text) ? undefined : "Needs a record ID (GUID)."),
      });
      if (!input) return;
      const target = await resolveRecord(client, input, serviceFor(client));
      if (target) await audit(client, target.table.logicalName, target.id);
    }),

    // ---------- results grid right-click ----------
    r("lantern.results.inspectRecord", async (ctx: CellContext) => {
      const hit = results.cell(ctx);
      const client = results.currentClient;
      if (!hit || !client) return;
      const ref = hit.cell.ref ?? (hit.set.rowIds[ctx.row] ? { table: hit.set.record?.table ?? hit.set.table, id: hit.set.rowIds[ctx.row]! } : undefined);
      if (!ref) return;
      // The table and ID are known here, so no parsing or prompting.
      const table = (await serviceFor(client).tables()).find((t) => t.logicalName === ref.table);
      if (!table) {
        void vscode.window.showWarningMessage(`There's no table named "${ref.table}" in ${client.orgHost}.`);
        return;
      }
      await showRecord(client, table, ref.id);
    }),
    r("lantern.results.auditRecord", async (ctx: CellContext) => {
      const hit = results.cell(ctx);
      const client = results.currentClient;
      if (!hit || !client) return;
      const record = recordOf(hit.set, ctx);
      if (record) await audit(client, record.table, record.id);
    }),
    r("lantern.results.auditColumn", async (ctx: CellContext) => {
      const hit = results.cell(ctx);
      const client = results.currentClient;
      if (!hit || !client || hit.set.kind !== "record" || !hit.set.record) return;
      const column = String(hit.set.rows[ctx.row][1].raw);
      await audit(client, hit.set.record.table, hit.set.record.id, column);
    }),

    // ---------- queries ----------
    r("lantern.query.runAs", async (arg?: vscode.Uri) => {
      const doc = vscode.window.activeTextEditor?.document;
      const client = doc ? clientForQuery(doc) : undefined;
      if (!client?.config.org) {
        void vscode.window.showWarningMessage("Open a Dataverse query first.");
        return;
      }
      const users = await withProgress(`Loading users from ${client.orgHost}`, () => fetchUsers(dataverseFor(client)));
      if (!users) return;
      const pick = await vscode.window.showQuickPick(
        users.map((u) => ({ label: u.fullname, description: u.domainname, user: u })),
        { placeHolder: "Run as which user? (needs the act-on-behalf-of-another-user privilege)", matchOnDescription: true }
      );
      if (pick) await runQueryCommand(serviceFor, results, arg, { userId: pick.user.systemuserid, name: pick.user.fullname });
    }),
    r("lantern.query.copyAs", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      if (doc.languageId !== "sql" && !isFetchXml(doc.getText())) {
        void vscode.window.showInformationMessage("Open a SQL or FetchXML query to copy it as code.");
        return;
      }
      const client = clientForQuery(doc);
      const text = editor.selection.isEmpty ? statementAtCursor(doc.getText(), doc.offsetAt(editor.selection.active)) : doc.getText(editor.selection);
      if (!text.trim()) return;
      await copyAs(text, client, serviceFor);
    }),
    r("lantern.results.copyAs", async (setIndex: number) => {
      const set = results.set(setIndex);
      if (set) await copyAs(set.source, results.currentClient, serviceFor);
    }),
  ];
}

/** Opens a plug-in class in the client folder by its type name, selecting the class name. */
export async function openPluginClass(client: Client, typeName: string, assembly?: string): Promise<void> {
  // Trace type names are assembly-qualified: "Acme.Plugins.AccountPostUpdate, Acme.Plugins, Version=...".
  const [name, qualifiedAssembly] = typeName.split(",").map((s) => s.trim());
  const owner = assembly ?? qualifiedAssembly;
  const projects = findPluginProjects(client.dir);
  const preferred = owner ? projects.filter((p) => p.assembly.toLowerCase() === owner.toLowerCase()) : projects;
  const files = [...new Set(preferred.flatMap((p) => projectSourceFiles(p.project)))];
  const decl = findType(name, files, client.dir);
  if (!decl) {
    void vscode.window.showInformationMessage(`The class ${name} isn't in the ${client.name} folder.${owner ? ` Use Get Source from Dataverse to decompile ${owner}.` : ""}`);
    return;
  }
  const short = decl.name.replace(/`\d+$/, "");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(decl.file));
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(decl.line, decl.column, decl.line, decl.column + short.length), preview: true });
}

const GUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signs a client (its active environment) in with an app registration; the secret goes to VS Code's secret storage. */
async function useAppRegistration(client: Client, tree: WorkspaceTree): Promise<void> {
  const appId = await vscode.window.showInputBox({
    title: `App registration for ${client.name}${client.envName ? ` (${client.envName})` : ""}`,
    prompt: "Application (client) ID",
    value: client.config.appId,
    ignoreFocusOut: true,
    validateInput: (v: string) => (GUID_ONLY.test(v.trim()) ? undefined : "Enter the application ID (a GUID)."),
  });
  if (!appId) return;
  const tenant = await vscode.window.showInputBox({
    title: "Tenant",
    prompt: "Directory (tenant) ID or domain, e.g. contoso.onmicrosoft.com",
    value: client.config.tenant,
    ignoreFocusOut: true,
    validateInput: (v: string) => (v.trim() ? undefined : "The tenant is required for an app registration."),
  });
  if (!tenant) return;
  const secret = await vscode.window.showInputBox({
    title: "Client secret",
    prompt: "Stored in VS Code's secret storage, never in .lantern/config.json",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v: string) => (v ? undefined : "Enter the secret."),
  });
  if (!secret) return;
  client.reload();
  client.config.appId = appId.trim();
  client.config.tenant = tenant.trim();
  client.config.account = "";
  client.save();
  await storeAppSecret(client, secret);
  forgetSignIn(client);
  const ok = await withProgress(`Signing in to ${client.orgHost} with app ${client.config.appId}`, async (ctx) => {
    await getToken(client);
    try {
      await ensureAuth(ctx, client);
    } catch (err) {
      if (!/isn't on your PATH/.test(err instanceof Error ? err.message : "")) throw err;
    }
    return true;
  });
  tree.refresh();
  if (ok) void vscode.window.showInformationMessage(`${client.name} now signs in with app registration ${client.config.appId}.`);
}

async function toggleStep(tree: WorkspaceTree, node: StepNode, enabled: boolean): Promise<void> {
  const verb = enabled ? "Turn on" : "Turn off";
  if (!(await confirmProtected(node.client, `${verb} ${node.step.name}`))) return;
  const ok = await withProgress(`${verb} ${node.step.name}`, async () => {
    await setStepEnabled(dataverseFor(node.client), node.step.id, enabled);
    return true;
  });
  if (!ok) return;
  tree.reloadSections("steps");
  vscode.window.setStatusBarMessage(`$(plug) ${node.step.name} is ${enabled ? "on" : "off"}`, 4000);
}

/** A record's table and ID from user input, asking for the table when only a GUID was given. */
export async function resolveRecord(client: Client, input: string, service: MetadataService): Promise<{ table: TableMeta; id: string } | undefined> {
  const ref = parseRecordRef(input);
  if (!ref) return undefined;
  if (ref.table) {
    const tables = await withProgress(`Loading tables from ${client.orgHost}`, () => service.tables());
    const table = tables?.find((t) => t.logicalName === ref.table);
    if (!table) {
      void vscode.window.showWarningMessage(`There's no table named "${ref.table}" in ${client.orgHost}.`);
      return undefined;
    }
    return { table, id: ref.id };
  }
  const table = await pickTable(client, service, `Which table is ${ref.id} in?`);
  return table ? { table, id: ref.id } : undefined;
}

function recordOf(set: ResultSet, ctx: CellContext): { table: string; id: string } | undefined {
  if (set.record) return set.record;
  const id = set.rowIds[ctx.row];
  return id ? { table: set.table, id } : undefined;
}

async function openInBrowser(client: Client, table: string, id: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(`${client.config.org}/main.aspx?etn=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}&pagetype=entityrecord`));
}

export function statementAtCursor(text: string, offset: number): string {
  if (isFetchXml(text)) return text;
  const statements = splitStatements(text);
  let from = 0;
  for (const s of statements) {
    const at = text.indexOf(s, from);
    if (at >= 0 && offset <= at + s.length) return s;
    from = at + s.length;
  }
  return statements[statements.length - 1] ?? "";
}

async function copyAs(text: string, client: Client | undefined, serviceFor: (c: Client) => MetadataService): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    CODE_FORMATS.map((f) => ({ label: f.label, detail: f.detail, format: f.format })),
    { placeHolder: "Copy this query as..." }
  );
  if (!pick) return;
  const tables = client ? serviceFor(client).cached<TableMeta[]>("tables") ?? [] : [];
  const byName = new Map(tables.map((t) => [t.logicalName, t]));
  let result: { code: string } | { error: string };
  try {
    result = generate(pick.format, {
      text,
      isFetchXml: isFetchXml(text),
      org: client?.config.org ?? "https://<org>.crm.dynamics.com",
      entitySetOf: (t) => byName.get(t)?.entitySetName,
      options: { primaryIdOf: (t) => byName.get(t)?.primaryId },
    });
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  if ("error" in result) {
    void vscode.window.showWarningMessage(result.error);
    return;
  }
  await vscode.env.clipboard.writeText(result.code);
  const choice = await vscode.window.showInformationMessage(`Copied the query as ${pick.label}.`, "Open in Editor");
  if (choice) {
    const language = pick.format === "xrmWebApi" ? "javascript" : pick.format === "webApiUrl" ? "plaintext" : "csharp";
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language, content: result.code + "\n" }));
  }
}
