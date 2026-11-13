import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { fetchOrgSolutions } from "../core/admin";
import { Client } from "../core/clients";
import { DataverseClient } from "../core/dataverse";
import { UserError } from "../core/errors";
import { findFunction, findWebResourceFile } from "../core/handlers";
import { MetadataService, TableMeta } from "../core/metadata";
import { fetchApps, fetchModernCommands, ModernSaveTracker, saveModernCommands } from "../core/modernCommands";
import { publisherPrefix } from "../core/pluginRegistration";
import {
  applyDiff, checkRibbonReferences, CRM_PARAMETER_VALUES, explainStep, findRibbonDiffs, LocalRibbonDiff, LOCATIONS, lostParts, mergePublishedDiff, mergeRibbons, PARAMETER_KINDS, parseRibbonXml,
  removedParts, replaceEntityRibbonDiff, ribbonChanges, RibbonDiff, ribbonDiffFile, ribbonDiffPathFor, RibbonLocation, RibbonModel, RibbonProblem, RULE_KINDS, serializeRibbonDiff,
} from "../core/ribbonModel";
import { publishRibbonDiff } from "../core/ribbonPublish";
import { resolveWebResourceName, webResourceFiles, webResourceType } from "../core/solutions";
import { readZip } from "../core/zip";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, reportError, resolveClient, withProgress, write } from "../ui/context";
import { MetaNode } from "../ui/metadataTree";
import { CommandBarDraft, openCommandBarPanel } from "../ui/panels/commandBarPanel";
import { goToHandler, pickTable } from "./metadata";
import { DataverseContentProvider } from "./webResources";

/**
 * Open Command Bar…: the table's ribbon from RetrieveEntityRibbon (form, main grid
 * and subgrid) and its modern commands (appaction rows), the client's own
 * RibbonDiffXml from the local solution folders laid over it, and every JavaScript
 * reference checked against the workspace, as an editor tab where the client's own
 * parts can be edited. Save writes the RibbonDiffXml to the solution folder, the
 * modern commands to the environment, and can publish the classic bar through a
 * solution import.
 */

const env = (c: Client) => c.envName || c.orgHost;

/** The RibbonXml inside the zip RetrieveEntityRibbon returns (base64). */
export function ribbonXmlFromZip(compressedBase64: string): string {
  const entries = readZip(Buffer.from(compressedBase64, "base64"));
  const entry = entries.find((e) => /ribbon/i.test(e.name) && e.name.toLowerCase().endsWith(".xml")) ?? entries.find((e) => e.name.toLowerCase().endsWith(".xml") && !/content_types/i.test(e.name));
  if (!entry) throw new UserError("The ribbon Dataverse returned has no XML in it.");
  return entry.data.toString("utf8").replace(/^﻿/, "");
}

/** The merged ribbon of a table at one location. */
export async function fetchRibbon(dv: DataverseClient, table: string, location: RibbonLocation): Promise<RibbonModel> {
  const result = await dv.getJson<{ CompressedEntityXml?: string }>(
    `RetrieveEntityRibbon(EntityName=@p1,RibbonLocationFilter=@p2)?@p1=${encodeURIComponent(`'${table.replace(/'/g, "''")}'`)}&@p2=${encodeURIComponent(`Microsoft.Dynamics.CRM.RibbonLocationFilters'${location}'`)}`
  );
  if (!result.CompressedEntityXml) throw new UserError(`Dataverse returned no ribbon for ${table} (${location}).`);
  return parseRibbonXml(ribbonXmlFromZip(result.CompressedEntityXml), table, location);
}

/** The table's command bar at every location, in one model. */
export async function loadCommandBar(dv: DataverseClient, table: string): Promise<RibbonModel> {
  return mergeRibbons(await Promise.all(LOCATIONS.map((loc) => fetchRibbon(dv, table, loc))));
}

/** The table from a tree node, or picked from the org. */
async function tableFor(arg: unknown, serviceFor: (c: Client) => MetadataService): Promise<{ client: Client; table: TableMeta } | undefined> {
  const node = arg as MetaNode | undefined;
  if (node && typeof node === "object" && node.kind === "table") return { client: node.client, table: node.table };
  const client = await resolveClient(arg);
  if (!client?.config.org) return undefined;
  const table = await pickTable(client, serviceFor(client), "Open the command bar of a table (type a display name or logical name)");
  return table ? { client, table } : undefined;
}

const IMAGE_MIME: Record<number, string> = { 5: "image/png", 6: "image/jpeg", 7: "image/gif", 10: "image/x-icon", 11: "image/svg+xml" };
const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

