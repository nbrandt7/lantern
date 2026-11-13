import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client, pascalCase } from "../core/clients";
import { UserError } from "../core/errors";
import { ColumnMeta, MetadataService, solutionColumnNames, TableMeta } from "../core/metadata";
import { generateModel, modelable, readModel, ScriptLanguage } from "../core/scriptModels";
import { clientForPath, reportError, withProgress } from "../ui/context";
import { activeTenant } from "../ui/tenantContext";
import { tsconfigFor } from "./typescript";
import { ColumnItem, openColumnPicker, PickerField } from "../ui/panels/columnPickerPanel";

/**
 * JavaScript and TypeScript table models: right-click a table for Add to Script
 * Model… (pick its columns), a column for Add Script Model Property, and the
 * CodeLens above a model for Edit Columns and Update from Dataverse. The model's
 * own header lists its columns, so they come pre-picked and nothing is lost.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class ScriptModels {
  constructor(private readonly serviceFor: (c: Client) => MetadataService) {}

  /** Folder, language and namespace: asked the first time, then kept in the tenant configuration. */
  private async settings(client: Client): Promise<{ outDir: string; language: ScriptLanguage; namespace: string } | undefined> {
    const s = client.config.scriptModels;
    if (!s.outDir) {
      const root = client.config.webResourceRoots[0];
      const outDir = await vscode.window.showInputBox({
        title: "Script models: folder",
        prompt: `Folder for the model files, relative to ${client.name}/. Inside your web resources, so they're pushed like any script.`,
        value: path.join(root || "WebResources", "models"),
        ignoreFocusOut: true,
      });
      if (!outDir?.trim()) return undefined;
      s.outDir = outDir.trim();
    }
    const outDir = path.resolve(client.dir, s.outDir);
    if (!s.language) {
      const hasTsconfig = !!tsconfigFor(path.join(outDir, "model.ts"), client.dir);
      const pick = await vscode.window.showQuickPick(
        [
          { label: "TypeScript", description: hasTsconfig ? "this folder has a tsconfig.json" : "with a row interface for Xrm.WebApi results", value: "ts" as const },
          { label: "JavaScript", description: "plain scripts, no build step", value: "js" as const },
        ].sort((a, b) => Number(b.value === (hasTsconfig ? "ts" : "js")) - Number(a.value === (hasTsconfig ? "ts" : "js"))),
        { title: "Script models: language" }
      );
      if (!pick) return undefined;
      s.language = pick.value;
    }
    if (!s.namespace) {
      const ns = await vscode.window.showInputBox({
        title: "Script models: namespace",
        prompt: "The global object the models go on, like your form scripts' namespace.",
        value: `${client.config.scriptNamespace || pascalCase(client.name)}.Models`,
        ignoreFocusOut: true,
        validateInput: (v: string) => (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(v.trim()) ? undefined : "Use a dotted name, like Contoso.Models."),
      });
      if (!ns?.trim()) return undefined;
      s.namespace = ns.trim();
    }
    client.save();
    return { outDir, language: s.language, namespace: s.namespace };
  }

  private fileFor(outDir: string, language: ScriptLanguage, table: string): string {
    return path.join(outDir, `${table}.${language}`);
  }

  /** The settings the picker asks for on its page while they're not set yet: folder, language, namespace. */
  private settingsFields(client: Client): Record<string, PickerField> {
    const s = client.config.scriptModels;
    const fields: Record<string, PickerField> = {};
    if (!s.outDir) {
      const root = client.config.webResourceRoots[0];
      fields.outDir = { label: "Folder", value: path.join(root || "WebResources", "models"), required: true, hint: `Folder for the model files, relative to ${client.name}/. Inside your web resources, so they're pushed like any script. Asked once.` };
    }
    if (!s.language) {
      const hasTsconfig = !!tsconfigFor(path.join(path.resolve(client.dir, s.outDir || fields.outDir?.value || "WebResources/models"), "model.ts"), client.dir);
      fields.language = {
        label: "Language",
        value: hasTsconfig ? "ts" : "js",
        hint: "TypeScript gets a row interface for Xrm.WebApi results; JavaScript is a plain script with no build step.",
        options: [
          { value: "ts", label: "TypeScript", description: hasTsconfig ? "this folder has a tsconfig.json" : "with a row interface for Xrm.WebApi results" },
          { value: "js", label: "JavaScript", description: "plain scripts, no build step" },
        ],
      };
    }
    if (!s.namespace) {
      fields.namespace = { label: "Namespace", value: `${client.config.scriptNamespace || pascalCase(client.name)}.Models`, required: true, hint: "The global object the models go on, like your form scripts' namespace.", pattern: "^[A-Za-z_$][\\w$]*(\\.[A-Za-z_$][\\w$]*)*$", patternText: "Use a dotted name, like Contoso.Models." };
    }
    return fields;
  }

  /**
   * The column picker (src/ui/panels/columnPickerPanel.ts). Ticked to start with: the
   * model's columns, plus, from a table under a solution, that solution's columns of
   * it; just the primary name otherwise. The folder, language and namespace are on
   * the same page while they're not set yet.
   */
  private async pick(client: Client, table: TableMeta, current: string[] | undefined, solution?: string, fields: Record<string, PickerField> = {}): Promise<{ columns: ColumnMeta[]; keep: string[]; fields: Record<string, string> } | undefined> {
    const loaded = await withProgress(`Loading ${table.logicalName}'s columns`, async () => ({
      all: await this.serviceFor(client).columns(table.logicalName),
      inSolution: solution ? await solutionColumnNames(this.serviceFor(client), table, solution) : undefined,
    }));
    if (!loaded) return undefined;
    const available = loaded.all.filter(modelable);
    const inModel = new Set(current ?? []);
    const inSolution = loaded.inSolution?.names ?? new Set<string>();
    const gone = [...inModel].filter((c) => c !== table.primaryId && !available.some((x) => x.logicalName === c));
    const startPicked = (c: string) => inModel.has(c) || inSolution.has(c) || (!current && !inSolution.size && c === table.primaryName);
    const groupOrder = (group: string) => (group === "Custom columns" ? 0 : group === "Standard columns" ? 1 : 2);
    const items: ColumnItem[] = [
      ...available
        .filter((c) => c.logicalName !== table.primaryId)
        .map((c) => ({
          id: c.logicalName,
          label: c.displayName || c.logicalName,
          meta: `${c.logicalName} · ${c.type}`,
          group: c.isCustom ? "Custom columns" : "Standard columns",
          tags: [inModel.has(c.logicalName) ? "in the model" : "", inSolution.has(c.logicalName) ? `in ${solution}` : ""].filter(Boolean),
          picked: startPicked(c.logicalName),
          title: c.description || undefined,
        })),
      ...gone.map((c) => ({ id: c, label: c, meta: "kept by name", group: "Only in the model", tags: ["not in Dataverse"], picked: true })),
    ].sort((x, y) => groupOrder(x.group) - groupOrder(y.group) || x.label.localeCompare(y.label));
    const notes = [
      current ? "What's in the model is ticked: untick to take one out." : "",
      inSolution.size ? `${solution}'s columns are ticked.` : "",
      loaded.inSolution?.everything ? `${solution} has the whole table, so its columns aren't ticked.` : "",
      "Pick the columns your scripts use.",
    ].filter(Boolean);
    const result = await openColumnPicker(current ? "Edit Script Model Columns" : "Add to Script Model", current ? "Save" : "Create", {
      subtitle: `${table.displayName || table.logicalName} (${table.logicalName}) in ${client.envName || client.orgHost}`,
      table: { logical: table.logicalName, label: table.displayName || table.logicalName, primaryId: table.primaryId },
      fields,
      items,
      notes,
      draft: { picked: items.filter((i) => i.picked).map((i) => i.id), fields: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value])) },
    });
    if (!result) return undefined;
    const chosen = new Set(result.picked);
    return { columns: available.filter((c) => chosen.has(c.logicalName)), keep: gone.filter((c) => chosen.has(c)), fields: result.fields };
  }

  /** The folder can be a scripts folder, where account.js is the account form's script: that's never overwritten. */
  private refuseNonModel(client: Client, file: string): void {
    if (fs.existsSync(file) && !readModel(fs.readFileSync(file, "utf8"))) {
      throw new UserError(`${path.relative(client.dir, file)} is already there and isn't a Lantern script model, so Lantern won't overwrite it. Rename or move it, or set scriptModels.outDir in the tenant configuration to another folder.`);
    }
  }

  private write(client: Client, file: string, table: TableMeta, columns: ColumnMeta[], keep: string[], language: ScriptLanguage, namespace: string): void {
    this.refuseNonModel(client, file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generateModel(table, columns, { language, namespace, keep, source: client.envName ? `${client.envName} (${client.orgHost})` : client.orgHost }));
  }

  private async open(file: string, column?: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const at = column ? doc.getText().search(new RegExp(`^\\s*"?${column}"?: "${column}",`, "m")) : -1;
    const pos = at >= 0 ? doc.positionAt(at) : new vscode.Position(0, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
  }

  /** Right-click a table: pick its columns (and, the first time, the folder, language and namespace) and write the model now. */
  async addTable(client: Client, table: TableMeta, solution?: string): Promise<void> {
    const fields = this.settingsFields(client);
    const configured = client.config.scriptModels;
    const known = configured.outDir && configured.language ? { outDir: path.resolve(client.dir, configured.outDir), language: configured.language } : undefined;
    const knownFile = known ? this.fileFor(known.outDir, known.language, table.logicalName) : undefined;
    if (knownFile) this.refuseNonModel(client, knownFile);
    const current = knownFile && fs.existsSync(knownFile) ? readModel(fs.readFileSync(knownFile, "utf8"))?.columns : undefined;
    const choice = await this.pick(client, table, current, solution, fields);
    if (!choice) return;
    if (Object.keys(fields).length) {
      client.reload();
      const target = client.config.scriptModels;
      if (fields.outDir) target.outDir = choice.fields.outDir.trim();
      if (fields.language) target.language = choice.fields.language === "ts" ? "ts" : "js";
      if (fields.namespace) target.namespace = choice.fields.namespace.trim();
      client.save();
    }
    const s = await this.settings(client);
    if (!s) return;
    const file = this.fileFor(s.outDir, s.language, table.logicalName);
    this.write(client, file, table, choice.columns, choice.keep, s.language, s.namespace);
    const open = "Open";
    if ((await vscode.window.showInformationMessage(`${current ? "Updated" : "Created"} ${path.relative(client.dir, file)} with ${plural(choice.columns.length + choice.keep.length + (choice.columns.some((c) => c.logicalName === table.primaryId) ? 0 : 1), "column")}.`, open)) === open) await this.open(file);
  }

  /** Right-click a column: add it to its table's model now (the model is created when there's none). */
  async addColumn(client: Client, table: TableMeta, column: ColumnMeta): Promise<void> {
    if (!modelable(column)) {
      void vscode.window.showWarningMessage(`${column.logicalName} is a ${column.type} column; script models leave those out.`);
      return;
    }
    const s = await this.settings(client);
    if (!s) return;
    const file = this.fileFor(s.outDir, s.language, table.logicalName);
    this.refuseNonModel(client, file);
    const current = fs.existsSync(file) ? readModel(fs.readFileSync(file, "utf8"))?.columns ?? [] : [];
    const open = "Open";
    if (current.includes(column.logicalName)) {
      if ((await vscode.window.showInformationMessage(`The ${table.logicalName} model already has ${column.logicalName}.`, open)) === open) await this.open(file, column.logicalName);
      return;
    }
    const all = await withProgress(`Loading ${table.logicalName}'s columns`, () => this.serviceFor(client).columns(table.logicalName));
    if (!all) return;
    const available = all.filter(modelable);
    const wanted = new Set([...current, column.logicalName]);
    const keep = current.filter((c) => c !== table.primaryId && !available.some((x) => x.logicalName === c));
    this.write(client, file, table, available.filter((c) => wanted.has(c.logicalName)), keep, s.language, s.namespace);
    if ((await vscode.window.showInformationMessage(`Added ${column.displayName || column.logicalName} (${column.logicalName}) to ${path.relative(client.dir, file)}.`, open)) === open) await this.open(file, column.logicalName);
  }

  /** The tenant, table and model behind a model file, for the CodeLens. Asks to save unsaved edits first. */
  private async modelInFile(uri: vscode.Uri): Promise<{ client: Client; table: TableMeta; columns: string[]; language: ScriptLanguage; namespace: string } | undefined> {
    const client = clientForPath(uri.fsPath) ?? activeTenant();
    if (!client?.config.org) return undefined;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (doc?.isDirty) {
      const save = "Save and Continue";
      if ((await vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} has unsaved changes. Lantern rewrites the file, so save it first.`, { modal: true }, save)) !== save) return undefined;
      await doc.save();
    }
    const text = fs.readFileSync(uri.fsPath, "utf8");
    const model = readModel(text);
    if (!model) return undefined;
    const tables = await withProgress("Loading tables", () => this.serviceFor(client).tables());
    const table = tables?.find((t) => t.logicalName === model.table);
    if (!table) {
      if (tables) void vscode.window.showWarningMessage(`${model.table} isn't a table in ${client.envName || client.orgHost}.`);
      return undefined;
    }
    const language: ScriptLanguage = uri.fsPath.toLowerCase().endsWith(".ts") ? "ts" : "js";
    const namespace = (language === "ts" ? /^namespace\s+([\w$.]+)/m.exec(text)?.[1] : /^([\w$.]+)\.[\w$]+ = class [\w$]+ \{/m.exec(text)?.[1]) ?? client.config.scriptModels.namespace;
    return { client, table, columns: model.columns, language, namespace };
  }

  async editColumns(uri: vscode.Uri): Promise<void> {
    const m = await this.modelInFile(uri);
    if (!m) return;
    const choice = await this.pick(m.client, m.table, m.columns);
    if (!choice) return;
    const after = new Set([m.table.primaryId, ...choice.columns.map((c) => c.logicalName), ...choice.keep]);
    const added = [...after].filter((c) => !m.columns.includes(c));
    const removed = m.columns.filter((c) => !after.has(c));
    if (!added.length && !removed.length) {
      void vscode.window.showInformationMessage(`No change to the ${m.table.logicalName} model.`);
      return;
    }
    this.write(m.client, uri.fsPath, m.table, choice.columns, choice.keep, m.language, m.namespace);
    vscode.window.setStatusBarMessage(`$(symbol-class) ${m.table.logicalName} model: ${[added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}`, 6000);
  }

  async refresh(uri: vscode.Uri): Promise<void> {
    const m = await this.modelInFile(uri);
    if (!m) return;
    const all = await withProgress(`Updating the ${m.table.logicalName} model`, () => this.serviceFor(m.client).columns(m.table.logicalName));
    if (!all) return;
    const available = all.filter(modelable);
    const keep = m.columns.filter((c) => c !== m.table.primaryId && !available.some((x) => x.logicalName === c));
    this.write(m.client, uri.fsPath, m.table, available.filter((c) => m.columns.includes(c.logicalName)), keep, m.language, m.namespace);
    vscode.window.setStatusBarMessage(`$(refresh) ${m.table.logicalName} model updated${keep.length ? `; kept by name (not in Dataverse): ${keep.join(", ")}` : ""}`, 6000);
  }
}

/** Above a model's object: Edit Columns and Update from Dataverse. */
export class ScriptModelLens implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const text = doc.getText();
    const model = readModel(text);
    if (!model || !(clientForPath(doc.uri.fsPath) ?? activeTenant())?.config.org) return [];
    const at = text.search(new RegExp(`(export const ${model.table} = \\{|\\.${model.table} = Object\\.freeze\\()`));
    const pos = doc.positionAt(Math.max(0, at));
    const range = new vscode.Range(pos, pos);
    return [
      new vscode.CodeLens(range, { title: `$(checklist) Edit Columns (${model.columns.length})`, tooltip: "Tick or untick the model's columns; the file is rewritten", command: "lantern.scriptModels.editColumns", arguments: [doc.uri] }),
      new vscode.CodeLens(range, { title: "$(refresh) Update from Dataverse", tooltip: "Regenerate with the same columns: current labels and choice values", command: "lantern.scriptModels.refresh", arguments: [doc.uri] }),
    ];
  }
}

export function registerScriptModels(serviceFor: (c: Client) => MetadataService): vscode.Disposable[] {
  const models = new ScriptModels(serviceFor);
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });
  return [
    r("lantern.metadata.addToScriptModel", (node: { kind?: string; client: Client; table: TableMeta; solution?: string }) => (node?.kind === "table" ? models.addTable(node.client, node.table, node.solution) : undefined)),
    r("lantern.metadata.addScriptModelProperty", (node: { kind?: string; client: Client; table: TableMeta; column: ColumnMeta }) => (node?.kind === "column" ? models.addColumn(node.client, node.table, node.column) : undefined)),
    r("lantern.scriptModels.editColumns", (uri: vscode.Uri) => models.editColumns(uri)),
    r("lantern.scriptModels.refresh", (uri: vscode.Uri) => models.refresh(uri)),
    vscode.languages.registerCodeLensProvider([{ language: "javascript", scheme: "file" }, { language: "typescript", scheme: "file" }], new ScriptModelLens()),
  ];
}
