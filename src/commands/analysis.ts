import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { analyzeJsFunction, analyzePluginClass, callersIn, findJsFunction, functionAt, FunctionTouches, outlineJs, PluginAnalysis, pluginWarnings, StepImage } from "../core/codeanalysis";
import { Dependency, fetchDependencies, TYPE } from "../core/dependencies";
import { UserError } from "../core/errors";
import { findFiles } from "../core/files";
import { findWebResourceFile } from "../core/handlers";
import { ColumnMeta, FormMeta, MetadataService, TableMeta } from "../core/metadata";
import { registrationsOf } from "../core/references";
import { resolveWebResourceName } from "../core/solutions";
import { ribbonLabels, RibbonUse, scanRibbonFunctions } from "../core/ribbon";
import { dataverseFor } from "../ui/auth";
import { clientForPath, reportError, withProgress } from "../ui/context";
import { tableForDocument } from "../ui/metadataLanguage";
import { MetaNode } from "../ui/metadataTree";
import { LocalNode } from "../ui/workspaceTree";
import { TableDocProvider } from "./metadata";

type Node = MetaNode | LocalNode;

const fileLink = (file: string, line: number) => vscode.Uri.file(file).with({ fragment: `L${line + 1}` }).toString();
const cell = (v: string) => v.replace(/\|/g, "\\|");

async function showReport(docs: TableDocProvider, client: Client, name: string, markdown: string): Promise<void> {
  const uri = vscode.Uri.from({ scheme: TableDocProvider.scheme, path: `/${client.name}/${name.replace(/[^\w.-]+/g, "_")}.md` });
  docs.set(uri, markdown);
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    await vscode.window.showTextDocument(uri, { preview: true });
  }
}

export function registerAnalysisCommands(serviceFor: (c: Client) => MetadataService, docs: TableDocProvider): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });

  return [
    // ---------- Dataverse dependencies ----------
    r("lantern.dependencies.show", async (arg?: Node | vscode.Uri) => {
      const target = await dependencyTarget(arg);
      if (!target) return;
      const { client, id, type, label } = target;
      const result = await withProgress(`Finding dependencies of ${label}`, async () =>
        fetchDependencies(dataverseFor(client), id, type, await serviceFor(client).tables())
      );
      if (result) await showReport(docs, client, `dependencies-${label}`, dependenciesMarkdown(label, type, result, client));
    }),

    // ---------- what a function touches ----------
    r("lantern.code.analyzeFunction", async (arg?: unknown, fnName?: string) => {
      const target = await functionTarget(arg, fnName);
      if (!target) return;
      const { client, file, text, fnName: name, offset } = target;
      const outline = outlineJs(text);
      const fn = name ? findJsFunction(outline, name) : functionAt(outline, offset ?? 0);
      if (!fn) {
        void vscode.window.showWarningMessage(name ? `Couldn't find ${name} in ${path.basename(file)}.` : "Put the cursor inside a function first.");
        return;
      }
      const touches = analyzeJsFunction(text, fn, outline);
      const meta = await scriptMetadata(client, file, serviceFor);
      const library = resolveWebResourceName(file, client)?.name;
      const ribbon = library ? scanRibbonFunctions(client.dir, true).get(library.toLowerCase()) : undefined;
      const runsOn = [...registrationsOf(meta.forms, library, fn.name), ...ribbonLabels(ribbon, fn.written)];
      await showReport(docs, client, `function-${fn.name}`, functionMarkdown(touches, file, client, meta, runsOn));
    }),

    // ---------- library outline ----------
    r("lantern.code.outline", async (arg?: unknown) => {
      const target = await functionTarget(arg);
      if (!target) return;
      const { client, file, text } = target;
      const meta = await scriptMetadata(client, file, serviceFor);
      const library = resolveWebResourceName(file, client)?.name;
      const ribbon = library ? scanRibbonFunctions(client.dir, true).get(library.toLowerCase()) : undefined;
      await showReport(docs, client, `outline-${path.basename(file)}`, outlineMarkdown(text, file, library, meta.forms, meta.table, ribbon));
    }),

    // ---------- plug-in step vs. its class ----------
    r("lantern.steps.analyze", async (node: Extract<LocalNode, { kind: "step" }>) => {
      const s = node.step;
      const short = s.typeName.split(".").pop() ?? s.typeName;
      const file = findFiles(node.client.dir, (n) => n.toLowerCase().endsWith(".cs")).find((f) =>
        new RegExp(`\\bclass\\s+${short}\\b`).test(fs.readFileSync(f, "utf8"))
      );
      if (!file) {
        void vscode.window.showInformationMessage(`The class ${s.typeName} isn't in the ${node.client.name} folder, so there's no code to check.`);
        return;
      }
      const analysis = analyzePluginClass(fs.readFileSync(file, "utf8"), short);
      if (!analysis) return;
      const images = await withProgress(`Loading images for ${s.name}`, async () => {
        const rows = await dataverseFor(node.client).getAll<{ entityalias: string; imagetype: number; attributes: string | null }>(
          `sdkmessageprocessingstepimages?$select=entityalias,imagetype,attributes&$filter=_sdkmessageprocessingstepid_value eq ${s.id}`
        );
        return rows.flatMap((i): StepImage[] => {
          const attributes = (i.attributes ?? "").split(",").map((a) => a.trim()).filter(Boolean);
          const kinds: Array<"Pre" | "Post"> = i.imagetype === 2 ? ["Pre", "Post"] : [i.imagetype === 1 ? "Post" : "Pre"];
          return kinds.map((kind) => ({ alias: i.entityalias, kind, attributes }));
        });
      });
      if (!images) return;
      const filtering = s.filtering.split(",").map((a) => a.trim()).filter(Boolean);
      await showReport(docs, node.client, `step-${short}`, stepMarkdown(s, file, analysis, images, pluginWarnings(analysis, { message: s.message, filtering, images })));
    }),
  ];
}

