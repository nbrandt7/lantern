import { Client } from "./clients";
import { UserError } from "./errors";
import { Cancellation, run } from "./process";

export interface PacContext {
  pacPath: string;
  log: (text: string) => void;
  token?: Cancellation;
  /**
   * Asked when a client's pac profile is signed in as a different account than the one
   * pinned in .lantern/config.json. Return true to delete and recreate the profile.
   */
  confirmProfileAccount?: (profile: string, current: string, wanted: string) => Promise<boolean>;
  /** The stored secret for a client's app registration, for service principal profiles. */
  appSecret?: (client: Client) => Promise<string | undefined>;
}

/** Arguments as logged: secrets are masked. */
export function loggedArgs(args: string[]): string {
  return args.map((a, i) => (/^--(clientSecret|password)$/i.test(args[i - 1] ?? "") ? "********" : a)).join(" ");
}

async function pac(ctx: PacContext, args: string[], failure: string, cwd?: string): Promise<string> {
  ctx.log(`> pac ${loggedArgs(args)}\n`);
  const r = await run(ctx.pacPath, args, { onOutput: ctx.log, token: ctx.token, cwd });
  if (r.missing) throw pacMissing();
  if (ctx.token?.isCancellationRequested) throw new UserError("Cancelled.");
  if (r.code !== 0) throw new UserError(`${failure} See the Lantern output panel for details.`);
  return r.stdout;
}

function pacMissing(): UserError {
  return new UserError(
    'The Power Platform CLI (pac) isn\'t on your PATH. Install it with "dotnet tool install --global Microsoft.PowerApps.CLI.Tool", or set lantern.pacPath.'
  );
}

/**
 * One pac profile per client and environment, e.g. "acmedynamicsTEST". An app registration
 * gets its own profile ("...app1a2b") so switching between it and a user never reuses the other's.
 */
export function profileName(client: Client): string {
  const app = client.config.appId ? `app${client.config.appId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4)}` : "";
  const base = `${client.name}${client.envName}`.replace(/[^a-zA-Z0-9]/g, "");
  return `${base.slice(0, 30 - app.length)}${app}` || "client";
}

/**
 * One pac auth profile per client, named after the folder. Created on first use
 * (interactive sign-in), then just selected. When .lantern/config.json pins an account, the
 * profile's account is checked against it, so pac and the Web API agree on who you are.
 */
export async function ensureAuth(ctx: PacContext, client: Client): Promise<void> {
  if (!client.config.org) throw new UserError(`Set "org" in ${client.name}/.lantern/config.json first.`);
  const name = profileName(client);
  const wanted = client.config.account;
  ctx.log(`> pac auth select --name ${name}\n`);
  const select = await run(ctx.pacPath, ["auth", "select", "--name", name], { token: ctx.token });
  if (select.missing) throw pacMissing();

  if (select.code === 0) {
    if (!wanted || client.config.appId) return;
    const current = await profileAccount(ctx, name);
    if (!current || sameUser(current, wanted)) return;
    const recreate = (await ctx.confirmProfileAccount?.(name, current, wanted)) ?? false;
    if (!recreate) {
      ctx.log(`pac profile "${name}" is signed in as ${current}, not ${wanted}. Leaving it as it is.\n`);
      return;
    }
    await pac(ctx, ["auth", "delete", "--name", name], `Couldn't delete the pac profile "${name}".`);
  }

  if (client.config.appId) {
    const secret = await ctx.appSecret?.(client);
    if (!secret) throw new UserError(`There's no secret stored for app ${client.config.appId} on ${client.name}. Use "Sign In As…" to enter it again.`);
    ctx.log(`Creating pac auth profile "${name}" for ${client.config.org} with app registration ${client.config.appId}.\n`);
    await pac(
      ctx,
      ["auth", "create", "--name", name, "--environment", client.config.org, "--applicationId", client.config.appId, "--clientSecret", secret, "--tenant", client.config.tenant],
      "pac couldn't sign in with the app registration. Check its ID, secret, tenant, and that it's an application user in the org."
    );
    return;
  }
  ctx.log(`Creating pac auth profile "${name}" for ${client.config.org}. A sign-in window will open${wanted ? `; sign in as ${wanted}` : ""}.\n`);
  await pac(
    ctx,
    ["auth", "create", "--name", name, "--environment", client.config.org],
    "pac sign-in failed. Check the org URL and that your account has access."
  );
  if (wanted) {
    const now = await profileAccount(ctx, name);
    if (now && !sameUser(now, wanted)) {
      throw new UserError(`pac signed in as ${now}, but ${client.name} uses ${wanted}. Run the command again and pick ${wanted} in the sign-in window.`);
    }
  }
}