/** The web resources in the client folder, by name: scripts for libraries, images for icons. */
export function workspaceWebResources(client: Client): { scripts: string[]; images: string[] } {
  const scripts: string[] = [];
  const images: string[] = [];
  for (const file of webResourceFiles(client)) {
    const name = resolveWebResourceName(file, client)?.name;
    const type = webResourceType(file);
    if (!name || !type) continue;
    if (type === 3) scripts.push(name);
    else if (IMAGE_MIME[type]) images.push(name);
  }
  return { scripts: [...new Set(scripts)].sort(), images: [...new Set(images)].sort() };
}

/** An icon web resource as a data: URI: the local file, or the environment's copy. */
export async function iconDataUri(client: Client, dv: DataverseClient, name: string, cache: Map<string, Promise<string | undefined>>): Promise<string | undefined> {
  const key = name.toLowerCase();
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const local = findWebResourceFile(client, name);
      if (local) {
        const mime = MIME_BY_EXT[path.extname(local).toLowerCase()] ?? IMAGE_MIME[webResourceType(local) ?? 0];
        if (mime) return `data:${mime};base64,${fs.readFileSync(local).toString("base64")}`;
      }
      try {
        const wr = await dv.findWebResource(name);
        const mime = wr && IMAGE_MIME[wr.type];
        return wr && mime && wr.content ? `data:${mime};base64,${wr.content}` : undefined;
      } catch {
        return undefined;
      }
    })());
  }
  return cache.get(key);
}

/** The JavaScript references of a model against the client folder. */
export function referenceProblems(client: Client, model: RibbonModel): RibbonProblem[] {
  return checkRibbonReferences(
    model,
    (webResource) => {
      const file = findWebResourceFile(client, webResource);
      if (!file) return undefined;
      try {
        return { file, text: fs.readFileSync(file, "utf8") };
      } catch {
        return undefined;
      }
    },
    (text, fn) => !!findFunction(text, fn)
  );
}

/** Writes the RibbonDiffXml to the local file: a RibbonDiff.xml as a whole, or the table's entity in a customizations.xml. */
export function writeLocalRibbonDiff(file: string, table: string, diffXml: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  let out: string;
  if (path.basename(file).toLowerCase() === "customizations.xml") {
    const patched = replaceEntityRibbonDiff(existing, table, diffXml);
    if (patched === undefined) throw new UserError(`${file} has no <Entity> for ${table}.`);
    out = patched;
  } else {
    out = ribbonDiffFile({ xml: diffXml, counts: { controls: 0, hidden: 0, commands: 0, rules: 0, labels: 0 } });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.replace(/\r?\n/g, eol));
}

const classicOnly = (m: RibbonModel): RibbonModel => ({ ...m, modern: [] });

/**
 * The local RibbonDiffXml the page edits and writes back: the first of the client's
 * solutions that has one for the table, else the first found. Only one, since the layer
 * goes into one file and is published through one solution; the others are shown as
 * another solution's, so nothing of theirs moves into it.
 */
export function localRibbonTarget(local: LocalRibbonDiff[], solutions: string[]): LocalRibbonDiff | undefined {
  for (const s of solutions) {
    const hit = local.find((l) => l.solution.toLowerCase() === s.toLowerCase());
    if (hit) return hit;
  }
  return local[0];
}