// ---------- targets ----------

async function dependencyTarget(arg: Node | vscode.Uri | undefined): Promise<{ client: Client; id: string; type: number; label: string } | undefined> {
  const node = arg as Node | undefined;
  if (node && "kind" in node) {
    switch (node.kind) {
      case "table":
        return { client: node.client, id: node.table.metadataId, type: TYPE.table, label: `${node.table.displayName} (${node.table.logicalName})` };
      case "column": {
        const r = await withProgress("Looking up the column", () =>
          dataverseFor(node.client).getJson<{ MetadataId: string }>(
            `EntityDefinitions(LogicalName='${node.table.logicalName}')/Attributes(LogicalName='${node.column.logicalName}')?$select=MetadataId`
          )
        );
        return r ? { client: node.client, id: r.MetadataId, type: TYPE.column, label: `${node.column.displayName || node.column.logicalName} (${node.table.logicalName}.${node.column.logicalName})` } : undefined;
      }
      case "form":
        return { client: node.client, id: node.form.id, type: TYPE.form, label: `${node.form.name} form (${node.table.logicalName})` };
      case "step":
        return { client: node.client, id: node.step.id, type: TYPE.step, label: node.step.name };
      case "envvar":
        return { client: node.client, id: node.variable.definitionId, type: TYPE.envVar, label: node.variable.schemaName };
      case "webResource":
        return { client: node.client, id: node.resource.id, type: TYPE.webResource, label: node.resource.name };
    }
  }
  const file = (arg as vscode.Uri | undefined)?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  const client = file ? clientForPath(file) : undefined;
  if (!file || !client?.config.org) {
    void vscode.window.showWarningMessage("Pick a table, column, form, web resource, plug-in step, or environment variable.");
    return undefined;
  }
  const name = resolveWebResourceName(file, client)?.name;
  if (!name) throw new UserError(`${path.basename(file)} isn't a web resource Lantern can name. Add its folder to "webResourceRoots" in client.json.`);
  const wr = await withProgress(`Looking up ${name}`, () => dataverseFor(client).findWebResource(name));
  if (wr === undefined) return undefined;
  if (!wr) throw new UserError(`${name} doesn't exist in ${client.orgHost} yet, so nothing depends on it.`);
  return { client, id: wr.id, type: TYPE.webResource, label: name };
}

