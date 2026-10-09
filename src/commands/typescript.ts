import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { UserError } from "../core/errors";
import { writeJson } from "../core/files";
import { run } from "../core/process";
import { findSolutionFolders } from "../core/solutions";
import { clientForPath, reportError, resolveClient, settings, withProgress, workspaceRoots, write } from "../ui/context";

/** Nearest tsconfig.json from the file's folder up to the client folder. */
export function tsconfigFor(file: string, clientDir: string): string | undefined {
  let dir = path.dirname(file);
  while (dir.startsWith(clientDir)) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** tsconfig.json allows comments and trailing commas. */
function readTsconfig(file: string): { compilerOptions?: { outDir?: string; rootDir?: string; outFile?: string } } {
  const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

/** The .js file tsc writes for a .ts file under a tsconfig. */
export function outputFor(tsconfig: string, file: string): string | undefined {
  const dir = path.dirname(tsconfig);
  const o = readTsconfig(tsconfig).compilerOptions ?? {};
  if (o.outFile) return path.resolve(dir, o.outFile);
  if (!o.outDir) return file.replace(/\.ts$/i, ".js");
  const root = path.resolve(dir, o.rootDir ?? ".");
  return path.join(path.resolve(dir, o.outDir), path.relative(root, file)).replace(/\.ts$/i, ".js");
}

async function tsc(tsconfig: string, client: Client): Promise<void> {
  const bin = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const candidates = [client.dir, ...workspaceRoots()].map((d) => path.join(d, "node_modules", ".bin", bin)).filter((p) => fs.existsSync(p));
  const exe = candidates[0] ?? "tsc";
  write(`> ${exe} -p ${tsconfig}\n`);
  const r = await run(exe, ["-p", tsconfig], { onOutput: write });
  if (r.missing) throw new UserError('TypeScript isn\'t installed. Run "npm install -D typescript" in the workspace folder.');
  if (r.code !== 0) throw new UserError("TypeScript reported errors (see the Problems panel or the Lantern output). Nothing was pushed.");
}

/** Compiles the project a .ts file belongs to, then pushes that file's .js output. */
export async function compileAndPush(file: string, push: boolean): Promise<void> {
  const client = clientForPath(file);
  if (!client) return;
  const config = tsconfigFor(file, client.dir);
  if (!config) throw new UserError(`No tsconfig.json between ${path.basename(file)} and the client folder. Run "Set Up TypeScript Web Resources" first.`);
  const out = outputFor(config, file);
  const ok = await withProgress(`Compiling ${path.basename(file)}`, async () => {
    await tsc(config, client);
    return true;
  });
  if (!ok || !out) return;
  if (!fs.existsSync(out)) throw new UserError(`Compiled, but ${path.relative(client.dir, out)} wasn't written. Check outDir and rootDir in tsconfig.json.`);
  if (push) await vscode.commands.executeCommand("lantern.pushWebResource", vscode.Uri.file(out));
  else vscode.window.setStatusBarMessage(`$(check) Compiled ${path.basename(out)}`, 4000);
}

export function registerTypeScript(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("lantern.typescript.compileAndPush", async (uri?: vscode.Uri) => {
      try {
        const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (file?.endsWith(".ts")) await compileAndPush(file, true);
      } catch (err) {
        reportError(err);
      }
    }),
    vscode.commands.registerCommand("lantern.typescript.setup", async (arg?: unknown) => {
      try {
        const client = await resolveClient(arg);
        if (client) await setup(client);
      } catch (err) {
        reportError(err);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
      if (doc.uri.scheme !== "file" || !doc.uri.fsPath.endsWith(".ts") || doc.uri.fsPath.endsWith(".d.ts")) return;
      const client = clientForPath(doc.uri.fsPath);
      if (!client || !tsconfigFor(doc.uri.fsPath, client.dir)) return;
      try {
        await compileAndPush(doc.uri.fsPath, settings().typescriptPushOnSave && !!client.config.org);
      } catch (err) {
        reportError(err);
      }
    }),
  ];
}

/** A ts folder with a tsconfig that compiles into a web resources folder, typed with @types/xrm. */
async function setup(client: Client): Promise<void> {
  const tsDir = path.join(client.dir, "ts");
  if (fs.existsSync(path.join(tsDir, "tsconfig.json"))) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(tsDir, "tsconfig.json")));
    return;
  }
  const guess = findSolutionFolders(client.dir).map((f) => path.join(f, "src", "WebResources")).find((p) => fs.existsSync(p)) ?? client.dir;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    defaultUri: vscode.Uri.file(guess),
    openLabel: "Compile into this folder",
    title: "Where should compiled .js files go? (a web resources folder)",
  });
  if (!picked?.[0]) return;
  fs.mkdirSync(tsDir, { recursive: true });
  const outDir = path.relative(tsDir, picked[0].fsPath).split(path.sep).join("/") || ".";
  writeJson(path.join(tsDir, "tsconfig.json"), {
    compilerOptions: { target: "ES2017", module: "none", lib: ["ES2017", "DOM"], types: ["xrm"], rootDir: ".", outDir, strict: true, removeComments: false },
    include: ["**/*.ts"],
  });
  void vscode.window.showInformationMessage(
    `Created ts/tsconfig.json. TypeScript files in ${client.name}/ts compile into ${path.relative(client.dir, picked[0].fsPath) || "."} on save${settings().typescriptPushOnSave ? " and push to Dataverse" : ""}.`
  );
}