export async function openCommandBar(arg: unknown, serviceFor: (c: Client) => MetadataService, remote: DataverseContentProvider): Promise<void> {
  const target = await tableFor(arg, serviceFor);
  if (!target) return;
  const { client, table } = target;
  const dv = dataverseFor(client);
  const loaded = await withProgress(`Loading the ${table.displayName} command bar from ${env(client)}`, async () => {
    const [model, modern, apps] = await Promise.all([loadCommandBar(dv, table.logicalName), fetchModernCommands(dv, table.logicalName), fetchApps(dv).catch(() => [])]);
    model.modern = modern;
    let solutions = client.config.solutions.slice();
    if (!solutions.length) solutions = (await fetchOrgSolutions(dv).catch(() => [])).filter((s) => !s.managed).map((s) => s.uniqueName);
    const prefix = client.config.publisherPrefix || (await publisherPrefix(dv, solutions[0]).catch(() => undefined)) || "";
    return { model, apps, solutions, prefix };
  });
  if (!loaded) return;
  const { model, apps, solutions, prefix } = loaded;
  const local = findRibbonDiffs(client.dir, table.logicalName);
  const mine = localRibbonTarget(local, solutions);
  const others = local.filter((l) => l !== mine);
  for (const l of others) applyDiff(model, l.diff, "other");
  if (mine) applyDiff(model, mine.diff, "client");
  const original: RibbonModel = JSON.parse(JSON.stringify(model));
  const { scripts, images } = workspaceWebResources(client);
  const icons = new Map<string, Promise<string | undefined>>();
  const localTarget = mine?.file ?? ribbonDiffPathFor(client.dir, table.logicalName);
  const otherSolutions = [...new Set(others.map((l) => l.solution))];
  // original.modern follows what each Save writes, so saving again after a failure doesn't repeat it.
  const modernSaves = new ModernSaveTracker(original.modern);
  let saved: string[] = [];

  const result = await openCommandBarPanel(
    {
      subtitle: `${table.logicalName} in ${env(client)} · your RibbonDiffXml and modern commands can be edited; Microsoft's buttons can be hidden${otherSolutions.length ? ` · ${otherSolutions.join(", ")}'s RibbonDiffXml is shown, not edited` : ""}`,
      table: table.logicalName,
      tableLabel: table.displayName,
      env: env(client),
      localSolutions: mine ? [mine.solution] : [],
      localFiles: mine ? [mine.file] : [],
      localTarget,
      prefix,
      solutions,
      apps,
      scripts,
      images,
      ruleKinds: RULE_KINDS,
      parameterKinds: PARAMETER_KINDS,
      crmParameters: CRM_PARAMETER_VALUES,
      draft: { model, publish: false, solution: solutions.find((s) => mine && s.toLowerCase() === mine.solution.toLowerCase()) ?? solutions[0] ?? "", writeLocal: !!localTarget },
    },
    original,
    {
      open: (webResource, functionName) => goToHandler(client, webResource, functionName, remote),
      openFile: async (file) => {
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      },
      icon: (name) => iconDataUri(client, dv, name, icons),
      check: (m) => referenceProblems(client, m),
      explain: (step) => explainStep(step),
      submit: async (draft) => {
        saved = [];
        const classicChanges = ribbonChanges(classicOnly(original), classicOnly(draft.model));
        const modern = modernSaves.changes(draft.model.modern);
        const modernCount = modern.create.length + modern.update.length + modern.remove.length;
        if (draft.publish && classicChanges.length && !(await confirmProtected(client, `Publish the ${table.logicalName} command bar through ${draft.solution}`))) return "Publishing was cancelled; nothing was saved.";
        if (modernCount && !(await confirmProtected(client, `Write ${modernCount} modern command${modernCount === 1 ? "" : "s"} to ${env(client)}`))) return "Saving was cancelled; nothing was written.";
        const ok = await withProgress(`Saving the ${table.displayName} command bar`, async (ctx, progress) => {
          if (classicChanges.length) {
            const layer = serializeRibbonDiff(draft.model);
            const removed = removedParts(original, draft.model);
            if (draft.writeLocal && localTarget) {
              // What the file defines that the layer doesn't (and the page didn't remove) would be lost by writing it.
              const lost = mine ? lostParts(mine.diff, layer.xml, removed) : [];
              if (lost.length) throw new UserError(`Writing ${path.basename(localTarget)} would drop ${lost.slice(0, 10).join(", ")}${lost.length > 10 ? ` and ${lost.length - 10} more` : ""}. Nothing was written.`);
              progress.report({ message: `writing ${path.basename(localTarget)}` });
              writeLocalRibbonDiff(localTarget, table.logicalName, layer.xml);
              saved.push(`RibbonDiffXml written to ${path.relative(client.dir, localTarget)}`);
            }
            if (draft.publish) {
              // Built against what the solution holds now, so what the page never showed (a Ribbon Workbench button) stays in it.
              const layerFor = (published: RibbonDiff) => ({ xml: serializeRibbonDiff(mergePublishedDiff(draft.model, original, published)).xml, removed });
              await publishRibbonDiff(dv, draft.solution, table.logicalName, layerFor, (line) => {
                progress.report({ message: line });
                write(`${line}\n`);
              });
              saved.push(`published through ${draft.solution} to ${env(client)}`);
            } else if (!draft.writeLocal || !localTarget) {
              saved.push("classic changes kept nowhere (neither written locally nor published)");
            }
          }
          if (modernCount) {
            progress.report({ message: "modern commands" });
            await saveModernCommands(dv, modern, {
              table: table.logicalName,
              solution: draft.solution || client.config.solutions[0],
              webResourceId: async (name) => (await dv.findWebResource(name))?.id,
              log: (line) => {
                progress.report({ message: line });
                write(`${line}\n`);
              },
              written: modernSaves.written,
            });
            saved.push(`${modernCount} modern command${modernCount === 1 ? "" : "s"} written to ${env(client)}`);
          }
          return true;
        });
        if (!ok) return "Saving stopped: see the error. What was written before it stayed written.";
        return undefined;
      },
    }
  );
  if (!result) return;
  const choice = await vscode.window.showInformationMessage(`${table.displayName} command bar: ${saved.join(", ") || "nothing to save"}.`, "Reopen");
  if (choice) await openCommandBar(arg, serviceFor, remote);
}

/** Used by tests: the draft type, so they can build one. */
export type { CommandBarDraft };

export function registerCommandBar(serviceFor: (c: Client) => MetadataService, remote: DataverseContentProvider): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("lantern.commandBar.open", async (arg?: unknown) => {
      try {
        await openCommandBar(arg, serviceFor, remote);
      } catch (err) {
        reportError(err);
      }
    }),
  ];
}
