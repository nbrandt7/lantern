import * as path from "path";
import * as vscode from "vscode";
import { encodeLiteral, FetchLiteral, fillPlaceholders, findFetchLiterals, placeholders } from "../core/fetchInCode";
import { fetchXmlStart } from "../core/query";
import { clientForPath, reportError } from "../ui/context";

const languageOf = (file: string): "js" | "cs" | undefined => (/\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(file) ? "js" : /\.cs$/i.test(file) ? "cs" : undefined);

/** Where an "edit as query" document came from, for writing it back. */
interface Origin {
  file: string;
  language: "js" | "cs";
  kind: FetchLiteral["kind"];
  /** The FetchXML as it was in the code when the query was opened (or last written back). */
  text: string;
}
const origins = new Map<string, Origin>();

export function originOf(doc: vscode.TextDocument): Origin | undefined {
  return origins.get(doc.uri.toString());
}

/** FetchXML literals in a code file, if it's JS/TS/C#. */
export function fetchLiteralsIn(doc: vscode.TextDocument): FetchLiteral[] {
  const language = languageOf(doc.uri.fsPath);
  return language ? findFetchLiterals(doc.getText(), language) : [];
}

/** Asks for a value for each placeholder (${id}, {0}, {{expr}}...). Undefined if cancelled. */
export async function fillIn(text: string, lit?: FetchLiteral): Promise<string | undefined> {
  const tokens = placeholders(lit ?? { text, kind: "double", start: 0, end: 0, concatenated: false, line: 0 });
  const values: Record<string, string> = {};
  for (const token of tokens) {
    const value = await vscode.window.showInputBox({
      title: "Run FetchXML from code",
      prompt: `Value for ${token}`,
      ignoreFocusOut: true,
    });
    if (value === undefined) return undefined;
    values[token] = value;
  }
  return fillPlaceholders(text, values);
}

export function registerFetchInCode(): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });
  const open = async (uri: vscode.Uri, index: number) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lit = fetchLiteralsIn(doc)[index];
    const client = clientForPath(uri.fsPath);
    return { doc, lit, client };
  };
  return [
    r("lantern.fetchxml.runInCode", async (uri: vscode.Uri, index: number) => {
      const { lit, client } = await open(uri, index);
      if (!lit || !client) return;
      const filled = await fillIn(lit.text, lit);
      if (filled === undefined) return;
      const header = `<!-- Dataverse: ${client.name} -->\n<!-- From ${path.basename(uri.fsPath)} line ${lit.line + 1}, with the values you entered. -->\n`;
      const doc = await vscode.workspace.openTextDocument({ language: "xml", content: header + filled.trim() + "\n" });
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("lantern.query.run", doc.uri);
    }),

    r("lantern.fetchxml.editInCode", async (uri: vscode.Uri, index: number) => {
      const { lit, client } = await open(uri, index);
      const language = languageOf(uri.fsPath);
      if (!lit || !client || !language) return;
      const header = `<!-- Dataverse: ${client.name} -->\n<!-- From ${path.basename(uri.fsPath)} line ${lit.line + 1}. Edit it here, then use "Write Back" above. Placeholders for values from your code stay as they are. -->\n`;
      const doc = await vscode.workspace.openTextDocument({ language: "xml", content: header + lit.text.trim() + "\n" });
      origins.set(doc.uri.toString(), { file: uri.fsPath, language, kind: lit.kind, text: lit.text });
      await vscode.window.showTextDocument(doc);
    }),

    r("lantern.fetchxml.writeBack", async (docUri?: vscode.Uri) => {
      const doc = docUri ? await vscode.workspace.openTextDocument(docUri) : vscode.window.activeTextEditor?.document;
      const origin = doc ? originOf(doc) : undefined;
      if (!doc || !origin) {
        void vscode.window.showInformationMessage("This query wasn't opened from code, so there's nowhere to write it back to.");
        return;
      }
      const edited = doc.getText().slice(Math.max(0, fetchXmlStart(doc.getText()))).trim();
      const source = await vscode.workspace.openTextDocument(vscode.Uri.file(origin.file));
      // ${x} and "..." + x + "..." are the same placeholder, so compare in one form.
      const same = (a: string) => a.trim().replace(/\$\{([^}]+)\}/g, "{{$1}}");
      const lit = findFetchLiterals(source.getText(), origin.language).find((l) => same(l.text) === same(origin.text));
      if (!lit) {
        void vscode.window.showWarningMessage(`The FetchXML in ${path.basename(origin.file)} changed since you opened it here, so it wasn't overwritten. Open it again from the code.`);
        return;
      }
      // Keep the original's indentation inside multi-line literals.
      const replacement = encodeLiteral(edited, lit.kind, origin.language);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(source.uri, new vscode.Range(source.positionAt(lit.start), source.positionAt(lit.end)), replacement);
      if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage(`Couldn't update ${path.basename(origin.file)}.`);
        return;
      }
      origin.text = edited;
      // JavaScript is written back as a template literal from now on.
      if (origin.language === "js") origin.kind = "template";
      await vscode.window.showTextDocument(source, { selection: new vscode.Range(source.positionAt(lit.start), source.positionAt(lit.start)) });
      vscode.window.setStatusBarMessage(`$(check) Wrote the FetchXML back to ${path.basename(origin.file)} (not saved yet)`, 5000);
    }),
  ];
}

/** Run / Edit lenses above each FetchXML literal in a code file. */
export function fetchLiteralLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  return fetchLiteralsIn(doc).flatMap((lit, index) => {
    const at = new vscode.Range(lit.line, 0, lit.line, 0);
    return [
      new vscode.CodeLens(at, { title: "$(play) Run FetchXML", command: "lantern.fetchxml.runInCode", arguments: [doc.uri, index] }),
      new vscode.CodeLens(at, { title: "Edit as query", command: "lantern.fetchxml.editInCode", arguments: [doc.uri, index] }),
    ];
  });
}
