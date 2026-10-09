import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { findFiles } from "../core/files";
import { ensureAuth, pagesDownload, pagesList, pagesUpload, pcfInit, pcfPush } from "../core/pac";
import { run } from "../core/process";
import { UserError } from "../core/errors";
import { confirmProtected, reportError, resolveClient, withProgress } from "../ui/context";

export interface PcfControl {
  /** The folder with package.json and the .pcfproj. */
  dir: string;
  name: string;
}

/** PCF controls in a client folder: each ControlManifest.Input.xml, by the project folder around it. */
export function findPcfControls(clientDir: string): PcfControl[] {
  return findFiles(clientDir, (n) => n === "ControlManifest.Input.xml").map((manifest) => {
    const controlDir = path.dirname(manifest);
    const parent = path.dirname(controlDir);
    const dir = fs.existsSync(path.join(parent, "package.json")) ? parent : controlDir;
    const name = /<control\b[^>]*\bconstructor="([^"]+)"/.exec(fs.readFileSync(manifest, "utf8"))?.[1] ?? path.basename(controlDir);
    return { dir, name };
  });
}

/** Downloaded Power Pages sites: folders under the client's pages folder. */
export function findPagesSites(clientDir: string): string[] {
  const root = path.join(clientDir, "pages");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
}

interface SiteInfo {
  id: string;
  modelVersion: 1 | 2;
}

const sitesFile = (clientDir: string) => path.join(clientDir, "pages", "lantern-sites.json");
function readSites(clientDir: string): Record<string, SiteInfo> {
  try {
    return JSON.parse(fs.readFileSync(sitesFile(clientDir), "utf8")) as Record<string, SiteInfo>;
  } catch {
    return {};
  }
}

const r = (id: string, fn: (...args: any[]) => unknown) =>
  vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      reportError(err);
    }
  });

type ControlNode = { client: Client; control: PcfControl };
type SiteNode = { client: Client; dir: string };

