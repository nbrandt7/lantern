import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { fetchEnvVars, fetchSolutionWebResources, fetchSteps } from "../core/admin";
import { Client } from "../core/clients";
import { outlineJs } from "../core/codeanalysis";
import { findWebResourceFile } from "../core/handlers";
import { FormMeta, MetadataService } from "../core/metadata";
import { registrationsOf } from "../core/references";
import { ribbonLabels, scanRibbonFunctions } from "../core/ribbon";
import { dataverseFor } from "../ui/auth";
import { reportError, withProgress } from "../ui/context";

const WR_TYPE: Record<number, string> = { 1: "HTML", 2: "CSS", 3: "JavaScript", 4: "XML", 5: "PNG", 6: "JPG", 7: "GIF", 8: "XAP", 9: "XSL", 10: "ICO", 11: "SVG", 12: "RESX" };
const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** A handoff document for one solution, written into the client's docs folder. */
export async function solutionDocument(client: Client, unique: string, service: MetadataService): Promise<string> {
  const dv = dataverseFor(client);
  const [solution] = await dv.getAll<Record<string, string>>(
    `solutions?$select=solutionid,friendlyname,version,description,_publisherid_value&$filter=uniquename eq '${unique.replace(/'/g, "''")}'`,
    { Prefer: 'odata.include-annotations="*"' }
  );
  // Parts that can't be read are named in the document, not shown as empty.
  const unread: string[] = [];
  const orNote = <T>(part: string, p: Promise<T[]>) =>
    p.catch((err: unknown) => {
      unread.push(`${part}: ${err instanceof Error ? err.message : String(err)}`);
      return [] as T[];
    });
  const [allTables, tableNames, webResources, steps, envVars] = await Promise.all([
    service.tables(),
    service.solutionTables([unique]),
    orNote("Web resources", fetchSolutionWebResources(dv, unique)),
    orNote("Plug-in steps", fetchSteps(dv)),
    orNote("Environment variables", fetchEnvVars(dv)),
  ]);
  const tables = allTables.filter((t) => tableNames.includes(t.logicalName));
  const lines: string[] = [`# ${solution?.friendlyname ?? unique}`, ""];
  lines.push(`Solution \`${unique}\`, version ${solution?.version ?? "?"}${solution ? `, publisher ${solution["_publisherid_value@OData.Community.Display.V1.FormattedValue"] ?? ""}` : ""}. Generated from ${client.orgHost} on ${new Date().toLocaleDateString()}.`, "");
  if (solution?.description) lines.push(solution.description, "");

  const allForms: FormMeta[] = [];
  lines.push(`## Tables (${tables.length})`, "");
  for (const t of tables) {
    const [columns, forms] = await Promise.all([service.columns(t.logicalName), service.forms(t.logicalName)]);
    allForms.push(...forms);
    const custom = columns.filter((c) => c.isCustom && !c.attributeOf);
    lines.push(`### ${t.displayName} (\`${t.logicalName}\`)`, "");
    if (custom.length) {
      lines.push("| Column | Logical name | Type | Required |", "|---|---|---|---|");
      for (const c of custom) lines.push(`| ${cell(c.displayName)} | \`${c.logicalName}\` | ${c.type}${c.options?.length ? ` (${c.options.map((o) => `${o.value} ${o.label}`).join(", ")})` : ""} | ${c.requiredLevel === "None" ? "" : c.requiredLevel} |`);
      lines.push("");
    } else lines.push("No custom columns.", "");
    for (const f of forms) {
      const handlers = f.events.flatMap((e) => e.handlers.map((h) => `${e.name}${e.attribute ? ` of ${e.attribute}` : ""}: \`${h.functionName}\` in ${h.libraryName}`));
      lines.push(`- **${f.name}** (${f.type} form)${f.libraries.length ? `, libraries: ${f.libraries.join(", ")}` : ""}`);
      for (const h of handlers) lines.push(`  - ${h}`);
    }
    lines.push("");
  }

  lines.push(`## Web resources (${webResources.length})`, "");
  const ribbon = scanRibbonFunctions(client.dir, true);
  for (const w of webResources) {
    lines.push(`- \`${w.name}\` (${WR_TYPE[w.type] ?? w.type})${w.displayName !== w.name ? `: ${w.displayName}` : ""}`);
    const file = w.type === 3 ? findWebResourceFile(client, w.name) : undefined;
    if (!file) continue;
    for (const fn of outlineJs(fs.readFileSync(file, "utf8"))) {
      const runs = [...registrationsOf(allForms, w.name, fn.name), ...ribbonLabels(ribbon.get(w.name.toLowerCase()), fn.written)];
      lines.push(`  - \`${fn.name}\`${runs.length ? `: ${runs.join("; ")}` : ""}`);
    }
  }
  lines.push("");

  const solutionTables = new Set(tables.map((t) => t.logicalName));
  const relevantSteps = steps.filter((s) => solutionTables.has(s.table));
  lines.push(`## Plug-in steps on these tables (${relevantSteps.length})`, "");
  if (relevantSteps.length) {
    lines.push("| Step | Message | Stage | Mode | Filtering | On |", "|---|---|---|---|---|---|");
    for (const s of relevantSteps) lines.push(`| ${cell(s.name)} | ${s.message} of ${s.table} | ${s.stage} | ${s.mode} | ${cell(s.filtering)} | ${s.enabled ? "yes" : "no"} |`);
    lines.push("");
  }
  // The solution's own environment variables (component type 380), not a guess from names.
  const varIds = new Set(
    (
      await dv
        .getAll<{ objectid: string }>(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${solution?.solutionid} and componenttype eq 380`)
        .catch((err: unknown) => {
          unread.push(`Environment variables: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Array<{ objectid: string }>;
        })
    ).map((c) => c.objectid.toLowerCase())
  );
  const vars = solution?.solutionid ? envVars.filter((v) => varIds.has(v.definitionId.toLowerCase())) : [];
  if (vars.length) {
    lines.push(`## Environment variables (${vars.length})`, "", "| Variable | Schema name | Type | Default |", "|---|---|---|---|");
    for (const v of vars) lines.push(`| ${cell(v.displayName)} | \`${v.schemaName}\` | ${v.type} | ${v.type === "Secret" ? "" : cell(v.defaultValue)} |`);
    lines.push("");
  }
  if (unread.length) lines.push("## Not included", "", "These couldn't be read when the document was generated:", "", ...unread.map((u) => `- ${u}`), "");
  return lines.join("\n");
}

export function registerDocs(serviceFor: (c: Client) => MetadataService): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("lantern.solutions.document", async (node: { client: Client; unique: string }) => {
      try {
        const md = await withProgress(`Documenting ${node.unique}`, () => solutionDocument(node.client, node.unique, serviceFor(node.client)));
        if (!md) return;
        const file = path.join(node.client.dir, "docs", `${node.unique}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, md);
        await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(file));
        void vscode.window.showInformationMessage(`Wrote ${path.relative(node.client.dir, file)}. Edit it, or regenerate it any time.`);
      } catch (err) {
        reportError(err);
      }
    }),
  ];
}
