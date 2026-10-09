import * as vscode from "vscode";
import { Client } from "../core/clients";
import { MetadataService, TableMeta } from "../core/metadata";
import { clientForQuery, isFetchXml } from "../commands/query";
import { columnMarkdown } from "./metadataTree";

const OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge", "like", "not-like", "in", "not-in", "null", "not-null", "between", "not-between",
  "begins-with", "ends-with", "on", "on-or-after", "on-or-before", "today", "yesterday", "this-week", "this-month", "this-year",
  "last-x-days", "next-x-days", "eq-userid", "ne-userid", "eq-businessid", "above", "under", "contain-values", "not-contain-values"];

/**
 * The entity a FetchXML position sits in: the nearest open <entity> or <link-entity>,
 * and that element's parent (for link-entity "to", which names a parent column).
 */
export function entityContext(textBefore: string): { current?: string; parent?: string } {
  const stack: string[] = [];
  const re = /<(\/?)(entity|link-entity)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textBefore))) {
    if (m[1]) stack.pop();
    else if (!m[4]) stack.push(/name\s*=\s*["']([\w]+)["']/.exec(m[3])?.[1] ?? "");
  }
  // The tag being typed right now, if it's an opening entity/link-entity tag.
  const open = /<(link-entity|entity)\b([^>]*)$/.exec(textBefore);
  if (open) return { current: /name\s*=\s*["']([\w]+)["']/.exec(open[2])?.[1], parent: stack[stack.length - 1] };
  return { current: stack[stack.length - 1], parent: stack[stack.length - 2] };
}

/** Table and column names inside FetchXML: entity/link-entity names, attribute/condition/order columns, from/to, operators. */
export class FetchXmlCompletions implements vscode.CompletionItemProvider {
  constructor(private readonly serviceFor: (c: Client) => MetadataService) {}

  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const text = doc.getText();
    if (!isFetchXml(text)) return undefined;
    const client = clientForQuery(doc);
    if (!client?.config.org) return undefined;
    const before = text.slice(0, doc.offsetAt(position));
    const m = /<([\w-]+)\b[^<>]*?\b([\w-]+)\s*=\s*["']([\w-]*)$/.exec(before);
    if (!m) return undefined;
    const [, tag, attr, typed] = m;
    const range = new vscode.Range(position.line, position.character - typed.length, position.line, position.character);
    const svc = this.serviceFor(client);
    const tables = await svc.tables({ silent: true }).catch(() => undefined);
    if (!tables) return undefined;

    if ((tag === "entity" || tag === "link-entity") && attr === "name") return tables.map((t) => tableItem(t, range));
    if (attr === "operator") {
      return OPERATORS.map((op) => {
        const item = new vscode.CompletionItem(op, vscode.CompletionItemKind.Operator);
        item.range = range;
        return item;
      });
    }
    const ctx = entityContext(before);
    let table: string | undefined;
    if (tag === "link-entity" && attr === "to") table = ctx.parent;
    else if (tag === "link-entity" && attr === "from") table = ctx.current;
    else if (["attribute", "order", "condition"].includes(tag) && ["name", "attribute"].includes(attr)) {
      const entityName = /\bentityname\s*=\s*["']([\w]+)["']/.exec(m[0])?.[1];
      table = entityName ? aliasTable(before, entityName) ?? ctx.current : ctx.current;
    }
    if (!table) return undefined;
    const columns = await svc.columns(table, { silent: true }).catch(() => []);
    return columns
      .filter((c) => !c.attributeOf)
      .map((c) => {
        const item = new vscode.CompletionItem({ label: c.logicalName, description: c.displayName }, vscode.CompletionItemKind.Field);
        item.range = range;
        item.detail = `${c.displayName || c.logicalName} · ${c.type} (${table})`;
        item.documentation = columnMarkdown(c);
        item.filterText = `${c.logicalName} ${c.displayName.replace(/\s+/g, "")}`;
        return item;
      });
  }
}

function tableItem(t: TableMeta, range: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem({ label: t.logicalName, description: t.displayName }, vscode.CompletionItemKind.Struct);
  item.range = range;
  item.filterText = `${t.logicalName} ${t.displayName.replace(/\s+/g, "")}`;
  item.sortText = (t.isCustom ? "0" : "1") + t.logicalName;
  return item;
}

/** Table of a link-entity alias, for conditions with entityname="alias". */
function aliasTable(text: string, alias: string): string | undefined {
  const re = /<link-entity\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (new RegExp(`\\balias\\s*=\\s*["']${alias}["']`).test(m[1])) return /\bname\s*=\s*["']([\w]+)["']/.exec(m[1])?.[1];
  }
  return undefined;
}
