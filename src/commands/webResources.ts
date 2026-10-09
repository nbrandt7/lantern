import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client, pascalCase } from "../core/clients";
import { UserError } from "../core/errors";
import { isTextWebResource, isWebResourceCandidate, resolveWebResourceName, webResourceType } from "../core/solutions";
import { formScript } from "../core/templates";
import { availableForms } from "../core/xdt";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, clientForPath, reportError, settings, withProgress } from "../ui/context";

/** Virtual documents holding Dataverse content for diffs: dataverse-wr:/<client>/<name>?<nonce> */
export class DataverseContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "dataverse-wr";
  private readonly contents = new Map<string, string>();

  set(uri: vscode.Uri, text: string): void {
    this.contents.set(uri.toString(), text);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

/** Files the command applies to: explorer multi-selection, a single URI, or the active editor. */
function targetFiles(arg?: unknown, selection?: unknown): string[] {
  const uris = (Array.isArray(selection) && selection.length ? selection : arg ? [arg] : []) as Array<{ fsPath?: string; resourceUri?: vscode.Uri }>;
  const paths = uris.map((u) => u.fsPath ?? u.resourceUri?.fsPath).filter((p): p is string => !!p);
  if (paths.length) return paths;
  const active = vscode.window.activeTextEditor?.document;
  return active?.uri.scheme === "file" ? [active.uri.fsPath] : [];
}

/** Web resource name for a file, asking to confirm when it's only a guess from the folder layout. */
async function nameFor(file: string, client: Client, quiet = false): Promise<string | undefined> {
  const resolved = resolveWebResourceName(file, client);
  if (resolved?.certain) return resolved.name;
  if (quiet) return undefined;
  return vscode.window.showInputBox({
    title: `Web resource name for ${path.basename(file)}`,
    prompt: 'Unique name in Dataverse, including the publisher prefix. Tip: list your web resource folder in "webResourceRoots" in client.json to skip this.',
    value: resolved?.name ?? path.basename(file),
    ignoreFocusOut: true,
  });
}

/** Push one or more files (explorer multi-select works), publishing once at the end. */
export async function pushWebResources(arg?: unknown, selection?: unknown, options: { quiet?: boolean } = {}): Promise<void> {
  const files = targetFiles(arg, selection);
  if (!files.length) return;
  const client = clientForPath(files[0]);
  if (!client) {
    void vscode.window.showWarningMessage("That file isn't inside a client folder.");
    return;
  }
  const other = files.find((f) => clientForPath(f)?.dir !== client.dir);
  if (other) {
    void vscode.window.showWarningMessage("Push files from one client at a time.");
    return;
  }  if (!(await confirmProtected(client, `Push ${files.length === 1 ? path.basename(files[0]) : `${files.length} web resources`}`))) return;


  const plan: Array<{ file: string; name: string }> = [];
  for (const file of files) {
    if (!isWebResourceCandidate(file, client)) {
      if (!options.quiet) void vscode.window.showWarningMessage(`${path.basename(file)} isn't a web resource file type.`);
      continue;
    }
    const name = await nameFor(file, client, options.quiet);
    if (!name) return;
    plan.push({ file, name });
  }
  if (!plan.length) return;

  // Save dirty editors first so we push what's on screen.
  for (const doc of vscode.workspace.textDocuments) if (doc.isDirty && plan.some((p) => p.file === doc.uri.fsPath)) await doc.save();

  const label = plan.length === 1 ? plan[0].name : `${plan.length} web resources`;
  const pushed = await withProgress(`Pushing ${label} to ${client.orgHost}`, async (ctx, progress) => {
    const dv = dataverseFor(client);
    const ids: string[] = [];
    for (const { file, name } of plan) {
      // Cancelling stops here; what's already pushed still gets published below.
      if (ctx.token?.isCancellationRequested) break;
      progress.report({ message: name });
      const content = fs.readFileSync(file).toString("base64");
      const existing = await dv.findWebResource(name);
      if (existing) {
        await dv.updateWebResource(existing.id, content);
        ctx.log(`Updated ${name}\n`);
        ids.push(existing.id);
      } else {
        const id = await createWebResource(client, file, name, content);
        if (!id) continue;
        ctx.log(`Created ${name}\n`);
        ids.push(id);
      }
    }
    if (settings().publishAfterPush && ids.length) {
      progress.report({ message: "publishing..." });
      await dv.publishWebResources(ids);
    }
    return ids.length;
  }, { quiet: options.quiet });
  if (pushed) {
    const published = settings().publishAfterPush ? " and published" : "";
    const what = pushed === plan.length ? label : `${pushed} of ${plan.length} web resources (the rest were skipped)`;
    vscode.window.setStatusBarMessage(`$(cloud-upload) Pushed${published} ${what}`, 5000);
    if (!options.quiet) void vscode.window.showInformationMessage(`Pushed${published} ${what}.`);
  }
}

async function createWebResource(client: Client, file: string, name: string, content: string): Promise<string | undefined> {
  const type = webResourceType(file);
  if (!type) {
    void vscode.window.showWarningMessage(`${name} doesn't exist in ${client.orgHost}, and ${path.extname(file) || "a file without an extension"} isn't a web resource type Lantern can create. Create it in the maker portal, or give it a .data.xml with its type.`);
    return undefined;
  }
  const create = await vscode.window.showInformationMessage(`${name} doesn't exist in ${client.orgHost}. Create it?`, { modal: true }, "Create");
  if (!create) return undefined;
  const solutions = client.config.solutions;
  const solution = solutions.length
    ? (await vscode.window.showQuickPick([...solutions, "(no solution)"], { placeHolder: "Add it to which solution?" })) ?? undefined
    : undefined;
  if (solutions.length && solution === undefined) return undefined;
  return dataverseFor(client).createWebResource({
    name,
    displayName: path.basename(name),
    type,
    content,
    solution: solution === "(no solution)" ? undefined : solution,
  });
}

export async function compareWebResource(provider: DataverseContentProvider, arg?: unknown): Promise<void> {
  const [file] = targetFiles(arg);
  if (!file) return;
  const client = clientForPath(file);
  if (!client) {
    void vscode.window.showWarningMessage("That file isn't inside a client folder.");
    return;
  }
  if (!isTextWebResource(file)) {
    void vscode.window.showInformationMessage("Only text web resources (JS, HTML, CSS, XML, SVG, RESX) can be compared.");
    return;
  }
  const name = await nameFor(file, client);
  if (!name) return;
  const remote = await withProgress(`Fetching ${name} from ${client.orgHost}`, () => dataverseFor(client).findWebResource(name));
  if (remote === undefined) return;
  if (!remote) {
    void vscode.window.showInformationMessage(`${name} doesn't exist in ${client.orgHost} yet.`);
    return;
  }
  const uri = vscode.Uri.from({
    scheme: DataverseContentProvider.scheme,
    path: `/${client.name}/${name}`,
    query: String(Date.now()),
  });
  provider.set(uri, Buffer.from(remote.content, "base64").toString("utf8"));
  await vscode.commands.executeCommand("vscode.diff", uri, vscode.Uri.file(file), `${path.basename(name)}: Dataverse ↔ Local`);
}

export function onSavePush(doc: vscode.TextDocument): void {
  if (!settings().pushOnSave || doc.uri.scheme !== "file") return;
  const client = clientForPath(doc.uri.fsPath);
  if (!client?.config.org || !isWebResourceCandidate(doc.uri.fsPath, client)) return;
  if (!resolveWebResourceName(doc.uri.fsPath, client)?.certain) return;
  pushWebResources(doc.uri, undefined, { quiet: true }).catch(reportError);
}

/** Creates <entity>.js in a folder with the namespace pattern and JSDoc typing for the client's mode. */
export async function newFormScript(arg?: unknown): Promise<void> {
  const folder = (arg as vscode.Uri | undefined)?.fsPath ?? (vscode.window.activeTextEditor ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath) : undefined);
  if (!folder) return;
  const client = clientForPath(folder);
  if (!client) {
    void vscode.window.showWarningMessage("Pick a folder inside a client folder.");
    return;
  }
  const entity = await vscode.window.showInputBox({
    title: "New form script",
    prompt: "Table logical name",
    placeHolder: "account",
    validateInput: (v: string) => (/^[a-z][a-z0-9_]*$/.test(v.trim()) ? undefined : "Use the lowercase logical name, e.g. account or acme_project."),
  });
  if (!entity) return;

  let formType: string | undefined;
  if (client.typingMode === "xdt") {
    const forms = availableForms(client, entity.trim());
    if (forms.length) {
      const pick = await vscode.window.showQuickPick(forms, { placeHolder: "Which form? (typed IntelliSense for its fields, tabs, and sections)" });
      if (!pick) return;
      const [type, form] = pick.split("/");
      formType = `Form.${entity.trim()}.${type}.${form}`;
    }
  }

  const namespace = client.config.scriptNamespace || pascalCase(client.name);
  const file = path.join(folder, `${entity.trim()}.js`);
  if (fs.existsSync(file)) {
    void vscode.window.showWarningMessage(`${path.basename(file)} already exists here.`);
    return;
  }
  fs.writeFileSync(file, formScript({ namespace, entity: entity.trim(), entityPascal: pascalCase(entity.trim()), formType }));
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}
