import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { UserError } from "../core/errors";
import {
  classesIn, csharpExampleValue, csharpTypeOf, ExistingClass, ExistingCode, fieldReference, generatable, generateClass, hasProxyTypesAttribute, includeInOldStyleProject, matchName, owningProject, PROXY_TYPES_FILE, scanExisting,
} from "../core/csharpClasses";
import { isInside } from "../core/files";
import { ColumnMeta, MetadataService, solutionColumnNames, TableMeta } from "../core/metadata";
import { findPluginProjects } from "../core/solutions";
import { clientForPath, reportError, resolveClient, withProgress } from "../ui/context";
import { activeTenant } from "../ui/tenantContext";
import { ColumnItem, openColumnPicker, PickerField } from "../ui/panels/columnPickerPanel";

/**
 * C# classes for plug-ins. Tables go into a queue first (Add to C# Classes, with
 * the columns to include); a status bar item shows the queue while it has
 * anything in it; Generate writes the queued tables' files. Columns already in
 * your classes come pre-picked and tables you don't queue are never touched.
 */

interface QueueEntry {
  table: string;
  label: string;
  columns: string[];
  /** Columns only in your code (not generated from Dataverse) to keep as written. */
  keep: string[];
}

const STATE_KEY = "lantern.csharpClasses.queue";
const GENERATE = "$(run-all) Generate";
const ADD_TABLES = "$(add) Add Tables…";
const CLEAR = "$(clear-all) Clear the Queue";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A tenant's queue: by its configuration file as well as its name, since two projects can each have a tenant called Dev. */
const queueKey = (client: Client) => `${client.configFile}\0${client.name}`;
const sameEntry = (a: QueueEntry, b: QueueEntry) => JSON.stringify(a) === JSON.stringify(b);
/** Custom columns first in the picker, then standard ones, then what's only in the code. */
const groupOrder = (group: string) => (group === "Custom columns" ? 0 : group === "Standard columns" ? 1 : 2);

