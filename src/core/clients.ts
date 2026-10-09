import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { isDirectory, readJson, writeJson } from "./files";

// ---------- where client settings live ----------

/**
 * Folder outside the workspace where Lantern keeps each client's settings, so nothing
 * of Lantern's sits in a client's repo. Undefined: the older layout, client.json in the folder.
 */
let storeDir: string | undefined;
/** Folders the person removed Lantern from, which shouldn't be configured again automatically. */
let ignoredFile: string | undefined;

export function useClientStore(dir: string | undefined, ignoredListFile?: string): void {
  storeDir = dir;
  ignoredFile = ignoredListFile;
}

const folderKey = (dir: string) => {
  const resolved = path.resolve(dir);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return `${path.basename(resolved).replace(/[^\w.-]+/g, "-")}-${createHash("sha1").update(normalized).digest("hex").slice(0, 10)}`;
};

/** Where a folder's settings are kept outside it, when the store is in use. */
export function storedConfigPath(dir: string): string | undefined {
  return storeDir ? path.join(storeDir, `${folderKey(dir)}.lantern-client.json`) : undefined;
}

/** The settings file in use for a folder: the stored one, else a client.json in the folder. */
function configPathFor(dir: string): string {
  const stored = storedConfigPath(dir);
  if (stored && fs.existsSync(stored)) return stored;
  const legacy = path.join(dir, CLIENT_FILE);
  if (fs.existsSync(legacy) || !stored) return legacy;
  return stored;
}

/** Whether git tracks a file (committed or staged). Unknown (no git) counts as tracked, to be safe. */
function isTracked(file: string): boolean {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", path.basename(file)], { cwd: path.dirname(file), stdio: "ignore" });
  if (r.error) return true;
  return r.status === 0;
}

/**
 * Moves a folder's client.json into the store, unless the repo tracks it (then a team
 * put it there on purpose, so it stays). Returns true when it moved.
 */
export function moveConfigToStore(dir: string): boolean {
  const stored = storedConfigPath(dir);
  const legacy = path.join(dir, CLIENT_FILE);
  if (!stored || !fs.existsSync(legacy) || fs.existsSync(stored)) return false;
  if (fs.existsSync(path.join(dir, ".git")) || isInsideGitRepo(dir)) {
    if (isTracked(legacy)) return false;
  }
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  writeJson(stored, normalizeConfig(readJson<Partial<ClientConfig>>(legacy)));
  fs.rmSync(legacy);
  return true;
}

export function ignoredFolders(): string[] {
  if (!ignoredFile || !fs.existsSync(ignoredFile)) return [];
  try {
    return readJson<string[]>(ignoredFile);
  } catch {
    return [];
  }
}

function setIgnored(dir: string, ignored: boolean): void {
  if (!ignoredFile) return;
  const list = ignoredFolders().filter((d) => path.resolve(d) !== path.resolve(dir));
  if (ignored) list.push(path.resolve(dir));
  fs.mkdirSync(path.dirname(ignoredFile), { recursive: true });
  writeJson(ignoredFile, list);
}

export const isIgnoredFolder = (dir: string) => ignoredFolders().some((d) => path.resolve(d) === path.resolve(dir));

// ---------- git repos around a folder ----------

export interface GitRepo {
  /** The working tree's top folder. */
  root: string;
  /** Its local, never-committed exclude file (.git/info/exclude, wherever .git really is). */
  excludeFile: string;
}

/**
 * The git repo a folder belongs to, found by walking up to the nearest .git (a folder,
 * or a file pointing elsewhere, as in worktrees and submodules). Reads files only.
 */
export function gitRepoFor(dir: string): GitRepo | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, ".git");
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      if (!isDirectory(dotGit)) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (!m) return undefined;
        gitDir = path.resolve(current, m[1].trim());
      }
      // Worktrees keep info/exclude in the shared ("common") git folder.
      const commonFile = path.join(gitDir, "commondir");
      const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim()) : gitDir;
      return { root: current, excludeFile: path.join(common, "info", "exclude") };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export const isInsideGitRepo = (dir: string) => !!gitRepoFor(dir);

/**
 * Whether a workspace subfolder should become a client automatically: when it's a repo
 * of its own (a cloned client), or when the workspace folder isn't part of a repo. A
 * project folder inside a repo you opened directly is left alone. So are folders the
 * person removed Lantern from.
 */