/** The script (and function) to analyze: a CodeLens/command argument, a handler node, a web resource node, or the active editor. */
async function functionTarget(
  arg?: unknown,
  fnName?: string
): Promise<{ client: Client; file: string; text: string; fnName?: string; offset?: number } | undefined> {
  const node = arg as Node | undefined;
  let file: string | undefined;
  let name = fnName;
  let client: Client | undefined;
  if (node && "kind" in node && (node.kind === "handler" || node.kind === "webResource")) {
    client = node.client;
    const library = node.kind === "handler" ? node.handler.libraryName : node.resource.name;
    if (node.kind === "handler") name = node.handler.functionName;
    file = findWebResourceFile(node.client, library);
    if (!file) {
      void vscode.window.showInformationMessage(`${library} isn't in the ${node.client.name} folder. Pull its solution to analyze its code.`);
      return undefined;
    }
  } else if (arg && typeof (arg as vscode.Uri).fsPath === "string") {
    file = (arg as vscode.Uri).fsPath;
  }
  const editor = vscode.window.activeTextEditor;
  if (!file && editor?.document.uri.scheme === "file") file = editor.document.uri.fsPath;
  if (!file) return undefined;
  client = client ?? clientForPath(file);
  if (!client) {
    void vscode.window.showWarningMessage("That script isn't inside a client folder.");
    return undefined;
  }
  const open = vscode.workspace.textDocuments.find((d: vscode.TextDocument) => d.uri.fsPath === file);
  const text = open ? open.getText() : fs.readFileSync(file, "utf8");
  const offset = !name && editor && editor.document.uri.fsPath === file ? editor.document.offsetAt(editor.selection.active) : undefined;
  return { client, file, text, fnName: name, offset };
}

interface ScriptMeta {
  table?: string;
  columns: ColumnMeta[];
  forms: FormMeta[];
  tableMeta?: TableMeta;
}

async function scriptMetadata(client: Client, file: string, serviceFor: (c: Client) => MetadataService): Promise<ScriptMeta> {
  if (!client.config.org) return { columns: [], forms: [] };
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const st = await tableForDocument(doc, serviceFor, false).catch(() => undefined);
  if (!st) return { columns: [], forms: [] };
  const loaded = await withProgress(`Loading ${st.table} metadata`, async () => ({
    columns: await st.service.columns(st.table),
    forms: await st.service.forms(st.table),
    tableMeta: (await st.service.tables()).find((t) => t.logicalName === st.table),
  }));
  return { table: st.table, columns: loaded?.columns ?? [], forms: loaded?.forms ?? [], tableMeta: loaded?.tableMeta };
}

// ---------- reports ----------

export function dependenciesMarkdown(label: string, type: number, result: { usedBy: Dependency[]; uses: Dependency[] }, client: Client): string {
  const lines = [`# Dependencies of ${label}`, "", `From Dataverse's dependency tracking in ${client.orgHost}.`, ""];
  const section = (title: string, explain: string, list: Dependency[]) => {
    lines.push(`## ${title} (${list.length})`, "", explain, "");
    if (!list.length) {
      lines.push("Nothing.", "");
      return;
    }
    const groups = new Map<string, Dependency[]>();
    for (const d of list) groups.set(d.typeLabel, [...(groups.get(d.typeLabel) ?? []), d]);
    for (const [group, items] of groups) {
      lines.push(`**${group}**`, "");
      for (const d of items) {
        const local = d.type === TYPE.webResource ? findWebResourceFile(client, d.name) : undefined;
        const name = local ? `[${d.name}](${fileLink(local, 0)})` : d.name;
        lines.push(`- ${name}${d.detail ? ` (${d.detail})` : ""}`);
      }
      lines.push("");
    }
  };
  section("Used by", "These depend on it, so changing or deleting it affects them.", result.usedBy);
  section("Uses", "It needs these to exist.", result.uses);
  lines.push("---", "", "Dataverse doesn't track code. A script calling `getAttribute(\"…\")` or a plug-in reading a column won't appear here.");
  if (type === TYPE.column) lines.push("Use **Find Where Column Is Used** for those.");
  if (type === TYPE.webResource) lines.push("Use **Library Outline** to see the functions inside it and where each runs.");
  return lines.join("\n") + "\n";
}

