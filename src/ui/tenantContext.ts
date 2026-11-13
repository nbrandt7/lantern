import * as fs from "fs";
import * as path from "path";
import { Client, ClientConfig, normalizeConfig, readTenantDocument, serializeTenant, storedConfigName, TenantDocument, tenantsInFile } from "../core/clients";
import { readJson, writeJson } from "../core/files";

let globalTenantsFile: string | undefined;
let mode: "global" | "folder" = "global";
let roots: () => string[] = () => [];
let selected: string | undefined;
let active: Client | undefined;

const keyOf = (tenant: Client) => `${tenant.configFile}\0${tenant.name}`;

export function configureTenantContext(file: string, location: "global" | "folder", workspaceRoots: () => string[]): void {
  globalTenantsFile = file;
  roots = workspaceRoots;
  if (mode !== location) { selected = undefined; active = undefined; }
  mode = location;
  if (selected) {
    const saved = availableTenants().find((tenant) => keyOf(tenant) === selected);
    if (saved && active && keyOf(active) === selected) {
      if (path.resolve(saved.dir) === path.resolve(active.dir)) active.reload();
      else {
        // A client's folder is fixed when it's made, so an edited "folder" takes the freshly read tenant.
        if (active.envName) saved.selectEnvironment(active.envName);
        active = saved;
      }
    } else active = saved;
    if (!saved) selected = undefined;
  }
  if (mode === "folder" && !selected) {
    for (const file of localFiles()) {
      try {
        const document = readTenantDocument(file);
        const tenant = tenantsInFile(file, path.dirname(path.dirname(file))).find((item) => item.name === document.defaultTenant);
        if (tenant) { selected = keyOf(tenant); active = tenant; break; }
      } catch { /* Leave a malformed config for the user to fix in the editor. */ }
    }
  }
}

function localFiles(): string[] {
  return [...new Set(roots().map((root) => path.join(root, ".lantern", "config.json")))]
    .filter((file) => fs.existsSync(file));
}

export function availableTenants(): Client[] {
  if (mode === "global") {
    if (!globalTenantsFile) return [];
    try { return tenantsInFile(globalTenantsFile, roots()[0] ?? path.dirname(globalTenantsFile)); }
    catch { return []; }
  }
  return localFiles().flatMap((file) => {
    try { return tenantsInFile(file, path.dirname(path.dirname(file))); }
    catch { return []; }
  });
}

export function activeTenant(): Client | undefined {
  return active;
}

export function selectTenant(tenant: Client | undefined): void {
  selected = tenant ? keyOf(tenant) : undefined;
  active = tenant;
}

export function tenantMode(): "global" | "folder" { return mode; }

export function tenantConfigFile(): string | undefined {
  if (mode === "global") return globalTenantsFile;
  const root = roots()[0];
  if (!root) return undefined;
  return path.join(root, ".lantern", "config.json");
}

export function addTenant(name: string, config: Partial<ClientConfig>, workspaceRoot?: string): Client {
  const file = mode === "folder" && workspaceRoot
    ? path.join(workspaceRoot, ".lantern", "config.json")
    : tenantConfigFile();
  if (!file) throw new Error("Open a folder before adding a local tenant.");
  const document = readTenantDocument(file);
  if (document.tenants.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) throw new Error(`Tenant ${name} already exists.`);
  document.tenants.push(serializeTenant(name, config));
  if (mode === "global" && config.folder) document.removedFolders = (document.removedFolders ?? []).filter((folder) => path.resolve(folder) !== path.resolve(config.folder!));
  if (mode === "folder" && !document.defaultTenant) document.defaultTenant = name;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, document);
  const tenant = tenantsInFile(file, mode === "folder" ? path.dirname(path.dirname(file)) : roots()[0] ?? path.dirname(file)).find((entry) => entry.name === name)!;
  selectTenant(tenant);
  return tenant;
}

export function removeTenant(tenant: Client): void {
  const document = readTenantDocument(tenant.configFile);
  // Only the first entry with a name is offered (see tenantsInFile), so only that one goes.
  const index = document.tenants.findIndex((entry) => entry.name === tenant.name);
  if (index >= 0) document.tenants.splice(index, 1);
  if (mode === "global") (document.removedFolders ??= []).push(tenant.dir);
  if (document.defaultTenant === tenant.name) delete document.defaultTenant;
  writeJson(tenant.configFile, document);
  if (selected === keyOf(tenant)) selected = undefined;
  if (active && keyOf(active) === keyOf(tenant)) active = undefined;
}

