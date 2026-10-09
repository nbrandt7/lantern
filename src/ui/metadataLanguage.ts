import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { toPosix } from "../core/files";
import { ColumnMeta, ControlMeta, FormMeta, guessTable, MetadataService, tableFromAnnotation, TableMeta } from "../core/metadata";
import { clientForPath, settings } from "./context";
import { columnMarkdown } from "./metadataTree";

type Target = "column" | "control" | "tab" | "section";

/** What kind of name the string at the cursor is: getAttribute("…"), getControl("…"), tabs.get("…"), sections.get("…"). */
const CONTEXTS: Array<[RegExp, Target]> = [
  [/\bgetAttribute\(\s*$/, "column"],
  [/\bgetControl\(\s*$/, "control"],
  [/\btabs\.get\(\s*$/, "tab"],
  [/\bsections\.get\(\s*$/, "section"],
];

function targetFor(textBeforeQuote: string): Target | undefined {
  return CONTEXTS.find(([re]) => re.test(textBeforeQuote))?.[1];
}

export interface ScriptTable {
  client: Client;
  service: MetadataService;
  table: string;
  /** How the table was decided, for the "which table" status message. */
  source: "client.json" | "annotation" | "file name";
}

/**
 * The table a script works with: an explicit mapping in client.json, then an
 * XrmDefinitelyTyped annotation in the file, then a guess from the file name.
 */
export async function tableForDocument(
  doc: vscode.TextDocument,
  serviceFor: (c: Client) => MetadataService,
  silent: boolean
): Promise<ScriptTable | undefined> {
  if (doc.uri.scheme !== "file") return undefined;
  const client = clientForPath(doc.uri.fsPath);
  if (!client?.config.org) return undefined;
  const service = serviceFor(client);
  const rel = toPosix(path.relative(client.dir, doc.uri.fsPath));
  const mapped = client.config.fileTables[rel];
  if (mapped) return { client, service, table: mapped, source: "client.json" };
  const annotated = tableFromAnnotation(doc.getText());
  if (annotated) return { client, service, table: annotated, source: "annotation" };
  let tables: TableMeta[] | undefined;
  try {
    tables = await service.tables({ silent });
  } catch {
    tables = service.cached<TableMeta[]>("tables");
  }
  const guessed = tables ? guessTable(doc.uri.fsPath, tables) : undefined;
  return guessed ? { client, service, table: guessed, source: "file name" } : undefined;
}

async function safely<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

/** Unique controls across all of a table's forms, with the forms each appears on. */
function controlsAcross(forms: FormMeta[]): Map<string, { control: ControlMeta; forms: string[] }> {
  const map = new Map<string, { control: ControlMeta; forms: string[] }>();
  for (const form of forms) {
    const all = [...form.header, ...form.tabs.flatMap((t) => t.sections.flatMap((s) => s.controls))];
    for (const control of all) {
      const hit = map.get(control.id);
      if (hit) {
        if (!hit.forms.includes(form.name)) hit.forms.push(form.name);
        if (!hit.control.label && control.label) hit.control = control;
      } else map.set(control.id, { control, forms: [form.name] });
    }
  }
  return map;
}

/** Columns that have a control on at least one form (getAttribute returns null for the rest). */
function fieldsOnForms(forms: FormMeta[]): Set<string> {
  return new Set([...controlsAcross(forms).values()].map((x) => x.control.field).filter((f): f is string => !!f));
}

function namedAcross<T extends { name: string; label: string }>(forms: FormMeta[], pick: (f: FormMeta) => T[]): Map<string, { item: T; forms: string[] }> {
  const map = new Map<string, { item: T; forms: string[] }>();
  for (const form of forms) {
    for (const item of pick(form)) {
      if (!item.name) continue;
      const hit = map.get(item.name);
      if (hit) hit.forms.push(form.name);
      else map.set(item.name, { item, forms: [form.name] });
    }
  }
  return map;
}

export class MetadataCompletions implements vscode.CompletionItemProvider {
  constructor(private readonly serviceFor: (c: Client) => MetadataService) {}

  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    if (!settings().metadataCompletions) return undefined;
    const before = doc.lineAt(position.line).text.slice(0, position.character);
    const m = /(["'`])(\w*)$/.exec(before);
    if (!m) return undefined;
    const target = targetFor(before.slice(0, m.index));
    if (!target) return undefined;

    const range = new vscode.Range(position.line, position.character - m[2].length, position.line, position.character);
    const st = await tableForDocument(doc, this.serviceFor, true);
    if (!st) {
      const item = new vscode.CompletionItem("Set the Dataverse table for this file…", vscode.CompletionItemKind.Event);
      item.insertText = "";
      item.range = range;
      item.detail = "Column, control, tab and section names come from that table";
      item.command = { command: "lantern.metadata.setFileTable", title: "Set table", arguments: [doc.uri] };
      return [item];
    }

    const forms = await safely(() => st.service.forms(st.table, { silent: true }));
    if (target === "column") {
      const columns = await safely(() => st.service.columns(st.table, { silent: true }));
      const onForms = forms ? fieldsOnForms(forms) : undefined;
      return (columns ?? []).filter((c) => !c.attributeOf).map((c) => columnItem(c, range, st.table, onForms));
    }
    if (!forms) return undefined;
    if (target === "control") {
      return [...controlsAcross(forms).values()].map(({ control, forms: on }) => controlItem(control, on, range));
    }
    const named =
      target === "tab"
        ? namedAcross(forms, (f) => f.tabs)
        : namedAcross(forms, (f) => f.tabs.flatMap((t) => t.sections));
    return [...named.values()].map(({ item, forms: on }) => {
      const ci = new vscode.CompletionItem({ label: item.name, description: item.label }, vscode.CompletionItemKind.Module);
      ci.range = range;
      ci.detail = `${target === "tab" ? "Tab" : "Section"}: ${item.label || item.name}`;
      ci.documentation = new vscode.MarkdownString(`On ${on.map((f) => `**${f}**`).join(", ")}`);
      ci.filterText = `${item.name} ${item.label}`;
      return ci;
    });
  }
}

/**
 * Columns on a form sort first. Ones on no form are still listed (a script can target
 * another form later) but marked, since getAttribute returns null for them at runtime.
 */
function columnItem(c: ColumnMeta, range: vscode.Range, table: string, onForms?: Set<string>): vscode.CompletionItem {
  const notOnForm = onForms ? !onForms.has(c.logicalName) : false;
  const item = new vscode.CompletionItem(
    { label: c.logicalName, description: notOnForm ? `${c.displayName} · not on a form` : c.displayName },
    vscode.CompletionItemKind.Field
  );
  item.insertText = c.logicalName;
  item.range = range;
  item.detail = `${c.displayName || c.logicalName} · ${c.type}${c.requiredLevel !== "None" ? " · required" : ""} (${table})`;
  const docs = columnMarkdown(c);
  if (notOnForm) docs.appendMarkdown(NOT_ON_FORM);
  item.documentation = docs;
  item.sortText = (notOnForm ? "1" : "0") + c.logicalName;
  // Typing part of the display name ("primary con") also finds the column.
  item.filterText = `${c.logicalName} ${c.displayName.replace(/\s+/g, "")}`;
  return item;
}

function controlItem(c: ControlMeta, forms: string[], range: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem({ label: c.id, description: c.label || c.field }, vscode.CompletionItemKind.Property);
  item.insertText = c.id;
  item.range = range;
  item.detail = c.kind === "composite-part" ? `Part of a composite field (column ${c.field})` : `${c.label || c.id}${c.field ? ` · column ${c.field}` : ""}`;
  item.documentation = new vscode.MarkdownString(`On ${forms.map((f) => `**${f}**`).join(", ")}${c.visible ? "" : "\n\nHidden by default."}`);
  item.filterText = `${c.id} ${c.label.replace(/\s+/g, "")}`;
  item.sortText = (c.kind === "composite-part" ? "1" : c.id.startsWith("header_") ? "2" : "0") + c.id;
  return item;
}

export class MetadataHover implements vscode.HoverProvider {
  constructor(private readonly serviceFor: (c: Client) => MetadataService) {}

  async provideHover(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!settings().metadataCompletions) return undefined;
    const line = doc.lineAt(position.line).text;
    const re = /(["'`])(\w+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const start = m.index + 1;
      const end = start + m[2].length;
      if (position.character < start || position.character > end) continue;
      const target = targetFor(line.slice(0, m.index));
      if (!target) return undefined;
      const st = await tableForDocument(doc, this.serviceFor, true);
      if (!st) return undefined;
      const range = new vscode.Range(position.line, start, position.line, end);
      const name = m[2];

      const forms = await safely(() => st.service.forms(st.table, { silent: true }));
      if (target === "column") {
        const columns = await safely(() => st.service.columns(st.table, { silent: true }));
        if (!columns) return undefined; // not loaded (e.g. not signed in yet): say nothing rather than guess
        const column = columns.find((c) => c.logicalName === name);
        if (!column) return new vscode.Hover(unknown("column", name, st.table), range);
        const md = columnMarkdown(column);
        if (forms && !fieldsOnForms(forms).has(name)) md.appendMarkdown(NOT_ON_FORM);
        return new vscode.Hover(md, range);
      }
      if (!forms) return undefined;
      if (target === "control") {
        const hit = controlsAcross(forms).get(name);
        if (!hit) return new vscode.Hover(unknown("control", name, st.table, "on any of its forms"), range);
        const c = hit.control;
        const column = c.field ? (await safely(() => st.service.columns(st.table, { silent: true })))?.find((x) => x.logicalName === c.field) : undefined;
        const md = new vscode.MarkdownString(
          `**${c.label || c.id}** control${c.kind === "composite-part" ? " (inside a composite field)" : ""}\n\n` +
            `On ${hit.forms.map((f) => `**${f}**`).join(", ")}${c.visible ? "" : " · hidden by default"}\n\n`
        );
        if (column) md.appendMarkdown(`---\n\n${columnMarkdown(column).value}`);
        return new vscode.Hover(md, range);
      }
      const named = target === "tab" ? namedAcross(forms, (f) => f.tabs) : namedAcross(forms, (f) => f.tabs.flatMap((t) => t.sections));
      const hit = named.get(name);
      return new vscode.Hover(
        hit
          ? new vscode.MarkdownString(`**${hit.item.label || name}** ${target}\n\nOn ${hit.forms.map((f) => `**${f}**`).join(", ")}`)
          : unknown(target, name, st.table, "on any of its forms"),
        range
      );
    }
    return undefined;
  }
}

const NOT_ON_FORM =
  "\n\n---\n\n$(warning) **Not on any form of this table.** `getAttribute` returns `null` for it at runtime, " +
  "so calling `.getValue()` on the result throws. Add the column to the form (it can be hidden) to use it in script.";

function unknown(what: string, name: string, table: string, where = ""): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    `$(warning) No ${what} named \`${name}\` ${where ? `${where} ` : ""}in **${table}**. ` +
      `At runtime this returns \`null\`, so calling a method on it throws.`
  );
  md.supportThemeIcons = true;
  return md;
}
