import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { csharpHandler, CustomApiDef, deployCustomApi, newDefinition, typescriptClient, validateDef } from "../core/customapi";
import { findFunction } from "../core/handlers";
import { addHandler, HandlerRequest } from "../core/formRegistration";
import { functionAt, outlineJs } from "../core/codeanalysis";
import { MetadataService } from "../core/metadata";
import { findPluginProjects, resolveWebResourceName } from "../core/solutions";
import { dataverseFor } from "../ui/auth";
import { clientForPath, confirmProtected, reportError, resolveClient, withProgress } from "../ui/context";
import { tableForDocument } from "../ui/metadataLanguage";
import { projectNamespace } from "./scaffold";

const r = (id: string, fn: (...args: any[]) => unknown) =>
  vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      reportError(err);
    }
  });

/** customapis/<name>.json files are Custom API definitions. */
export const isCustomApiFile = (file: string) => /[\\/]customapis[\\/][^\\/]+\.json$/i.test(file);

function readDef(file: string): CustomApiDef {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CustomApiDef;
  } catch (err) {
    throw new Error(`${path.basename(file)} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerCustomApisAndForms(serviceFor: (c: Client) => MetadataService, onFormsChanged: (c: Client, table: string) => void): vscode.Disposable[] {
  return [
    r("lantern.customApi.new", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client) return;
      const uniquename = await vscode.window.showInputBox({
        title: "New Custom API",
        prompt: "Unique name with your publisher prefix",
        placeHolder: "acme_CalculateDiscount",
        validateInput: (v: string) => (/^[a-z0-9]+_\w+$/i.test(v.trim()) ? undefined : "Use prefix_Name, like acme_CalculateDiscount."),
      });
      if (!uniquename) return;
      const binding = await vscode.window.showQuickPick(
        [
          { label: "Global", description: "not tied to a table", value: "global" as const },
          { label: "Bound to a table row", value: "entity" as const },
          { label: "Bound to a table", description: "a collection", value: "entitycollection" as const },
        ],
        { placeHolder: "How is it called?" }
      );
      if (!binding) return;
      let boundEntity: string | undefined;
      if (binding.value !== "global") {
        boundEntity = await vscode.window.showInputBox({ prompt: "Table logical name", placeHolder: "account" });
        if (!boundEntity) return;
      }
      const kind = await vscode.window.showQuickPick(
        [
          { label: "Action", description: "changes data; called with POST", fn: false },
          { label: "Function", description: "only reads; called with GET", fn: true },
        ],
        { placeHolder: "Action or function?" }
      );
      if (!kind) return;
      const file = path.join(client.dir, "customapis", `${uniquename.trim()}.json`);
      if (fs.existsSync(file)) {
        void vscode.window.showWarningMessage(`${path.relative(client.dir, file)} already exists.`);
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const display = uniquename.trim().replace(/^[a-z0-9]+_/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
      fs.writeFileSync(file, JSON.stringify(newDefinition(uniquename.trim(), display, binding.value, boundEntity?.trim(), kind.fn), null, 2) + "\n");
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      void vscode.window.showInformationMessage("Edit the parameters and properties, set \"plugin\" to the class that runs it, then use Deploy above the file.");
    }),

    r("lantern.customApi.deploy", async (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      const client = file ? clientForPath(file) : undefined;
      if (!file || !client?.config.org || !isCustomApiFile(file)) return;
      const def = readDef(file);
      const problems = validateDef(def);
      if (problems.length) {
        void vscode.window.showWarningMessage(`${path.basename(file)}: ${problems.join(" ")}`);
        return;
      }
      let solution: string | undefined;
      if (client.config.solutions.length) {
        const s = await vscode.window.showQuickPick([...client.config.solutions, "(don't add to a solution)"], { placeHolder: "Add it to which solution?" });
        if (s === undefined) return;
        solution = s.startsWith("(") ? undefined : s;
      }
      if (!(await confirmProtected(client, `Deploy ${def.uniquename}`))) return;
      const result = await withProgress(`Deploying ${def.uniquename} to ${client.envName || client.orgHost}`, () => deployCustomApi(dataverseFor(client), def, solution));
      if (!result) return;
      const parts = [result.created ? `Created ${def.uniquename}` : `Updated ${def.uniquename}`, result.added.length ? `added ${result.added.join(", ")}` : ""].filter(Boolean).join("; ");
      if (result.cannotChange.length) {
        void vscode.window.showWarningMessage(`${parts}. ${result.cannotChange.join(", ")} already exist with a different type; Dataverse can't change that in place, so delete them in the maker portal and deploy again.`);
      } else void vscode.window.showInformationMessage(`${parts}.`);
    }),

    r("lantern.customApi.generateCSharp", async (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      const client = file ? clientForPath(file) : undefined;
      if (!file || !client) return;
      const def = readDef(file);
      const projects = findPluginProjects(client.dir);
      if (!projects.length) {
        void vscode.window.showInformationMessage(`${client.name} has no plug-in project to put the handler in. Create one with New Plug-in Project.`);
        return;
      }
      const project = projects.length === 1 ? projects[0] : (await vscode.window.showQuickPick(projects.map((p) => ({ label: p.assembly, p })), { placeHolder: "Which project?" }))?.p;
      if (!project) return;
      const className = def.plugin?.split(".").pop() || def.uniquename.replace(/^[a-z0-9]+_/i, "");
      const target = path.join(path.dirname(project.project), `${className}.cs`);
      if (fs.existsSync(target)) {
        void vscode.window.showWarningMessage(`${path.relative(client.dir, target)} already exists; delete or rename it to regenerate.`);
        return;
      }
      const ns = projectNamespace(project.project);
      fs.writeFileSync(target, csharpHandler(def, ns, className));
      if (!def.plugin) {
        def.plugin = `${ns}.${className}`;
        fs.writeFileSync(file, JSON.stringify(def, null, 2) + "\n");
      }
      await vscode.window.showTextDocument(vscode.Uri.file(target));
    }),

    r("lantern.customApi.generateTypeScript", async (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!file) return;
      const def = readDef(file);
      const target = file.replace(/\.json$/i, ".ts");
      fs.writeFileSync(target, typescriptClient(def));
      await vscode.window.showTextDocument(vscode.Uri.file(target));
    }),

    r("lantern.forms.registerHandler", async (uri?: vscode.Uri, fnName?: string) => {
      const editor = vscode.window.activeTextEditor;
      const file = uri?.fsPath ?? editor?.document.uri.fsPath;
      const client = file ? clientForPath(file) : undefined;
      if (!file || !client?.config.org) return;
      const library = resolveWebResourceName(file, client)?.name;
      if (!library) {
        void vscode.window.showWarningMessage(`${path.basename(file)} isn't a web resource Lantern can name. Add its folder to "webResourceRoots" in client.json.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const text = doc.getText();
      const outline = outlineJs(text);
      const fn = fnName ? outline.find((f) => f.name === fnName || f.written === fnName) : editor && editor.document.uri.fsPath === file ? functionAt(outline, editor.document.offsetAt(editor.selection.active)) : undefined;
      const guess = fn ? (fn.written.startsWith("this.") ? fn.name : fn.written) : "";
      const functionName = await vscode.window.showInputBox({
        title: `Register a function from ${library}`,
        prompt: "The name the form calls it by (with its namespace, e.g. Acme.Account.onLoad)",
        value: guess,
        validateInput: (v: string) => (!/^[\w$.]+$/.test(v.trim()) ? "Use a function name." : findFunction(text, v.trim()) ? undefined : `${v.trim()} isn't defined in this file.`),
      });
      if (!functionName) return;
      const st = await tableForDocument(doc, serviceFor, false);
      if (!st) {
        void vscode.window.showWarningMessage("Couldn't tell which table this script is for. Use Set Table for This File first.");
        return;
      }
      const forms = await withProgress(`Loading ${st.table} forms`, () => st.service.forms(st.table));
      if (!forms?.length) return;
      const picked = await vscode.window.showQuickPick(
        forms.map((f) => ({ label: f.name, description: f.type, picked: f.type === "Main", form: f })),
        { canPickMany: true, placeHolder: "Register on which forms?" }
      );
      if (!picked?.length) return;
      const event = await vscode.window.showQuickPick(
        [
          { label: "OnLoad", value: "onload" as const },
          { label: "OnSave", value: "onsave" as const },
          { label: "OnChange of a column", value: "onchange" as const },
        ],
        { placeHolder: "Which event?" }
      );
      if (!event) return;
      let attribute: string | undefined;
      if (event.value === "onchange") {
        const columns = await st.service.columns(st.table);
        const onForms = new Set(picked.flatMap((p: { form: { header: Array<{ field?: string }>; tabs: Array<{ sections: Array<{ controls: Array<{ field?: string }> }> }> } }) => [...p.form.header, ...p.form.tabs.flatMap((t) => t.sections.flatMap((s) => s.controls))].map((c) => c.field).filter(Boolean)));
        const col = await vscode.window.showQuickPick(
          columns.filter((c) => onForms.has(c.logicalName)).map((c) => ({ label: c.displayName || c.logicalName, description: c.logicalName })),
          { placeHolder: "OnChange of which column? (columns on the chosen forms)", matchOnDescription: true }
        );
        if (!col) return;
        attribute = col.description;
      }
      const pass = await vscode.window.showQuickPick([{ label: "Pass the execution context", value: true }, { label: "Don't pass it", value: false }], { placeHolder: "Pass the execution context as the first parameter?" });
      if (!pass) return;
      if (!(await confirmProtected(client, `Change ${picked.length} form${picked.length === 1 ? "" : "s"}`))) return;
      const request: HandlerRequest = { library, functionName: functionName.trim(), event: event.value, attribute, passExecutionContext: pass.value };
      const dv = dataverseFor(client);
      const outcome = await withProgress(`Registering ${request.functionName}`, async () => {
        if (!(await dv.findWebResource(library))) throw new Error(`${library} isn't in ${client.orgHost} yet. Push it first.`);
        const done: string[] = [];
        const already: string[] = [];
        for (const p of picked as Array<{ form: { id: string; name: string } }>) {
          const row = await dv.getJson<{ formxml: string }>(`systemforms(${p.form.id})?$select=formxml`);
          const result = addHandler(row.formxml, request);
          if (result.already) already.push(p.form.name);
          else if (result.changed) {
            await dv.update(`systemforms(${p.form.id})`, { formxml: result.xml });
            done.push(p.form.name);
          }
        }
        if (done.length) await dv.action("PublishXml", { ParameterXml: `<importexportxml><entities><entity>${st.table}</entity></entities></importexportxml>` });
        return { done, already };
      });
      if (!outcome) return;
      st.service.clear(st.table);
      onFormsChanged(client, st.table);
      const label = `${event.label === "OnChange of a column" ? `OnChange of ${attribute}` : event.label}`;
      const parts = [outcome.done.length ? `Registered ${request.functionName} on ${label} of ${outcome.done.join(", ")} and published` : "", outcome.already.length ? `already registered on ${outcome.already.join(", ")}` : ""].filter(Boolean);
      void vscode.window.showInformationMessage(`${parts.join("; ")}.`);
    }),
  ];
}