export function shouldAutoConfigure(dir: string, workspaceRoot: string): boolean {
  if (isIgnoredFolder(dir)) return false;
  return fs.existsSync(path.join(dir, ".git")) || !isInsideGitRepo(workspaceRoot);
}

export const CLIENT_FILE = "client.json";
const RESERVED = new Set(["node_modules", "scripts", "tools", "out", "dist"]);

/** Files the tooling adds to a client folder, kept out of the client's repo via .git/info/exclude. */
const LOCAL_FILES = ["jsconfig.json", "client.json", "typings/", "typings.tmp/", ".pull-backup/", "exports/"];

export interface EnvironmentConfig {
  /** Short label like DEV, TEST, PROD. */
  name: string;
  org: string;
  tenant?: string;
  /** Older files may hold the account here; Sign In As keeps it in the "accounts" map. */
  account?: string;
  /** Asks before anything that changes data or customizations here. */
  protected?: boolean;
  /** App registration (service principal) to sign in with here instead of a user account. */
  appId?: string;
}

export interface ClientConfig {
  /** The org in use: the active environment's org, or the single org when there are no environments. */
  org: string;
  /** Microsoft account to sign in with (for the active environment). Empty: whichever account VS Code picks. */
  account: string;
  /** Entra tenant ID or domain, for guest accounts in the client's tenant. Optional. */
  tenant: string;
  /** App registration (client ID) to sign in with instead of a user account; its secret is in VS Code's secret storage. */
  appId: string;
  /** DEV / TEST / PROD orgs for this client. Empty means a single org ("org"). */
  environments: EnvironmentConfig[];
  /** Name of the active environment. */
  environment: string;
  /** Account per environment name, set by Sign In As. */
  accounts: Record<string, string>;
  solutions: string[];
  /** Tables for XrmDefinitelyTyped when solutions don't cover them. */
  entities: string[];
  username: string;
  /** Namespace used by "New form script", e.g. "Acme". Defaults to the folder name. */
  scriptNamespace: string;
  /** Folders whose relative paths are web resource names, e.g. ["src/WebResources"]. Optional. */
  webResourceRoots: string[];
  earlyBound: { outDir: string; namespace: string; entities: string[] };
  /** Plug-in assembly or package IDs by assembly name, when they can't be found in the solution. */
  plugins: Record<string, string>;
  /** Table each script works with, by path relative to the client folder, for column completions. */
  fileTables: Record<string, string>;
  /** Publisher prefix for PCF pushes (e.g. "acme"). Asked once, then remembered. */
  publisherPrefix: string;
}

export class Client {
  /** What's in the files (shared and personal merged), before resolving the active environment. */
  private stored: ClientConfig;
  /** The effective account/org/tenant computed for the active environment, to detect edits on save. */
  private effective: { org: string; account: string; tenant: string; appId: string };

  constructor(public readonly name: string, public readonly dir: string, stored: ClientConfig, activeOverride?: string) {
    this.stored = stored;
    this.config = resolveEnvironment(stored, activeOverride);
    this.effective = { org: this.config.org, account: this.config.account, tenant: this.config.tenant, appId: this.config.appId };
  }

  config: ClientConfig;

  /** The settings file: in Lantern's store, or a client.json in the folder (older layout, or committed by a team). */
  get configFile(): string {
    return configPathFor(this.dir);
  }

  get isRepo(): boolean {
    return fs.existsSync(path.join(this.dir, ".git"));
  }

  get orgHost(): string {
    try {
      return new URL(this.config.org).host;
    } catch {
      return "";
    }
  }

  get environments(): EnvironmentConfig[] {
    return this.config.environments;
  }

  get activeEnvironment(): EnvironmentConfig | undefined {
    return this.config.environments.find((e) => e.name === this.config.environment);
  }

  /** Active environment's name, or "" when the client has a single org. */
  get envName(): string {
    return this.activeEnvironment?.name ?? "";
  }

  /** Changes here need an extra confirmation (a PROD environment, say). */
  get isProtected(): boolean {
    return this.activeEnvironment?.protected === true;
  }

  /** The same client pointed at another environment, without saving anything. */
  withEnvironment(name: string): Client {
    return new Client(this.name, this.dir, this.stored, name);
  }

  get typingMode(): "generic" | "xdt" {
    try {
      const cfg = readJson<{ compilerOptions?: { types?: string[] } }>(path.join(this.dir, "jsconfig.json"));
      return cfg.compilerOptions?.types?.length === 0 ? "xdt" : "generic";
    } catch {
      return "generic";
    }
  }