export class CSharpClassQueue implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem("lantern.csharpClasses", vscode.StatusBarAlignment.Left, 40);

  constructor(private readonly context: vscode.ExtensionContext, private readonly serviceFor: (c: Client) => MetadataService) {
    this.status.name = "Lantern C# classes queue";
    this.status.command = "lantern.csharpClasses.queue";
    this.update();
  }

  private all(): Record<string, QueueEntry[]> {
    return this.context.globalState.get<Record<string, QueueEntry[]>>(STATE_KEY) ?? {};
  }

  queue(client: Client): QueueEntry[] {
    const all = this.all();
    // Queues used to be keyed by the name alone; such a queue is read until the first save moves it. A copy, so
    // one command's entries don't change under another's (generating compares what it read with what's there after).
    return structuredClone(all[queueKey(client)] ?? all[client.name] ?? []);
  }

  private async save(client: Client, entries: QueueEntry[]): Promise<void> {
    const all = this.all();
    delete all[client.name];
    if (entries.length) all[queueKey(client)] = entries;
    else delete all[queueKey(client)];
    await this.context.globalState.update(STATE_KEY, all);
    this.update();
  }

  /** The status bar item: shown, highlighted, while the active tenant has tables waiting. */
  update(): void {
    const client = activeTenant();
    const entries = client ? this.queue(client) : [];
    if (!entries.length) {
      this.status.hide();
      return;
    }
    this.status.text = `$(symbol-class) C# classes: ${plural(entries.length, "table")} queued`;
    this.status.tooltip = `Waiting to be generated for ${client!.name}:\n${entries.map((e) => `• ${e.label} (${plural(e.columns.length, "column")})`).join("\n")}\n\nClick to review, change, or generate.`;
    this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.status.show();
  }

  dispose(): void {
    this.status.dispose();
  }

  // ---------- adding ----------

  /** Where the .cs files go when nothing is configured yet: the first plug-in project's Models folder. */
  private suggestedOutDir(client: Client): string {
    const projects = findPluginProjects(client.dir);
    return projects[0] ? path.join(path.relative(client.dir, path.dirname(projects[0].project)), "Models") : "Models";
  }

  /** The output folder, asked once per tenant (it decides which columns are already in your classes). */
  private async outDir(client: Client): Promise<string | undefined> {
    const settings = client.config.csharpClasses;
    if (!settings.outDir) {
      const suggestion = this.suggestedOutDir(client);
      const outDir = await vscode.window.showInputBox({
        title: "C# classes: output folder",
        prompt: `Folder for the generated .cs files, relative to ${client.name}/. Usually inside the plug-in project.`,
        value: suggestion,
        ignoreFocusOut: true,
      });
      if (!outDir?.trim()) return undefined;
      client.reload();
      client.config.csharpClasses.outDir = outDir.trim();
      client.save();
    }
    return path.resolve(client.dir, client.config.csharpClasses.outDir);
  }

  /**
   * Picks a table's columns and queues it, or changes its queued columns. False when
   * cancelled. The output folder and namespace are on the same page the first time
   * (the folder decides which columns are already in your classes).
   */
  async addTable(client: Client, table: TableMeta, solution?: string): Promise<boolean> {
    const settings = client.config.csharpClasses;
    const outDirRel = settings.outDir || this.suggestedOutDir(client);
    const outDir = path.resolve(client.dir, outDirRel);
    const existing = scanExisting(outDir);
    const cls = existing.classes.get(table.logicalName);
    if (cls?.sharesFile) {
      void vscode.window.showWarningMessage(`${table.logicalName} is in ${path.relative(client.dir, cls.file)} with other classes. Move it to its own file first; Lantern won't rewrite a shared file.`);
      return false;
    }
    const fields: Record<string, PickerField> = {};
    if (!settings.outDir) fields.outDir = { label: "Output folder", value: outDirRel, required: true, hint: `Folder for the generated .cs files, relative to ${client.name}/. Usually inside the plug-in project. Asked once per tenant.` };
    if (!settings.namespace) {
      const project = owningProject(outDir, client.dir) ?? findPluginProjects(client.dir)[0]?.project;
      const rootNamespace = project ? /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/i.exec(fs.readFileSync(project, "utf8"))?.[1] ?? path.basename(project, ".csproj") : client.name.replace(/[^\w.]/g, "");
      fields.namespace = { label: "Namespace", value: existing.namespace || `${rootNamespace}.Models`, hint: "Namespace for the classes. Leave it empty for none.", placeholder: "Contoso.Plugins.Models", pattern: "^[A-Za-z_]\\w*(\\.[A-Za-z_]\\w*)*$", patternText: "Use a C# namespace, like Contoso.Plugins.Models." };
    }
    const queued = this.queue(client).find((e) => e.table === table.logicalName);
    const choice = await this.pickColumns(client, table, cls, queued ? new Set([...queued.columns, ...queued.keep]) : undefined, solution, fields);
    if (!choice) return false;
    if (fields.outDir || fields.namespace) {
      client.reload();
      if (fields.outDir) client.config.csharpClasses.outDir = choice.fields.outDir.trim();
      if (fields.namespace) client.config.csharpClasses.namespace = choice.fields.namespace.trim();
      client.save();
      // A different folder may hold the table's class already, in a shared file.
      const chosen = scanExisting(path.resolve(client.dir, client.config.csharpClasses.outDir)).classes.get(table.logicalName);
      if (chosen?.sharesFile) {
        void vscode.window.showWarningMessage(`${table.logicalName} is in ${path.relative(client.dir, chosen.file)} with other classes. Move it to its own file first; Lantern won't rewrite a shared file.`);
        return false;
      }
    }
    const entry: QueueEntry = {
      table: table.logicalName,
      label: table.displayName || table.logicalName,
      columns: [table.primaryId, ...choice.columns.filter((c) => c.logicalName !== table.primaryId).map((c) => c.logicalName)],
      keep: choice.keep,
    };
    // Read again: an AI assistant may have queued tables while the picker was open.
    await this.save(client, [...this.queue(client).filter((e) => e.table !== table.logicalName), entry].sort((a, b) => a.label.localeCompare(b.label)));
    return true;
  }

  /**
   * The column picker: every column Lantern can generate, plus the ones only in your
   * code. Picked to start with: `preset` when given (a queued entry, as it was picked),
   * otherwise what the class has plus, from a table under a solution, that solution's
   * columns of it; just the primary name for a new class otherwise. Undefined when cancelled.
   */
  private async pickColumns(client: Client, table: TableMeta, cls: ExistingClass | undefined, preset?: Set<string>, solution?: string, fields: Record<string, PickerField> = {}): Promise<{ columns: ColumnMeta[]; keep: string[]; available: ColumnMeta[]; fields: Record<string, string> } | undefined> {
    const loaded = await withProgress(`Loading ${table.logicalName}'s columns`, async () => ({
      all: await this.serviceFor(client).columns(table.logicalName),
      inSolution: solution && !preset ? await solutionColumnNames(this.serviceFor(client), table, solution) : undefined,
    }));
    if (!loaded) return undefined;
    const available = loaded.all.filter(generatable);
    const inCode = cls?.columns ?? new Map();
    const inSolution = loaded.inSolution?.names ?? new Set<string>();
    const onlyInCode = [...inCode.keys()].filter((c) => !available.some((x) => x.logicalName === c));
    const isPicked = (c: string) => (preset ? preset.has(c) : inCode.has(c) || inSolution.has(c) || (!cls && !inSolution.size && c === table.primaryName));
    const items: ColumnItem[] = [
      ...available
        .filter((c) => c.logicalName !== table.primaryId)
        .map((c) => ({
          id: c.logicalName,
          label: c.displayName || c.logicalName,
          meta: `${c.logicalName} · ${c.type}`,
          group: c.isCustom ? "Custom columns" : "Standard columns",
          tags: [inCode.has(c.logicalName) ? "in your class" : "", inSolution.has(c.logicalName) ? `in ${solution}` : ""].filter(Boolean),
          picked: isPicked(c.logicalName),
          title: c.description || undefined,
        })),
      ...onlyInCode.map((c) => ({ id: c, label: c, meta: "kept as written", group: "Only in your code", tags: ["not in Dataverse, or a type Lantern doesn't generate"], picked: isPicked(c) || !preset })),
    ].sort((x, y) => groupOrder(x.group) - groupOrder(y.group) || x.label.localeCompare(y.label));
    const notes = [
      cls ? "What's in your class now is picked: unpick a column to drop it." : "",
      inSolution.size ? `${solution}'s columns are picked.` : "",
      loaded.inSolution?.everything ? `${solution} has the whole table, so its columns aren't picked.` : "",
      "Pick the columns your plug-ins use.",
    ].filter(Boolean);
    const result = await openColumnPicker(cls ? "Edit C# Class Columns" : "Add to C# Classes", cls && !preset ? "Save" : "Queue", {
      subtitle: `${table.displayName || table.logicalName} (${table.logicalName}) in ${client.envName || client.orgHost}`,
      table: { logical: table.logicalName, label: table.displayName || table.logicalName, primaryId: table.primaryId },
      fields,
      items,
      notes,
      draft: { picked: items.filter((i) => i.picked).map((i) => i.id), fields: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value])) },
    });
    if (!result) return undefined;
    const chosen = new Set(result.picked);
    return {
      columns: available.filter((c) => c.logicalName === table.primaryId || chosen.has(c.logicalName)),
      keep: onlyInCode.filter((c) => chosen.has(c)),
      available,
      fields: result.fields,
    };
  }

  /** The generated class for a table, when there is one in the output folder (for Fields constants in snippets). */
  classFor(client: Client, table: string): ExistingClass | undefined {
    const outDir = client.config.csharpClasses.outDir;
    return outDir ? scanExisting(path.resolve(client.dir, outDir)).classes.get(table) : undefined;
  }

  // ---------- from a class file (CodeLens) ----------

  /** The tenant, table and class behind a class in an open file. Asks to save unsaved edits first: the file is rewritten. */
  private async classInFile(uri: vscode.Uri, logical: string): Promise<{ client: Client; table: TableMeta; cls: ExistingClass; existing: ExistingCode; outDir: string } | undefined> {
    const client = clientForPath(uri.fsPath) ?? activeTenant();
    if (!client?.config.org) {
      void vscode.window.showWarningMessage("Select a tenant connected to Dataverse in Lantern first.");
      return undefined;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (doc?.isDirty) {
      const save = "Save and Continue";
      if ((await vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} has unsaved changes. Lantern rewrites the file, so save it first.`, { modal: true }, save)) !== save) return undefined;
      await doc.save();
    }
    const configured = client.config.csharpClasses.outDir ? path.resolve(client.dir, client.config.csharpClasses.outDir) : undefined;
    const outDir = configured && isInside(uri.fsPath, configured) ? configured : path.dirname(uri.fsPath);
    const existing = scanExisting(outDir);
    const cls = [...existing.classes.values()].find((c) => path.resolve(c.file) === path.resolve(uri.fsPath) && c.table === logical);
    if (!cls) {
      void vscode.window.showWarningMessage(`Lantern couldn't read the ${logical} class in ${path.basename(uri.fsPath)}.`);
      return undefined;
    }
    if (cls.sharesFile) {
      void vscode.window.showWarningMessage(`${path.basename(cls.file)} has other classes too. Move ${cls.className} to its own file first; Lantern won't rewrite a shared file.`);
      return undefined;
    }
    const tables = await withProgress(`Loading tables from ${client.envName || client.orgHost}`, () => this.serviceFor(client).tables());
    const table = tables?.find((t) => t.logicalName === logical);
    if (!tables) return undefined;
    if (!table) {
      void vscode.window.showWarningMessage(`${logical} isn't a table in ${client.envName || client.orgHost}.`);
      return undefined;
    }
    return { client, table, cls, existing, outDir };
  }

  /** CodeLens Edit Columns: pick the class's columns (what it has is picked) and rewrite the file now. */
  async editColumns(uri: vscode.Uri, logical: string): Promise<void> {
    const found = await this.classInFile(uri, logical);
    if (!found) return;
    const { client, table, cls, existing, outDir } = found;
    const choice = await this.pickColumns(client, table, cls);
    if (!choice) return;
    const before = new Set(cls.columns.keys());
    const after = new Set([...choice.columns.map((c) => c.logicalName), ...choice.keep]);
    const added = [...after].filter((c) => !before.has(c) && c !== table.primaryId);
    const removed = [...before].filter((c) => !after.has(c) && c !== table.primaryId);
    if (!added.length && !removed.length) {
      void vscode.window.showInformationMessage(`No change to ${cls.className}.`);
      return;
    }
    const project = owningProject(outDir, client.dir) ?? findPluginProjects(client.dir)[0]?.project;
    this.write(client, outDir, project, existing, [{ table, columns: choice.columns, keep: new Set(choice.keep), existing: cls }], cls.namespace ?? "");
    // A queued entry for the table follows, so generating later doesn't undo this.
    const entries = this.queue(client);
    const queued = entries.find((e) => e.table === table.logicalName);
    if (queued) {
      queued.columns = [table.primaryId, ...choice.columns.filter((c) => c.logicalName !== table.primaryId).map((c) => c.logicalName)];
      queued.keep = choice.keep;
      await this.save(client, entries);
    }
    vscode.window.setStatusBarMessage(`$(symbol-class) ${cls.className}: ${[added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}`, 6000);
  }

  /** CodeLens Update from Dataverse: the same columns, with current names, descriptions and choices. */
  async refreshClass(uri: vscode.Uri, logical: string): Promise<void> {
    const found = await this.classInFile(uri, logical);
    if (!found) return;
    const { client, table, cls, existing, outDir } = found;
    const all = await withProgress(`Updating ${cls.className} from ${client.envName || client.orgHost}`, () => this.serviceFor(client).columns(table.logicalName));
    if (!all) return;
    const available = all.filter(generatable);
    const columns = available.filter((c) => c.logicalName === table.primaryId || cls.columns.has(c.logicalName));
    const keep = new Set([...cls.columns.keys()].filter((c) => !available.some((x) => x.logicalName === c)));
    const project = owningProject(outDir, client.dir) ?? findPluginProjects(client.dir)[0]?.project;
    this.write(client, outDir, project, existing, [{ table, columns, keep, existing: cls }], cls.namespace ?? "");
    const gone = [...keep];
    vscode.window.setStatusBarMessage(`$(refresh) ${cls.className} updated from ${client.envName || client.orgHost}${gone.length ? `; kept as written (not in Dataverse): ${gone.join(", ")}` : ""}`, 6000);
  }

  /** Several tables at once; the ones with classes already come pre-picked. */
  private async addTables(client: Client): Promise<void> {
    const outDir = await this.outDir(client);
    if (!outDir) return;
    const existing = scanExisting(outDir);
    const tables = await withProgress(`Loading tables from ${client.envName || client.orgHost}`, () => this.serviceFor(client).tables());
    if (!tables) return;
    const queued = new Set(this.queue(client).map((e) => e.table));
    const picks = await vscode.window.showQuickPick(
      tables
        .filter((t) => !queued.has(t.logicalName))
        .map((t) => {
          const cls = existing.classes.get(t.logicalName);
          return {
            label: t.displayName || t.logicalName,
            description: t.logicalName,
            detail: cls ? `already a class: ${plural(cls.columns.size, "column")} in ${path.relative(client.dir, cls.file)}` : undefined,
            picked: !!cls,
            t,
          };
        })
        .sort((a, b) => Number(b.picked) - Number(a.picked) || a.label.localeCompare(b.label)),
      { title: "C# classes: add tables to the queue", placeHolder: "Pick tables; you pick each one's columns next.", canPickMany: true, matchOnDescription: true, ignoreFocusOut: true }
    );
    for (const p of picks ?? []) if (!(await this.addTable(client, p.t))) return;
  }

  /**
   * Right-click a column: add it to its table's class right away. The class keeps
   * every column it has; it's created when the table has no class yet. A queued
   * entry for the table gets the column too, so generating later doesn't drop it.
   */
  async addColumn(client: Client, table: TableMeta, column: ColumnMeta): Promise<void> {
    if (!generatable(column)) {
      void vscode.window.showWarningMessage(`${column.logicalName} is a ${column.type} column, which Lantern doesn't generate a property for.`);
      return;
    }
    const outDir = await this.outDir(client);
    if (!outDir) return;
    const existing = scanExisting(outDir);
    const cls = existing.classes.get(table.logicalName);
    if (cls?.sharesFile) {
      void vscode.window.showWarningMessage(`${table.logicalName} is in ${path.relative(client.dir, cls.file)} with other classes. Move it to its own file first; Lantern won't rewrite a shared file.`);
      return;
    }
    const open = "Open";
    if (cls?.columns.has(column.logicalName)) {
      if ((await vscode.window.showInformationMessage(`${cls.className} already has ${column.logicalName}.`, open)) === open) await vscode.window.showTextDocument(vscode.Uri.file(cls.file));
      return;
    }
    const project = owningProject(outDir, client.dir) ?? findPluginProjects(client.dir)[0]?.project;
    let ns = cls?.namespace ?? client.config.csharpClasses.namespace;
    if (!cls && !client.config.csharpClasses.namespace) {
      const asked = await this.askNamespace(client, existing, project);
      if (asked === undefined) return;
      ns = asked;
    }
    const all = await withProgress(`Loading ${table.logicalName}'s columns`, () => this.serviceFor(client).columns(table.logicalName));
    if (!all) return;
    const available = all.filter(generatable);
    const inCode = cls?.columns ?? new Map();
    const columns = available.filter((c) => c.logicalName === table.primaryId || c.logicalName === column.logicalName || inCode.has(c.logicalName));
    const keep = new Set([...inCode.keys()].filter((c) => !available.some((x) => x.logicalName === c)));
    const written = await withProgress(`Adding ${column.logicalName} to ${cls?.className ?? table.schemaName}`, async () => this.write(client, outDir, project, existing, [{ table, columns, keep, existing: cls }], ns ?? ""));
    if (!written) return;
    // A queued entry for this table keeps the column too.
    const entries = this.queue(client);
    const queued = entries.find((e) => e.table === table.logicalName);
    if (queued && !queued.columns.includes(column.logicalName)) {
      queued.columns.push(column.logicalName);
      await this.save(client, entries);
    }
    const [g] = written.generated;
    const note = written.included.length ? ` Added ${path.basename(written.generated[0].file)} to ${path.basename(project!)}.` : "";
    if ((await vscode.window.showInformationMessage(`${cls ? "Added" : "Created"} ${g.className} with ${column.displayName || column.logicalName} (${column.logicalName}) in ${path.relative(client.dir, g.file)}.${note}`, open)) === open) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(g.file));
      const at = doc.getText().indexOf(`[AttributeLogicalName("${column.logicalName}")]`);
      const pos = at >= 0 ? doc.positionAt(at) : new vscode.Position(0, 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    }
  }

  /**
   * For AI assistants (lantern_generate_csharp_classes): tables and columns as a
   * user story names them, matched to metadata and merged with what's in the
   * classes and the queue (nothing is ever removed). Queued by default; written
   * when generate is set. Never asks anything: the agent may be in a terminal.
   */
  async request(
    client: Client,
    items: Array<{ table: string; columns: string[] }>,
    options: { generate?: boolean; namespace?: string } = {}
  ): Promise<string> {
    const projects = findPluginProjects(client.dir);
    const notes: string[] = [];
    if (!client.config.csharpClasses.outDir) {
      client.reload();
      client.config.csharpClasses.outDir = projects[0] ? path.join(path.relative(client.dir, path.dirname(projects[0].project)), "Models") : "Models";
      client.save();
      notes.push(`Output folder set to ${client.config.csharpClasses.outDir} (change csharpClasses.outDir in the tenant configuration to move it).`);
    }
    const outDir = path.resolve(client.dir, client.config.csharpClasses.outDir);
    const existing = scanExisting(outDir);
    const service = this.serviceFor(client);
    const tables = await service.tables();
    const entries = this.queue(client);
    const plan: Array<{ table: TableMeta; columns: ColumnMeta[]; keep: Set<string>; existing?: ExistingClass }> = [];
    const lines: string[] = [];
    for (const item of items) {
      const t = matchName(tables, item.table);
      if (!t.match) {
        lines.push(`- **${item.table}**: no table by that name${t.suggestions.length ? `. Did you mean ${t.suggestions.map((s) => `${s.displayName} (${s.logicalName})`).join(", ")}?` : "."}`);
        continue;
      }
      const table = t.match;
      const cls = existing.classes.get(table.logicalName);
      if (cls?.sharesFile) {
        lines.push(`- **${table.logicalName}**: skipped; its class is in ${path.relative(client.dir, cls.file)} with other classes. Move it to its own file first.`);
        continue;
      }
      const all = await service.columns(table.logicalName);
      const available = all.filter(generatable);
      const added: string[] = [];
      const missing: string[] = [];
      const unsupported: string[] = [];
      const wanted = new Set<string>();
      for (const name of item.columns) {
        const m = matchName(all.filter((c) => !c.attributeOf), name);
        if (!m.match) {
          missing.push(`"${name}"${m.suggestions.length ? ` (did you mean ${m.suggestions.map((s) => s.logicalName).join(", ")}?)` : ""}`);
          continue;
        }
        if (!generatable(m.match)) unsupported.push(`${m.match.logicalName} (${m.match.type})`);
        else wanted.add(m.match.logicalName);
      }
      const inCode = cls?.columns ?? new Map<string, unknown>();
      const queued = entries.find((e) => e.table === table.logicalName);
      const before = new Set([...inCode.keys(), ...(queued?.columns ?? [])]);
      for (const c of wanted) if (!before.has(c) && c !== table.primaryId) added.push(c);
      const keepAll = new Set([...inCode.keys()].filter((c) => !available.some((x) => x.logicalName === c)));
      const columns = available.filter((c) => c.logicalName === table.primaryId || wanted.has(c.logicalName) || before.has(c.logicalName));
      plan.push({ table, columns, keep: keepAll, existing: cls });
      const kept = [...before].filter((c) => c !== table.primaryId && available.some((x) => x.logicalName === c) && !added.includes(c));
      lines.push([
        `- **${table.displayName} (${table.logicalName})**: ${added.length ? `adds ${added.join(", ")}` : "nothing new"}`,
        kept.length ? `; keeps ${kept.join(", ")}` : "",
        missing.length ? `; **not found**: ${missing.join(", ")}` : "",
        unsupported.length ? `; not generated (type Lantern skips): ${unsupported.join(", ")}` : "",
      ].join(""));
    }
    if (!plan.length) return ["Nothing was queued or generated.", "", ...lines, ...notes.map((n) => `\n${n}`)].join("\n");

    const project = owningProject(outDir, client.dir) ?? projects[0]?.project;
    if (options.generate) {
      const rootNamespace = project ? /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/i.exec(fs.readFileSync(project, "utf8"))?.[1] ?? path.basename(project, ".csproj") : client.name.replace(/[^\w.]/g, "");
      const ns = (options.namespace ?? (client.config.csharpClasses.namespace || existing.namespace || `${rootNamespace}.Models`)).trim();
      if (ns && !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(ns)) throw new Error(`"${ns}" isn't a C# namespace.`);
      client.reload();
      if (options.namespace !== undefined) client.config.csharpClasses.namespace = ns;
      client.config.csharpClasses.entities = [...new Set([...client.config.csharpClasses.entities, ...plan.map((p) => p.table.logicalName)])];
      client.save();
      const written = this.write(client, outDir, project, existing, plan, ns);
      // What was queued for these tables is in the files now. Read again: the queue can change while metadata loads.
      await this.save(client, this.queue(client).filter((e) => !plan.some((p) => p.table.logicalName === e.table)));
      return [
        `Generated ${written.generated.length} class${written.generated.length === 1 ? "" : "es"}${ns ? ` in namespace ${ns}` : ""}:`,
        "",
        ...lines,
        "",
        ...written.generated.map((g) => `- ${path.relative(client.dir, g.file)}: ${plural(g.columns + g.kept.length, "column")}`),
        ...(written.included.length ? ["", `Added ${plural(written.included.length, "file")} to ${path.basename(project!)}.`] : []),
        ...notes.map((n) => `\n${n}`),
      ].join("\n");
    }
    const next = this.queue(client);
    for (const p of plan) {
      const entry: QueueEntry = {
        table: p.table.logicalName,
        label: p.table.displayName || p.table.logicalName,
        columns: [p.table.primaryId, ...p.columns.filter((c) => c.logicalName !== p.table.primaryId).map((c) => c.logicalName).sort()],
        keep: [...p.keep],
      };
      const i = next.findIndex((e) => e.table === entry.table);
      if (i >= 0) next[i] = entry;
      else next.push(entry);
    }
    await this.save(client, next.sort((a, b) => a.label.localeCompare(b.label)));
    return [
      `Queued ${plural(plan.length, "table")} for C# classes in ${client.name}. Nothing is written yet: the person reviews the queue from the status bar in VS Code and generates, or call this again with generate: true.`,
      "",
      ...lines,
      ...notes.map((n) => `\n${n}`),
    ].join("\n");
  }

  private async askNamespace(client: Client, existing: ExistingCode, project: string | undefined): Promise<string | undefined> {
    const rootNamespace = project ? /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/i.exec(fs.readFileSync(project, "utf8"))?.[1] ?? path.basename(project, ".csproj") : client.name.replace(/[^\w.]/g, "");
    const ns = await vscode.window.showInputBox({
      title: "C# classes: namespace",
      prompt: "Namespace for the classes. Leave it empty for none.",
      value: client.config.csharpClasses.namespace || existing.namespace || `${rootNamespace}.Models`,
      ignoreFocusOut: true,
      validateInput: (v: string) => (!v.trim() || /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(v.trim()) ? undefined : "Use a C# namespace, like Contoso.Plugins.Models."),
    });
    if (ns === undefined) return undefined;
    client.reload();
    client.config.csharpClasses.namespace = ns.trim();
    client.save();
    return ns.trim();
  }

  /** Writes classes, adds [assembly: ProxyTypesAssembly] once, and lists new files in old-style projects. */
  private write(
    client: Client,
    outDir: string,
    project: string | undefined,
    existing: ExistingCode,
    plan: Array<{ table: TableMeta; columns: ColumnMeta[]; keep: Set<string>; existing?: ExistingClass }>,
    ns: string
  ): { generated: Array<{ className: string; file: string; columns: number; kept: string[] }>; included: string[] } {
    fs.mkdirSync(outDir, { recursive: true });
    const generated: Array<{ className: string; file: string; columns: number; kept: string[] }> = [];
    const source = client.envName ? `${client.envName} (${client.orgHost})` : client.orgHost;
    const classes = plan.map((p) => {
      const g = generateClass(p.table, p.columns, { namespace: ns, existing: p.existing, enums: existing.enums, keep: p.keep, source });
      return { g, file: p.existing?.file ?? path.join(outDir, `${g.className}.cs`), table: p.table.logicalName, isNew: !p.existing };
    });
    // A file by a new class's name that isn't its table's class is code of yours, often the partial class's other half.
    const taken = classes.filter((c) => c.isNew && fs.existsSync(c.file));
    if (taken.length) {
      throw new UserError(`Nothing was written: ${taken.map((c) => `${path.relative(client.dir, c.file)} is already there and isn't the ${c.table} class`).join("; ")}. Lantern won't overwrite it; rename or move the file, then try again.`);
    }
    for (const { g, file } of classes) {
      fs.writeFileSync(file, g.text);
      generated.push({ className: g.className, file, columns: g.columns, kept: g.kept });
    }
    const files = generated.map((g) => g.file);
    if (files.length && project && !hasProxyTypesAttribute(path.dirname(project))) {
      const proxy = path.join(outDir, "ProxyTypesAssembly.cs");
      fs.writeFileSync(proxy, PROXY_TYPES_FILE);
      files.push(proxy);
    }
    return { generated, included: project && files.length ? includeInOldStyleProject(project, files) : [] };
  }

  // ---------- the queue ----------

  /** Review the queue: edit or remove tables, add more, clear it, or generate. */
  async manage(client: Client): Promise<void> {
    for (;;) {
      const entries = this.queue(client);
      type Item = vscode.QuickPickItem & { entry?: QueueEntry; action?: "generate" | "add" | "clear" };
      const items: Item[] = [
        ...(entries.length ? [{ label: GENERATE, description: `write ${plural(entries.length, "class", "classes")}`, action: "generate" as const }] : []),
        ...entries.map((e) => ({
          label: `$(symbol-class) ${e.label}`,
          description: `${e.table} · ${plural(e.columns.length + e.keep.length, "column")}`,
          detail: [...e.columns, ...e.keep].join(", "),
          entry: e,
        })),
        { label: ADD_TABLES, action: "add" as const },
        ...(entries.length ? [{ label: CLEAR, action: "clear" as const }] : []),
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `C# classes queued for ${client.name}`,
        placeHolder: entries.length ? "Pick a table to change its columns or remove it, or Generate." : "Nothing queued yet.",
        matchOnDetail: true,
        ignoreFocusOut: true,
      });
      if (!pick) return;
      if (pick.action === "generate") {
        await this.generate(client);
        return;
      }
      if (pick.action === "add") await this.addTables(client);
      else if (pick.action === "clear") {
        const go = "Clear";
        if ((await vscode.window.showWarningMessage(`Remove all ${plural(entries.length, "table")} from the queue? Nothing is generated or deleted.`, { modal: true }, go)) === go) await this.save(client, []);
      } else if (pick.entry) {
        const entry = pick.entry;
        const what = await vscode.window.showQuickPick([{ label: "$(edit) Edit Columns…", value: "edit" }, { label: "$(trash) Remove from the Queue", value: "remove" }], { title: entry.label });
        if (what?.value === "remove") await this.save(client, this.queue(client).filter((e) => e.table !== entry.table));
        else if (what?.value === "edit") {
          const tables = await withProgress("Loading tables", () => this.serviceFor(client).tables());
          const table = tables?.find((t) => t.logicalName === entry.table);
          if (table) await this.addTable(client, table);
        }
      }
    }
  }

  /** Writes the queued tables' classes, then empties the queue. */
  async generate(client: Client): Promise<void> {
    const entries = this.queue(client);
    if (!entries.length) return;
    const outDir = await this.outDir(client);
    if (!outDir) return;
    const existing = scanExisting(outDir);
    const project = owningProject(outDir, client.dir) ?? findPluginProjects(client.dir)[0]?.project;
    const ns = await this.askNamespace(client, existing, project);
    if (ns === undefined) return;
    client.reload();
    client.config.csharpClasses.entities = [...new Set([...client.config.csharpClasses.entities, ...entries.map((e) => e.table)])];
    client.save();

    const service = this.serviceFor(client);
    const result = await withProgress(`Generating C# classes for ${client.name}`, async (_ctx, progress) => {
      const tables = await service.tables();
      const plan: Array<{ table: TableMeta; columns: ColumnMeta[]; keep: Set<string>; existing?: ExistingClass }> = [];
      const skipped: QueueEntry[] = [];
      const reasons: string[] = [];
      for (const e of entries) {
        const table = tables.find((t) => t.logicalName === e.table);
        const cls = existing.classes.get(e.table);
        if (!table || cls?.sharesFile) {
          skipped.push(e);
          reasons.push(`${e.label} (${!table ? "not in this environment" : `shares ${path.basename(cls!.file)} with other classes`})`);
          continue;
        }
        progress.report({ message: e.label });
        const columns = (await service.columns(e.table)).filter((c) => generatable(c) && e.columns.includes(c.logicalName));
        plan.push({ table, columns, keep: new Set(e.keep), existing: cls });
      }
      return { ...this.write(client, outDir, project, existing, plan, ns), skipped, reasons };
    });
    if (!result) return;
    // Generated tables leave the queue; ones that couldn't be written stay for another try, and so does whatever
    // was queued or changed meanwhile (the namespace prompt and loading metadata take a while; an AI assistant may queue).
    const generated = entries.filter((e) => !result.skipped.includes(e));
    await this.save(client, this.queue(client).filter((e) => !generated.some((g) => sameEntry(g, e))));
    const untouched = untouchedClasses(existing, entries);
    const message = [
      result.generated.length ? `Generated ${result.generated.map((g) => `${g.className} (${plural(g.columns + g.kept.length, "column")})`).join(", ")} in ${path.relative(client.dir, outDir)}.` : "Nothing was generated.",
      result.reasons.length ? `Not generated: ${result.reasons.join("; ")}.` : "",
      untouched.length ? `Left as they were: ${untouched.join(", ")}.` : "",
      result.included.length ? `Added ${plural(result.included.length, "file")} to ${path.basename(project!)}.` : "",
    ].filter(Boolean).join(" ");
    const open = "Open";
    if ((await vscode.window.showInformationMessage(message, ...(result.generated.length ? [open] : []))) === open) await vscode.window.showTextDocument(vscode.Uri.file(result.generated[0].file));
  }
}

