import * as fs from "fs";
import * as path from "path";
import { Client, writeJsconfig } from "./clients";
import { UserError } from "./errors";
import { isDirectory } from "./files";
import { Cancellation, run } from "./process";

// Microsoft's documented sample app registration for interactive Dataverse sign-in.
const APP_ID = "51f81489-12ee-4a9e-aaae-a2591f45987d";
const REDIRECT_URI = "app://58145B91-0C36-4500-8554-080854F2AC97";

export function findXdtExe(configured: string, searchRoots: string[]): string | undefined {
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  for (const root of searchRoots) {
    const found = findFile(path.join(root, "tools", "xdt"), "xrmdefinitelytyped.exe");
    if (found) return found;
  }
  return undefined;
}

/**
 * Generates org-specific form typings into <client>/typings and switches the
 * client's jsconfig to them. Generates into a temp folder first, so a failed run
 * leaves working typings in place.
 */
export async function generateFormTypes(
  client: Client,
  exe: string,
  log: (text: string) => void,
  token?: Cancellation
): Promise<void> {
  if (process.platform !== "win32") throw new UserError("XrmDefinitelyTyped is a .NET Framework tool and needs Windows.");
  const { org, solutions, entities } = client.config;
  const username = client.config.username || client.config.account;
  if (!org) throw new UserError(`Set "org" in ${client.name}/.lantern/config.json first.`);
  if (!solutions.length && !entities.length) throw new UserError(`Set "solutions" or "entities" in ${client.name}/.lantern/config.json.`);

  const connectionString = [
    "AuthType=OAuth",
    `Url=${org}`,
    username && `Username=${username}`,
    `AppId=${APP_ID}`,
    `RedirectUri=${REDIRECT_URI}`,
    "LoginPrompt=Auto",
  ]
    .filter(Boolean)
    .join(";");

  const outDir = path.join(client.dir, "typings");
  const tmpDir = path.join(client.dir, "typings.tmp");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const args = ["/method:ConnectionString", `/connectionString:${connectionString}`, `/out:${tmpDir}`, "/skipInactiveForms:true"];
  if (solutions.length) args.push(`/solutions:${solutions.join(",")}`);
  if (entities.length) args.push(`/entities:${entities.join(",")}`);

  log(`> XrmDefinitelyTyped ${args.filter((a) => !a.startsWith("/connectionString")).join(" ")}\n`);
  const r = await run(exe, args, { onOutput: log, token });
  if (r.code !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new UserError(`XrmDefinitelyTyped failed (exit ${r.code}). Existing typings were left in place.`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, outDir);
  writeJsconfig(client.dir, "xdt");
}

/** Form typings available for a table, e.g. ["Main/Information", "Main/Account Card"]. */
export function availableForms(client: Client, entity: string): string[] {
  const root = path.join(client.dir, "typings", "Form", entity);
  if (!isDirectory(root)) return [];
  const forms: string[] = [];
  for (const type of fs.readdirSync(root)) {
    const dir = path.join(root, type);
    if (!isDirectory(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".d.ts")) forms.push(`${type}/${f.slice(0, -5)}`);
  }
  return forms.sort();
}

function findFile(dir: string, lowerName: string): string | undefined {
  if (!isDirectory(dir)) return undefined;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === lowerName) return full;
    if (e.isDirectory()) {
      const found = findFile(full, lowerName);
      if (found) return found;
    }
  }
  return undefined;
}
