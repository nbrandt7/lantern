import * as crypto from "crypto";
import { DataverseClient, timing } from "./dataverse";
import { UserError } from "./errors";
import { entityRibbonDiff, lostParts, parseRibbonDiff, replaceEntityRibbonDiff, RibbonDiff } from "./ribbonModel";
import { readZip, writeZip } from "./zip";

/**
 * Getting a RibbonDiffXml into the environment: Dataverse only takes a ribbon through
 * a solution import, so the solution that holds the table is exported, its
 * customizations.xml gets the new RibbonDiffXml for the table, the zip goes back in,
 * and the table is published. A small solution with just the table is fastest; a big
 * one works but takes as long as its export and import do.
 */

export async function exportSolutionZip(dv: DataverseClient, solution: string): Promise<Buffer> {
  const r = await dv.actionJson<{ ExportSolutionFile?: string }>("ExportSolution", { SolutionName: solution, Managed: false });
  if (!r.ExportSolutionFile) throw new UserError(`Dataverse returned no file for solution ${solution}.`);
  return Buffer.from(r.ExportSolutionFile, "base64");
}

/** The table's RibbonDiffXml in an exported solution zip, as read; empty when there's none. */
export function solutionRibbonDiff(zip: Buffer, table: string): RibbonDiff {
  const entry = readZip(zip).find((e) => e.name.toLowerCase() === "customizations.xml");
  return parseRibbonDiff((entry && entityRibbonDiff(entry.data.toString("utf8"), table)) ?? "");
}

/** The exported zip with the table's RibbonDiffXml replaced. Throws when the solution doesn't hold the table. */
export function patchSolutionZip(zip: Buffer, solution: string, table: string, diffXml: string): Buffer {
  const entries = readZip(zip);
  const idx = entries.findIndex((e) => e.name.toLowerCase() === "customizations.xml");
  if (idx < 0) throw new UserError(`The export of ${solution} has no customizations.xml.`);
  const text = entries[idx].data.toString("utf8");
  const patched = replaceEntityRibbonDiff(text, table, diffXml);
  if (patched === undefined) throw new UserError(`Solution ${solution} doesn't contain the ${table} table. Add the table to the solution (Add to Solution, metadata only is enough), then save again.`);
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  entries[idx] = { name: entries[idx].name, data: Buffer.from(bom + patched.replace(/^﻿/, ""), "utf8") };
  return writeZip(entries);
}

/** Imports a solution zip and waits for the import job; throws with Dataverse's message when it fails. */
export async function importSolutionZip(dv: DataverseClient, zip: Buffer, log?: (line: string) => void): Promise<void> {
  const r = await dv.actionJson<{ AsyncOperationId?: string; ImportJobKey?: string }>("ImportSolutionAsync", {
    CustomizationFile: zip.toString("base64"),
    OverwriteUnmanagedCustomizations: false,
    PublishWorkflows: false,
    ImportJobId: crypto.randomUUID(),
  });
  if (!r.AsyncOperationId) throw new UserError("Dataverse accepted the import but returned no job to wait for.");
  const started = Date.now();
  for (;;) {
    await timing.sleep(2000);
    const job = await dv.getJson<{ statecode: number; statuscode: number; message?: string | null }>(`asyncoperations(${r.AsyncOperationId})?$select=statecode,statuscode,message`);
    if (job.statecode === 3) {
      if (job.statuscode === 30) return;
      throw new UserError(`The solution import ${job.statuscode === 32 ? "was cancelled" : "failed"}.${job.message ? ` ${job.message.slice(0, 1500)}` : ""}`);
    }
    log?.(`Import running (${Math.round((Date.now() - started) / 1000)} s)`);
    if (Date.now() - started > 30 * 60_000) throw new UserError("The solution import is still running after 30 minutes. Check it in the maker portal.");
  }
}

export async function publishTable(dv: DataverseClient, table: string): Promise<void> {
  await dv.action("PublishXml", { ParameterXml: `<importexportxml><entities><entity>${table}</entity></entities></importexportxml>` });
}

/**
 * The RibbonDiffXml to publish, built from what the solution holds for the table now, with
 * what the page removed on purpose (in ribbonDiffParts' words): only those may leave it.
 */
export type RibbonLayerFor = (published: RibbonDiff) => { xml: string; removed?: Iterable<string> };

/**
 * Export, patch, import, publish. The import replaces the table's whole RibbonDiffXml, so
 * anything the solution has that the new one doesn't (and that wasn't removed on purpose)
 * stops it before the import.
 */
export async function publishRibbonDiff(dv: DataverseClient, solution: string, table: string, layer: string | RibbonLayerFor, log?: (line: string) => void): Promise<void> {
  log?.(`Exporting ${solution}`);
  const zip = await exportSolutionZip(dv, solution);
  const published = solutionRibbonDiff(zip, table);
  const { xml: diffXml, removed } = typeof layer === "string" ? { xml: layer, removed: undefined } : layer(published);
  const lost = lostParts(published, diffXml, removed);
  if (lost.length) {
    throw new UserError(`Publishing would remove ${lost.slice(0, 10).join(", ")}${lost.length > 10 ? ` and ${lost.length - 10} more` : ""} from the ${table} command bar in ${solution}. Nothing was imported.`);
  }
  const patched = patchSolutionZip(zip, solution, table, diffXml);
  log?.(`Importing ${solution} with the new command bar`);
  await importSolutionZip(dv, patched, log);
  log?.(`Publishing ${table}`);
  await publishTable(dv, table);
}