/** Bring an existing folder connection into the shared list without changing its old config. */
export function registerStoredTenant(tenant: Client, explicit = false): void {
  if (mode !== "global" || !globalTenantsFile) return;
  const document = readTenantDocument(globalTenantsFile);
  if (document.removedFolders?.some((folder) => path.resolve(folder) === path.resolve(tenant.dir))) {
    if (!explicit) return;
    document.removedFolders = document.removedFolders.filter((folder) => path.resolve(folder) !== path.resolve(tenant.dir));
  }
  if (document.tenants.some((config) => config.folder && path.resolve(config.folder) === path.resolve(tenant.dir))) return;
  const imported = document.tenants.find((config) =>
    config.name === tenant.name && !config.folder &&
    (config.org === tenant.config.org || config.environments?.some((env) => env.org === tenant.config.org))
  );
  if (imported) {
    imported.folder = tenant.dir;
    writeJson(globalTenantsFile, document);
    return;
  }
  let name = tenant.name;
  for (let number = 2; document.tenants.some((entry) => entry.name === name); number++) name = `${tenant.name} ${number}`;
  document.tenants.push(serializeTenant(name, { ...tenant.config, folder: tenant.dir }));
  fs.mkdirSync(path.dirname(globalTenantsFile), { recursive: true });
  writeJson(globalTenantsFile, document);
}

/** Existing internal settings were stored as one file per folder. Keep them visible in the shared picker. */
export function importSavedTenants(storeDir: string): void {
  if (mode !== "global" || !globalTenantsFile) return;
  let document: TenantDocument;
  // A hand-edited tenants.json that doesn't parse is reported by unreadableTenantFile; import once it's fixed.
  try { document = readTenantDocument(globalTenantsFile); }
  catch { return; }
  if (document.legacyImported) return;
  // Store files are named after a hash of their folder's path, so match them to the folders the old
  // version would have found: each workspace folder and the folders directly in it.
  const folders = new Map<string, string>();
  for (const root of roots()) {
    let children: string[] = [];
    try { children = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)); }
    catch { /* A missing workspace folder has nothing to match. */ }
    for (const dir of [root, ...children]) folders.set(storedConfigName(dir), dir);
  }
  const sameFolder = (a?: string, b?: string) => (a ? path.resolve(a) : "") === (b ? path.resolve(b) : "");
  // Each store file is a different folder, so only an entry that was already here can duplicate one.
  const existing = document.tenants.map((saved) => normalizeConfig(saved));
  for (const file of fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : []) {
    const match = /^(.*)-[a-f0-9]{10}\.lantern-client\.json$/.exec(file);
    if (!match) continue;
    try {
      const folder = folders.get(file);
      const config = { ...normalizeConfig(readJson<Partial<ClientConfig>>(path.join(storeDir, file))), ...(folder ? { folder } : {}) };
      if (existing.some((saved) => saved.org === config.org && saved.tenant === config.tenant && saved.account === config.account && sameFolder(saved.folder, config.folder))) continue;
      const base = folder ? path.basename(folder) : match[1];
      let name = base;
      for (let number = 2; document.tenants.some((entry) => entry.name === name); number++) name = `${base} ${number}`;
      document.tenants.push(serializeTenant(name, config));
    } catch { /* A malformed old connection is left untouched. */ }
  }
  document.legacyImported = true;
  fs.mkdirSync(path.dirname(globalTenantsFile), { recursive: true });
  writeJson(globalTenantsFile, document);
}

/** The tenant file that can't be read (hand-edited JSON that doesn't parse), which lists no tenants until it's fixed. */
export function unreadableTenantFile(): { file: string; message: string } | undefined {
  const files = mode === "global" ? (globalTenantsFile ? [globalTenantsFile] : []) : localFiles();
  for (const file of files) {
    try { readTenantDocument(file); }
    catch (error) { return { file, message: error instanceof Error ? error.message : String(error) }; }
  }
  return undefined;
}