export function functionMarkdown(t: FunctionTouches, file: string, client: Client, meta: ScriptMeta, runsOn: string[]): string {
  const rel = path.relative(client.dir, file).split(path.sep).join("/");
  const at = (line: number) => `[line ${line + 1}](${fileLink(file, line)})`;
  const byName = new Map(meta.columns.map((c) => [c.logicalName, c]));
  const onForm = new Set(meta.forms.flatMap((f) => [...f.header, ...f.tabs.flatMap((tab) => tab.sections.flatMap((s) => s.controls))]).map((c) => c.field).filter(Boolean) as string[]);
  const controls = new Set(meta.forms.flatMap((f) => [...f.header, ...f.tabs.flatMap((tab) => tab.sections.flatMap((s) => s.controls))]).map((c) => c.id));
  const tabs = new Set(meta.forms.flatMap((f) => f.tabs.map((tab) => tab.name)));
  const sections = new Set(meta.forms.flatMap((f) => f.tabs.flatMap((tab) => tab.sections.map((s) => `${tab.name}/${s.name}`))));
  const known = meta.forms.length > 0;
  const check = (ok: boolean) => (!known ? "" : ok ? "yes" : "**no**");

  const lines = [`# ${t.fn.written}`, "", `In [${rel}](${fileLink(file, t.fn.line)}), ${at(t.fn.line)}.`];
  lines.push(runsOn.length ? `Runs on ${runsOn.join("; ")}.` : known ? "Not registered on any form of this table (it may be called by another function, the command bar, or another library)." : "");
  if (meta.table) lines.push(`Checked against the forms of **${meta.table}**.`);
  lines.push("");

  if (t.columns.length) {
    lines.push(`## Columns (${t.columns.length})`, "", "| Column | Display name | What it does | On a form? |", "|---|---|---|---|");
    for (const c of t.columns) {
      const m = byName.get(c.name);
      lines.push(`| \`${c.name}\` | ${cell(m?.displayName ?? (known ? "**not a column of this table**" : ""))} | ${c.methods.join(", ") || "looked up"} (${at(c.line)}) | ${check(onForm.has(c.name))} |`);
    }
    lines.push("");
  }
  if (t.controls.length) {
    lines.push(`## Controls (${t.controls.length})`, "", "| Control | What it does | On a form? |", "|---|---|---|");
    for (const c of t.controls) lines.push(`| \`${c.name}\` | ${c.methods.join(", ") || "looked up"} (${at(c.line)}) | ${check(controls.has(c.name))} |`);
    lines.push("");
  }
  if (t.tabs.length || t.sections.length) {
    lines.push("## Tabs and sections", "");
    for (const tab of t.tabs) lines.push(`- Tab \`${tab.name}\`${tab.methods.length ? `: ${tab.methods.join(", ")}` : ""} (${at(tab.line)})${known && !tabs.has(tab.name) ? " **not on any form**" : ""}`);
    for (const s of t.sections) lines.push(`- Section \`${s.tab}/${s.name}\`${s.methods.length ? `: ${s.methods.join(", ")}` : ""} (${at(s.line)})${known && !sections.has(`${s.tab}/${s.name}`) ? " **not on any form**" : ""}`);
    lines.push("");
  }
  if (t.webApi.length) {
    lines.push("## Web API calls", "");
    for (const w of t.webApi) lines.push(`- \`${w.operation}\` on **${w.table}** (${at(w.line)})`);
    lines.push("");
  }
  if (t.calls.length) {
    lines.push("## Functions it calls", "");
    for (const c of t.calls) lines.push(`- **${c.name}** (${at(c.line)})`);
    lines.push("");
  }
  if (t.dynamic.length) {
    lines.push("## Names built at runtime", "", "These can't be checked without running the code:", "");
    for (const d of t.dynamic) lines.push(`- \`${d.text}\` (${at(d.line)})`);
    lines.push("");
  }
  if (!t.columns.length && !t.controls.length && !t.tabs.length && !t.webApi.length && !t.calls.length) lines.push("It doesn't reference any columns, controls, tabs, Web API calls, or other functions in this file.", "");
  if (known) lines.push("---", "", '"**no**" means the name isn\'t on any form of this table, so `getAttribute` / `getControl` returns `null` at runtime.');
  return lines.join("\n") + "\n";
}

