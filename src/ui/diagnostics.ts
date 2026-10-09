import * as vscode from "vscode";
import { Client } from "../core/clients";
import { findFunction } from "../core/handlers";
import { maskJs } from "../core/codeanalysis";
import { ColumnMeta, FormMeta, MetadataService } from "../core/metadata";
import { scanRibbonFunctions } from "../core/ribbon";
import { resolveWebResourceName } from "../core/solutions";
import { clientForPath, settings } from "./context";
import { tableForDocument } from "./metadataLanguage";

const Q = `(["'\`])`;

export interface ScriptProblem {
  start: number;
  end: number;
  message: string;
  severity: "error" | "warning";
}

/**
 * Problems Lantern can see in a form script without running it: names that aren't
 * columns of the table, columns and controls that aren't on any form (so getAttribute
 * and getControl return null), unknown tabs and sections, and form handlers whose
 * function the file doesn't define.
 */
export function findScriptProblems(
  source: string,
  table: string,
  columns: ColumnMeta[],
  forms: FormMeta[],
  library?: string
): ScriptProblem[] {
  // Commented-out code doesn't run, so it isn't checked.
  const text = maskJs(source).noComments;
  const problems: ScriptProblem[] = [];
  const allControls = forms.flatMap((f) => [...f.header, ...f.tabs.flatMap((t) => t.sections.flatMap((s) => s.controls))]);
  const onForm = new Set(allControls.map((c) => c.field).filter(Boolean) as string[]);
  const controlIds = new Set(allControls.map((c) => c.id));
  const columnNames = new Set(columns.map((c) => c.logicalName));
  const tabs = new Map<string, Set<string>>();
  for (const f of forms) for (const t of f.tabs) tabs.set(t.name, new Set([...(tabs.get(t.name) ?? []), ...t.sections.map((s) => s.name)]));
  const nameRange = (m: RegExpExecArray, name: string) => {
    const start = m.index + m[0].indexOf(name, m[0].indexOf("(") + 1);
    return { start, end: start + name.length };
  };

  if (columns.length) {
    const re = new RegExp(`\\bgetAttribute\\(\\s*${Q}(\\w+)\\1\\s*\\)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const name = m[2];
      if (!columnNames.has(name)) problems.push({ ...nameRange(m, name), severity: "error", message: `${name} isn't a column of ${table}. getAttribute returns null.` });
      else if (forms.length && !onForm.has(name))
        problems.push({ ...nameRange(m, name), severity: "warning", message: `${name} isn't on any ${table} form, so getAttribute returns null at runtime. Add it to the form (it can be hidden).` });
    }
  }
  if (forms.length) {
    let m: RegExpExecArray | null;
    const ctl = new RegExp(`\\bgetControl\\(\\s*${Q}(\\w+)\\1\\s*\\)`, "g");
    while ((m = ctl.exec(text))) {
      if (!controlIds.has(m[2])) problems.push({ ...nameRange(m, m[2]), severity: "warning", message: `No control named ${m[2]} on any ${table} form, so getControl returns null.` });
    }
    const tabRe = new RegExp(`\\btabs\\.get\\(\\s*${Q}(\\w+)\\1\\s*\\)(?:\\s*(?:\\?\\.|\\.)\\s*sections\\.get\\(\\s*${Q}(\\w+)\\3\\s*\\))?`, "g");
    while ((m = tabRe.exec(text))) {
      const tab = m[2];
      const section = m[4];
      const tabStart = m.index + m[0].indexOf(tab);
      if (!tabs.has(tab)) {
        problems.push({ start: tabStart, end: tabStart + tab.length, severity: "warning", message: `No tab named ${tab} on any ${table} form.` });
      } else if (section && !tabs.get(tab)!.has(section)) {
        const s = m.index + m[0].lastIndexOf(section);
        problems.push({ start: s, end: s + section.length, severity: "warning", message: `Tab ${tab} has no section named ${section} on any ${table} form.` });
      }
    }
    if (library) {
      const missing = new Set<string>();
      for (const f of forms) for (const e of f.events) for (const h of e.handlers) {
        if (h.libraryName.toLowerCase() === library.toLowerCase() && !findFunction(source, h.functionName)) missing.add(`${f.name} (${f.type}) ${e.name}${e.attribute ? ` of ${e.attribute}` : ""} calls ${h.functionName}`);
      }
      for (const what of missing) problems.push({ start: 0, end: 0, severity: "warning", message: `${what}, which isn't defined in this file. That handler fails when the event fires.` });
    }
  }
  return problems;
}

/** Keeps the Problems panel up to date for open form scripts. */
export class ScriptDiagnostics {
  readonly collection = vscode.languages.createDiagnosticCollection("lantern");
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly serviceFor: (c: Client) => MetadataService) {}

  schedule(doc: vscode.TextDocument, delay = 400): void {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.check(doc), delay));
  }

  clear(doc: vscode.TextDocument): void {
    this.collection.delete(doc.uri);
  }

  async check(doc: vscode.TextDocument): Promise<void> {
    if (!settings().diagnostics || doc.uri.scheme !== "file" || !["javascript", "typescript"].includes(doc.languageId)) return;
    const client = clientForPath(doc.uri.fsPath);
    if (!client?.config.org) return;
    const st = await tableForDocument(doc, this.serviceFor, true).catch(() => undefined);
    if (!st) return;
    const [columns, forms] = await Promise.all([
      st.service.columns(st.table, { silent: true }).catch(() => [] as ColumnMeta[]),
      st.service.forms(st.table, { silent: true }).catch(() => [] as FormMeta[]),
    ]);
    if (!columns.length && !forms.length) return;
    const library = resolveWebResourceName(doc.uri.fsPath, client)?.name;
    const text = doc.getText();
    const ribbon = library ? scanRibbonFunctions(client.dir).get(library.toLowerCase()) ?? [] : [];
    const problems = findScriptProblems(text, st.table, columns, forms, library).filter(
      // A handler only the command bar calls isn't a form handler problem.
      (p) => !ribbon.some((r) => p.message.includes(`calls ${r.fn},`))
    );
    this.collection.set(
      doc.uri,
      problems.map((p) => {
        const range = new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end));
        const d = new vscode.Diagnostic(range, p.message, p.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        d.source = "Lantern";
        return d;
      })
    );
  }
}