export function registerPcfAndPages(onChanged: () => void): vscode.Disposable[] {
  return [
    // ---------- PCF ----------
    r("lantern.pcf.new", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client) return;
      const namespace = await vscode.window.showInputBox({ prompt: "Namespace", value: client.config.scriptNamespace || "Acme", validateInput: (v: string) => (/^[A-Za-z_][\w.]*$/.test(v.trim()) ? undefined : "Letters, digits, dots, and underscores.") });
      if (!namespace) return;
      const name = await vscode.window.showInputBox({ prompt: "Control name", validateInput: (v: string) => (/^[A-Za-z_]\w*$/.test(v.trim()) ? undefined : "Letters, digits, and underscores.") });
      if (!name) return;
      const template = await vscode.window.showQuickPick(
        [
          { label: "Field", description: "replaces how one column looks on a form", value: "field" as const },
          { label: "Dataset", description: "replaces a view or subgrid", value: "dataset" as const },
        ],
        { placeHolder: "What kind of control?" }
      );
      if (!template) return;
      const framework = await vscode.window.showQuickPick([{ label: "React (virtual)", react: true }, { label: "Standard (no framework)", react: false }], { placeHolder: "Framework" });
      if (!framework) return;
      const dir = path.join(client.dir, "PCF", name.trim());
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
        void vscode.window.showWarningMessage(`${path.relative(client.dir, dir)} already exists and isn't empty.`);
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      const ok = await withProgress(`Creating ${name} (this runs npm install)`, async (ctx) => {
        await pcfInit(ctx, { namespace: namespace.trim(), name: name.trim(), template: template.value, react: framework.react, outputDirectory: dir });
        return true;
      });
      onChanged();
      const manifest = findFiles(dir, (n) => n === "ControlManifest.Input.xml")[0];
      if (ok && manifest) await vscode.window.showTextDocument(vscode.Uri.file(manifest));
    }),

    r("lantern.pcf.build", async (node: ControlNode) => {
      const ok = await withProgress(`Building ${node.control.name}`, async (ctx) => {
        ctx.log(`> npm run build (in ${node.control.dir})\n`);
        const result = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: node.control.dir, onOutput: ctx.log, token: ctx.token });
        if (result.missing) throw new UserError("npm isn't installed. Install Node.js to build PCF controls.");
        if (result.code !== 0) throw new UserError(`The build of ${node.control.name} failed. See the Lantern output panel.`);
        return true;
      });
      if (ok) vscode.window.setStatusBarMessage(`$(check) Built ${node.control.name}`, 5000);
    }),

    r("lantern.pcf.push", async (node: ControlNode) => {
      const client = node.client;
      if (!client.config.org) return;
      let prefix = client.config.publisherPrefix;
      if (!prefix) {
        prefix =
          (await vscode.window.showInputBox({
            prompt: "Publisher prefix for PCF pushes (the solution publisher's prefix, e.g. acme)",
            validateInput: (v: string) => (/^[a-z][a-z0-9]{1,7}$/i.test(v.trim()) ? undefined : "2 to 8 letters or digits."),
          })) ?? "";
        if (!prefix) return;
        client.reload();
        client.config.publisherPrefix = prefix.trim();
        client.save();
      }
      if (!(await confirmProtected(client, `Push ${node.control.name}`))) return;
      const ok = await withProgress(`Pushing ${node.control.name} to ${client.envName || client.orgHost}`, async (ctx) => {
        await ensureAuth(ctx, client);
        await pcfPush(ctx, node.control.dir, prefix.trim());
        return true;
      });
      if (ok) void vscode.window.showInformationMessage(`Pushed ${node.control.name} to ${client.envName || client.orgHost}. It's in the PowerAppsTools_${prefix} solution.`);
    }),

    r("lantern.pcf.harness", (node: ControlNode) => {
      const terminal = vscode.window.createTerminal({ name: `${node.control.name} harness`, cwd: node.control.dir });
      terminal.show();
      terminal.sendText("npm start watch");
    }),

    // ---------- Power Pages ----------
    r("lantern.pages.download", async (arg?: unknown) => {
      const client = (arg as { client?: Client })?.client ?? (await resolveClient(arg));
      if (!client?.config.org) return;
      const sites = await withProgress(`Listing Power Pages sites in ${client.orgHost}`, async (ctx) => {
        await ensureAuth(ctx, client);
        return pagesList(ctx, client);
      });
      if (!sites) return;
      if (!sites.length) {
        void vscode.window.showInformationMessage(`${client.orgHost} has no Power Pages sites.`);
        return;
      }
      const site = await vscode.window.showQuickPick(sites.map((s) => ({ label: s.name, description: s.id, site: s })), { placeHolder: "Download which site?" });
      if (!site) return;
      const model = await vscode.window.showQuickPick(
        [
          { label: "Enhanced data model", description: "most sites created since 2023", version: 2 as const },
          { label: "Standard data model", description: "older sites (adx_ tables)", version: 1 as const },
        ],
        { placeHolder: "Which data model does the site use?" }
      );
      if (!model) return;
      const root = path.join(client.dir, "pages");
      fs.mkdirSync(root, { recursive: true });
      const before = new Set(findPagesSites(client.dir));
      const ok = await withProgress(`Downloading ${site.label}`, async (ctx) => {
        await pagesDownload(ctx, client, site.site.id, root, model.version);
        return true;
      });
      if (!ok) return;
      const created = findPagesSites(client.dir).find((d) => !before.has(d)) ?? findPagesSites(client.dir).find((d) => path.basename(d).toLowerCase().startsWith(site.label.toLowerCase().replace(/\s+/g, "-")));
      if (created) {
        const sites = readSites(client.dir);
        sites[path.basename(created)] = { id: site.site.id, modelVersion: model.version };
        fs.writeFileSync(sitesFile(client.dir), JSON.stringify(sites, null, 2) + "\n");
      }
      onChanged();
      void vscode.window.showInformationMessage(`Downloaded ${site.label} into ${path.relative(client.dir, created ?? root)}.`);
    }),

    r("lantern.pages.upload", async (arg?: unknown) => {
      const node = arg as Partial<SiteNode> | undefined;
      const client = node?.client ?? (await resolveClient(arg));
      if (!client?.config.org) return;
      let dir: string | undefined = node?.dir;
      if (dir === undefined) {
        const sites = findPagesSites(client.dir);
        if (!sites.length) {
          void vscode.window.showInformationMessage(`${client.name} has no downloaded Power Pages sites. Download one first.`);
          return;
        }
        const pick = await vscode.window.showQuickPick(sites.map((d) => ({ label: path.basename(d), dir: d })), { placeHolder: "Upload which site?" });
        if (!pick) return;
        dir = pick.dir;
      }
      const siteDir = dir ?? "";
      if (!siteDir) return;
      const known = readSites(client.dir)[path.basename(siteDir)];
      const version =
        known?.modelVersion ??
        (
          await vscode.window.showQuickPick([{ label: "Enhanced data model", version: 2 as const }, { label: "Standard data model", version: 1 as const }], {
            placeHolder: "Which data model does the site use?",
          })
        )?.version;
      if (!version) return;
      if (!(await confirmProtected(client, `Upload ${path.basename(siteDir)}`))) return;
      const site = siteDir;
      const ok = await withProgress(`Uploading ${path.basename(site)} to ${client.envName || client.orgHost}`, async (ctx) => {
        await ensureAuth(ctx, client);
        await pagesUpload(ctx, client, site, version);
        return true;
      });
      if (ok) void vscode.window.showInformationMessage(`Uploaded ${path.basename(site)} to ${client.envName || client.orgHost}.`);
    }),
  ];
}