  /**
   * Writes edits made to `config` back to client.json. An account set while an
   * environment is active is saved as that environment's account.
   */
  save(): void {
    const c = this.config;
    const s = this.stored;
    for (const key of Object.keys(c) as Array<keyof ClientConfig>) {
      if (key === "org" || key === "account" || key === "tenant" || key === "appId") continue;
      (s as unknown as Record<string, unknown>)[key] = c[key];
    }
    const env = this.activeEnvironment;
    if (env) {
      if (c.account !== this.effective.account) {
        // "" is kept on purpose: it means "no pinned account here", even when there's a default.
        s.accounts[env.name] = c.account;
        delete env.account;
      }
      if (c.org !== this.effective.org) env.org = normalizeOrg(c.org);
      if (c.tenant !== this.effective.tenant) env.tenant = c.tenant;
      if (c.appId !== this.effective.appId) {
        if (c.appId) env.appId = c.appId;
        else delete env.appId;
      }
    } else {
      s.org = c.org;
      s.account = c.account;
      s.tenant = c.tenant;
      s.appId = c.appId;
    }
    writeJson(this.configFile, s);
    this.reload();
  }

  reload(): void {
    const fresh = loadStored(this.dir);
    if (!fresh) return;
    this.stored = fresh;
    this.config = resolveEnvironment(fresh);
    this.effective = { org: this.config.org, account: this.config.account, tenant: this.config.tenant, appId: this.config.appId };
  }
}

/** The effective config for an environment (the stored active one when none is given). */
function resolveEnvironment(stored: ClientConfig, name?: string): ClientConfig {
  const copy: ClientConfig = { ...stored };
  if (!stored.environments.length) return copy;
  const env = stored.environments.find((e) => e.name === (name ?? stored.environment)) ?? stored.environments[0];
  copy.environment = env.name;
  copy.org = normalizeOrg(env.org);
  copy.tenant = env.tenant || stored.tenant;
  copy.account = env.name in stored.accounts ? stored.accounts[env.name] : env.account || stored.account;
  copy.appId = env.appId ?? stored.appId;
  return copy;
}

function loadStored(dir: string): ClientConfig | undefined {
  const file = configPathFor(dir);
  if (!fs.existsSync(file)) return undefined;
  return normalizeConfig(readJson<Partial<ClientConfig>>(file));
}

export function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

export function normalizeConfig(raw: Partial<ClientConfig> & { url?: string }): ClientConfig {
  const eb: Partial<ClientConfig["earlyBound"]> = raw.earlyBound ?? {};
  const environments = (Array.isArray(raw.environments) ? raw.environments : [])
    .filter((e) => e && e.name && e.org)
    .map((e) => ({ ...e, name: String(e.name).trim(), org: normalizeOrg(String(e.org)) }));
  return {
    org: normalizeOrg(raw.org ?? raw.url ?? ""),
    account: (raw.account ?? "").trim(),
    tenant: raw.tenant ?? "",
    appId: (raw.appId ?? "").trim(),
    publisherPrefix: (raw.publisherPrefix ?? "").trim(),
    environments,
    environment: raw.environment ?? environments[0]?.name ?? "",
    accounts: raw.accounts ?? {},
    solutions: toList(raw.solutions),
    entities: toList(raw.entities),
    username: raw.username ?? "",
    scriptNamespace: raw.scriptNamespace ?? "",
    webResourceRoots: toList(raw.webResourceRoots),
    earlyBound: { outDir: eb.outDir ?? "", namespace: eb.namespace ?? "", entities: toList(eb.entities) },
    plugins: raw.plugins ?? {},
    fileTables: raw.fileTables ?? {},
  };
}

export function normalizeOrg(org: string): string {
  const trimmed = org.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function isClientFolderName(name: string): boolean {
  return !name.startsWith(".") && !RESERVED.has(name.toLowerCase());
}

export function readClient(dir: string): Client | undefined {
  try {
    const stored = loadStored(dir);
    return stored ? new Client(path.basename(dir), dir, stored) : undefined;
  } catch {
    return undefined;
  }
}

export interface FolderScan {
  clients: Client[];
  /** Subfolders that look like clients but have no client.json yet. */
  unconfigured: string[];
}

/** Client folders directly under root. A root that is itself a client is returned as the only client. */
export function scanClients(root: string): FolderScan {
  const self = readClient(root);
  if (self) return { clients: [self], unconfigured: [] };
  const clients: Client[] = [];
  const unconfigured: string[] = [];
  if (!isDirectory(root)) return { clients, unconfigured };
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !isClientFolderName(e.name)) continue;
    const dir = path.join(root, e.name);
    const client = readClient(dir);
    if (client) clients.push(client);
    else unconfigured.push(dir);
  }
  clients.sort((a, b) => a.name.localeCompare(b.name));
  return { clients, unconfigured: unconfigured.sort() };
}