export function outlineMarkdown(text: string, file: string, library: string | undefined, forms: FormMeta[], table?: string, ribbon?: RibbonUse[]): string {
  const outline = outlineJs(text);
  const callers = callersIn(text, outline);
  const lines = [`# ${library ?? path.basename(file)}`, "", `${outline.length} function${outline.length === 1 ? "" : "s"}${table ? `, checked against the forms of **${table}**` : ""}.`, ""];
  lines.push("| Function | Line | Runs on | Called by |", "|---|---|---|---|");
  const unused: string[] = [];
  for (const fn of outline) {
    const runs = [...registrationsOf(forms, library, fn.name), ...ribbonLabels(ribbon, fn.written)];
    const calledBy = callers.get(fn.name) ?? [];
    if (!runs.length && !calledBy.length) unused.push(fn.name);
    lines.push(`| **${fn.name}** | [${fn.line + 1}](${fileLink(file, fn.line)}) | ${cell(runs.join("; ")) || ""} | ${calledBy.join(", ")} |`);
  }
  lines.push("");
  if (unused.length) {
    lines.push("## Not registered or called here", "", ...unused.map((n) => `- ${n}`), "");
    lines.push(
      `Nothing on this table's forms${ribbon ? " or in the pulled solutions' command bar" : ""} runs these, and nothing in this file calls them. They may still be called from another library or a solution you haven't pulled, so check before deleting.`,
      ""
    );
  }
  return lines.join("\n") + "\n";
}

export function stepMarkdown(
  s: { name: string; message: string; table: string; stage: string; mode: string; filtering: string },
  file: string,
  a: PluginAnalysis,
  images: StepImage[],
  warnings: string[]
): string {
  const at = (line: number) => `[line ${line + 1}](${fileLink(file, line)})`;
  const lines = [`# ${s.name}`, "", `**${s.message}** of **${s.table || "any table"}**, ${s.stage}, ${s.mode.toLowerCase()}. Class **${a.className}** in [${path.basename(file)}](${fileLink(file, a.classLine)}).`, ""];
  lines.push(`Filtering columns: ${s.filtering ? s.filtering.split(",").map((c) => `\`${c.trim()}\``).join(", ") : "none (runs on any change)"}.`, "");
  lines.push(`Images: ${images.length ? images.map((i) => `${i.kind}-image \`${i.alias}\` (${i.attributes.length ? i.attributes.join(", ") : "all columns"})`).join("; ") : "none"}.`, "");
  if (warnings.length) lines.push("## Problems", "", ...warnings.map((w) => `- ${w}`), "");
  const group = (title: string, list: PluginAnalysis["reads"]) => {
    if (!list.length) return;
    lines.push(`## ${title}`, "", "| Column | From | Where |", "|---|---|---|");
    for (const u of list) lines.push(`| \`${u.column}\` | ${u.source.replace(/^(Pre|Post)Image:/, "$1-image ")} | ${at(u.line)} |`);
    lines.push("");
  };
  group("Columns it reads", a.reads);
  group("Columns it writes", a.writes);
  if (a.otherTables.length) {
    lines.push("## Other tables", "", ...a.otherTables.map((t) => `- ${t.how} **${t.table}** (${at(t.line)})`), "");
  }
  if (!warnings.length) lines.push("No problems found between the class and this step's registration.", "");
  return lines.join("\n") + "\n";
}