/**
 * Above each table class in a C# file (Lantern's or pac's): Edit Columns, to tick and
 * untick the class's columns, and Update from Dataverse. Only where a tenant applies.
 */
export class CSharpClassLens implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const text = doc.getText();
    if (!text.includes("EntityLogicalName") || !(clientForPath(doc.uri.fsPath) ?? activeTenant())?.config.org) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const cls of classesIn(text, doc.uri.fsPath)) {
      const at = doc.positionAt(cls.index);
      const range = new vscode.Range(at, at);
      if (cls.sharesFile) {
        lenses.push(new vscode.CodeLens(range, { title: `$(info) ${cls.table}: shares this file with other classes, so Lantern leaves it alone`, command: "" }));
        continue;
      }
      lenses.push(
        new vscode.CodeLens(range, { title: `$(checklist) Edit Columns (${cls.columns.size})`, tooltip: `Tick or untick ${cls.className}'s columns; the file is rewritten`, command: "lantern.csharpClasses.editColumns", arguments: [doc.uri, cls.table] }),
        new vscode.CodeLens(range, { title: "$(refresh) Update from Dataverse", tooltip: "Regenerate with the same columns: current names, descriptions and choice values", command: "lantern.csharpClasses.refreshClass", arguments: [doc.uri, cls.table] })
      );
    }
    return lenses;
  }
}