/**
 * Makes sure a client folder has client.json and jsconfig.json and that both stay
 * out of git. Never overwrites an existing jsconfig, so generated-type mode sticks.
 */
export function ensureClientConfig(dir: string, initial: Partial<ClientConfig> = {}, options: { jsconfig?: boolean } = {}): Client {
  migrateXdtJson(dir);
  if (options.jsconfig !== false && !fs.existsSync(path.join(dir, "jsconfig.json"))) writeJsconfig(dir, "generic");
  const existing = loadStored(dir);
  const stored = existing ? normalizeConfig({ ...initial, ...existing }) : normalizeConfig(initial);
  const file = configPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, stored);
  excludeLocally(dir);
  setIgnored(dir, false);
  return new Client(path.basename(dir), dir, stored);
}

/** True when a jsconfig.json is the one Lantern writes (so it's safe to remove). */
export function isLanternJsconfig(file: string): boolean {
  try {
    const cfg = readJson<{ exclude?: string[] }>(file);
    return !!cfg.exclude?.includes(".pull-backup") && !!cfg.exclude?.includes("typings.tmp");
  } catch {
    return false;
  }
}

/**
 * Stops treating a folder as a client: removes Lantern's settings for it and the
 * jsconfig.json Lantern wrote (a hand-written one is kept). Nothing else is touched, and
 * the folder isn't configured again automatically.
 */
export function removeClientConfig(dir: string): void {
  const stored = storedConfigPath(dir);
  if (stored && fs.existsSync(stored)) fs.rmSync(stored);
  const legacy = path.join(dir, CLIENT_FILE);
  if (fs.existsSync(legacy) && !isTracked(legacy)) fs.rmSync(legacy);
  const jsconfig = path.join(dir, "jsconfig.json");
  if (fs.existsSync(jsconfig) && isLanternJsconfig(jsconfig) && !isTracked(jsconfig)) fs.rmSync(jsconfig);
  setIgnored(dir, true);
}

/** "generic" uses @types/xrm. "xdt" uses XrmDefinitelyTyped's generated typings, which replace @types/xrm. */
export function writeJsconfig(dir: string, mode: "generic" | "xdt"): void {
  const exclude = ["**/node_modules", "**/bin", "**/obj", "**/dist", "typings.tmp", ".pull-backup"];
  writeJson(
    path.join(dir, "jsconfig.json"),
    mode === "xdt"
      ? { compilerOptions: { checkJs: true, target: "ES2020", types: [] }, include: ["**/*.js", "typings/**/*.d.ts"], exclude }
      : { compilerOptions: { checkJs: true, target: "ES2020", types: ["xrm"] }, include: ["**/*.js"], exclude }
  );
}

function migrateXdtJson(dir: string): void {
  const old = path.join(dir, "xdt.json");
  if (!fs.existsSync(old) || fs.existsSync(path.join(dir, CLIENT_FILE))) return;
  writeJson(path.join(dir, CLIENT_FILE), normalizeConfig(readJson(old)));
  fs.rmSync(old);
}

/**
 * Keeps Lantern's files out of git without touching .gitignore: adds them to the local
 * exclude file of whichever repo holds the folder, anchored to the folder's path in it.
 * Never committed, nothing for teammates to see.
 */
export function excludeLocally(dir: string): void {
  const repo = gitRepoFor(dir);
  if (!repo) return;
  const excludeFile = repo.excludeFile;
  const rel = path.relative(repo.root, path.resolve(dir)).split(path.sep).join("/");
  const prefix = rel ? `/${rel}/` : "/";
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = LOCAL_FILES.map((f) => prefix + f).filter((f) => !lines.has(f));
  if (!missing.length) return;
  const header = lines.has("# lantern") || lines.has("# dataverse-workspace") ? "" : "# lantern\n";
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludeFile, sep + header + missing.join("\n") + "\n");
}

export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