const sameUser = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The account a pac profile is signed in as, from "pac auth list". */
export async function profileAccount(ctx: PacContext, profile: string): Promise<string | undefined> {
  const r = await run(ctx.pacPath, ["auth", "list"], { token: ctx.token });
  if (r.code !== 0) return undefined;
  return accountFromAuthList(r.stdout, profile);
}

export function accountFromAuthList(output: string, profile: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (!tokens.some((t) => t.toLowerCase() === profile.toLowerCase())) continue;
    const user = tokens.find((t) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t));
    if (user) return user;
  }
  return undefined;
}

export async function solutionClone(ctx: PacContext, client: Client, solution: string, outputDirectory: string): Promise<void> {
  await pac(
    ctx,
    ["solution", "clone", "--name", solution, "--outputDirectory", outputDirectory, "--environment", client.config.org],
    `Clone failed for ${solution}. Check that it's the unique name, not the display name.`
  );
}

export async function solutionSync(ctx: PacContext, client: Client, folder: string): Promise<void> {
  await pac(ctx, ["solution", "sync", "--solution-folder", folder, "--environment", client.config.org], "Solution sync failed.");
}

export async function modelBuilder(ctx: PacContext, args: string[]): Promise<void> {
  await pac(ctx, ["modelbuilder", "build", ...args], "pac modelbuilder build failed.");
}

export async function solutionExport(ctx: PacContext, client: Client, name: string, zipPath: string, managed: boolean): Promise<void> {
  const args = ["solution", "export", "--name", name, "--path", zipPath, "--environment", client.config.org, "--overwrite"];
  if (managed) args.push("--managed");
  await pac(ctx, args, `Export of ${name} failed.`);
}

export async function solutionImport(ctx: PacContext, client: Client, zipPath: string): Promise<void> {
  await pac(ctx, ["solution", "import", "--path", zipPath, "--environment", client.config.org, "--publish-changes"], "Solution import failed.");
}

export async function solutionCheck(ctx: PacContext, zipPath: string, outDir: string): Promise<void> {
  await pac(ctx, ["solution", "check", "--path", zipPath, "--outputDirectory", outDir], "Solution checker failed.");
}

/** Packs an unpacked solution folder (the one holding Other/Solution.xml) into a zip. */
export async function solutionPack(ctx: PacContext, folder: string, zipPath: string, managed: boolean): Promise<void> {
  await pac(ctx, ["solution", "pack", "--zipfile", zipPath, "--folder", folder, "--packagetype", managed ? "Managed" : "Unmanaged"], "Packing the solution failed.");
}

export async function pluginInit(ctx: PacContext, outputDirectory: string): Promise<void> {
  await pac(ctx, ["plugin", "init", "--outputDirectory", outputDirectory], "Creating the plug-in project failed.");
}

export async function pcfInit(ctx: PacContext, o: { namespace: string; name: string; template: "field" | "dataset"; react: boolean; outputDirectory: string }): Promise<void> {
  await pac(
    ctx,
    ["pcf", "init", "--namespace", o.namespace, "--name", o.name, "--template", o.template, "--framework", o.react ? "react" : "none", "--outputDirectory", o.outputDirectory, "--run-npm-install"],
    "Creating the PCF control failed."
  );
}

export async function pcfPush(ctx: PacContext, controlDir: string, publisherPrefix: string): Promise<void> {
  await pac(ctx, ["pcf", "push", "--publisher-prefix", publisherPrefix], "Pushing the PCF control failed.", controlDir);
}

export interface PagesSite {
  id: string;
  name: string;
}

/** Power Pages sites in the org, from "pac pages list". */
export async function pagesList(ctx: PacContext, client: Client): Promise<PagesSite[]> {
  const out = await pac(ctx, ["pages", "list", "--environment", client.config.org], "Listing Power Pages sites failed.");
  return parsePagesList(out);
}

export function parsePagesList(output: string): PagesSite[] {
  const sites: PagesSite[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(.+?)\s*$/i.exec(line);
    if (m) sites.push({ id: m[1].toLowerCase(), name: m[2].replace(/\s{2,}.*$/, "").trim() });
  }
  return sites;
}

export async function pagesDownload(ctx: PacContext, client: Client, siteId: string, path: string, modelVersion: 1 | 2): Promise<void> {
  await pac(
    ctx,
    ["pages", "download", "--path", path, "--webSiteId", siteId, "--modelVersion", String(modelVersion), "--environment", client.config.org, "--overwrite"],
    "Downloading the site failed."
  );
}

export async function pagesUpload(ctx: PacContext, client: Client, path: string, modelVersion: 1 | 2): Promise<void> {
  await pac(ctx, ["pages", "upload", "--path", path, "--modelVersion", String(modelVersion), "--environment", client.config.org], "Uploading the site failed.");
}