const untouchedClasses = (existing: ExistingCode, entries: QueueEntry[]) => [...existing.classes.values()].filter((c) => !entries.some((e) => e.table === c.table)).map((c) => c.className);

/** At the cursor, as a snippet (tab between the variable and the value); copied when no editor is open. */
async function insertSnippet(snippet: vscode.SnippetString, plain: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(plain);
    void vscode.window.showInformationMessage(`No editor open, so ${plain} was copied to the clipboard.`);
    return;
  }
  await editor.insertSnippet(snippet);
}

export function registerCSharpClasses(queue: CSharpClassQueue): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });
  const connected = async (arg: unknown) => {
    const client = await resolveClient(arg);
    if (client && !client.config.org) {
      void vscode.window.showWarningMessage(`Set the org URL for ${client.name} first.`);
      return undefined;
    }
    return client;
  };
  return [
    queue,
    // From a tenant's menu or the Command Palette: the queue, or tables to start one.
    r("lantern.generateCSharpClasses", async (arg?: unknown) => {
      const client = await connected(arg);
      if (client) await queue.manage(client);
    }),
    r("lantern.csharpClasses.queue", async (arg?: unknown) => {
      const client = await connected(arg);
      if (client) await queue.manage(client);
    }),
    // From the CodeLens above a class.
    r("lantern.csharpClasses.editColumns", (uri: vscode.Uri, table: string) => queue.editColumns(uri, table)),
    r("lantern.csharpClasses.refreshClass", (uri: vscode.Uri, table: string) => queue.refreshClass(uri, table)),
    vscode.languages.registerCodeLensProvider({ language: "csharp", scheme: "file" }, new CSharpClassLens()),
    // C# for plug-in code, next to the JavaScript inserts: read, set, a choice value.
    r("lantern.metadata.insertCSharpGet", (node: { kind?: string; client: Client; table: TableMeta; column: ColumnMeta }) => {
      if (node?.kind !== "column") return;
      const field = fieldReference(node.column, queue.classFor(node.client, node.table.logicalName));
      return insertSnippet(new vscode.SnippetString().appendPlaceholder("entity", 1).appendText(`.GetAttributeValue<${csharpTypeOf(node.column)}>(${field})`), `entity.GetAttributeValue<${csharpTypeOf(node.column)}>(${field})`);
    }),
    r("lantern.metadata.insertCSharpSet", (node: { kind?: string; client: Client; table: TableMeta; column: ColumnMeta }) => {
      if (node?.kind !== "column") return;
      const field = fieldReference(node.column, queue.classFor(node.client, node.table.logicalName));
      const value = csharpExampleValue(node.column);
      const comment = value.comment ? ` // ${value.comment}` : "";
      return insertSnippet(
        new vscode.SnippetString().appendPlaceholder("entity", 1).appendText(`[${field}] = `).appendPlaceholder(value.code, 2).appendText(`;${comment}`),
        `entity[${field}] = ${value.code};${comment}`
      );
    }),
    r("lantern.metadata.insertCSharpOption", (node: { kind?: string; value: number; label: string }) => {
      if (node?.kind === "option") return insertSnippet(new vscode.SnippetString().appendText(`new OptionSetValue(${node.value}) /* ${node.label} */`), `new OptionSetValue(${node.value}) /* ${node.label} */`);
    }),
    // From a column: straight into its table's class file.
    r("lantern.metadata.addCSharpProperty", async (node: { kind?: string; client: Client; table: TableMeta; column: ColumnMeta }) => {
      if (node?.kind === "column") await queue.addColumn(node.client, node.table, node.column);
    }),
    // From a table (under a solution: its columns in that solution come picked): pick its columns and queue it.
    r("lantern.metadata.addToCSharpClasses", async (node: { kind?: string; client: Client; table: TableMeta; solution?: string }) => {
      if (node?.kind !== "table") return;
      if (!(await queue.addTable(node.client, node.table, node.solution))) return;
      const n = queue.queue(node.client).length;
      const choice = await vscode.window.showInformationMessage(`${node.table.displayName || node.table.logicalName} is queued for C# classes (${plural(n, "table")} in the queue).`, "Generate Now", "Review Queue");
      if (choice === "Generate Now") await queue.generate(node.client);
      else if (choice === "Review Queue") await queue.manage(node.client);
    }),
  ];
}
