import * as fs from "fs";
import * as path from "path";
import { DataverseClient } from "./dataverse";
import { findFiles } from "./files";
import { FormMeta } from "./metadata";
import { csMethodAt, functionAt, outlineJs } from "./codeanalysis";

const EVENT_LABEL: Record<string, string> = { onload: "OnLoad", onsave: "OnSave", onchange: "OnChange", tabstatechange: "TabStateChange" };

/** Where a library's function runs: "Account (Main) OnChange of address1_line2". */
export function registrationsOf(forms: FormMeta[], library: string | undefined, fn: string): string[] {
  if (!library) return [];
  const out: string[] = [];
  for (const f of forms) {
    for (const e of f.events) {
      for (const h of e.handlers) {
        const last = h.functionName.split(".").pop();
        if (h.libraryName.toLowerCase() !== library.toLowerCase() || (h.functionName !== fn && last !== fn)) continue;
        const label = `${f.name} (${f.type}) ${EVENT_LABEL[e.name] ?? e.name}${e.attribute ? ` of ${e.attribute}` : ""}`;
        if (!out.includes(label)) out.push(label);
      }
    }
  }
  return out;
}

export interface UsageReport {
  table: string;
  column: string;
  forms: Array<{ form: string; type: string; where: string[] }>;
  views: Array<{ name: string; kind: string; uses: string[] }>;
  processes: Array<{ name: string; category: string; active: boolean }>;
  steps: Array<{ name: string; message: string; active: boolean }>;
  code: Array<{
    file: string;
    line: number;
    text: string;
    /** Enclosing function (JS) or method (C#). */
    fn?: string;
    /** Where that function runs, e.g. "Account (Main) OnChange of address1_line2". */
    runsOn?: string[];
  }>;
  /** Sections that couldn't be searched, with the reason (usually permissions). */
  failures: Array<{ section: string; message: string }>;
}

const VIEW_KIND: Record<number, string> = {
  0: "Public view", 1: "Advanced find", 2: "Associated view", 4: "Quick find", 64: "Lookup view", 8192: "Saved query",
};
const CATEGORY: Record<number, string> = {
  0: "Workflow", 1: "Dialog", 2: "Business rule", 3: "Action", 4: "Business process flow", 5: "Cloud flow", 6: "Desktop flow",
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a form uses the column: bound controls (by tab and section) and change handlers. */
export function formUsages(forms: FormMeta[], column: string): UsageReport["forms"] {
  const out: UsageReport["forms"] = [];
  for (const f of forms) {
    const where: string[] = [];
    if (f.header.some((c) => c.field === column)) where.push("header");
    for (const tab of f.tabs) {
      for (const s of tab.sections) {
        for (const c of s.controls) {
          if (c.field !== column) continue;
          const place = `${tab.label || tab.name} > ${s.label || s.name}${c.kind === "composite-part" ? ` (inside ${c.id.split("_compositionLinkControl_")[0]})` : ""}${c.visible ? "" : " (hidden)"}`;
          if (!where.includes(place)) where.push(place);
        }
      }
    }
    for (const e of f.events) {
      if (e.attribute === column) for (const h of e.handlers) where.push(`OnChange runs ${h.libraryName}: ${h.functionName}`);
    }
    if (where.length) out.push({ form: f.name, type: f.type, where });
  }
  return out;
}

/** Lines in the client's own code that mention the column as a string, e.g. getAttribute("fax") or entity["fax"]. */
/**
 * Lines in the client's own code that name the column, with the function each sits in.
 * runsOn(file, fn) says where a script function is registered, when known.
 */
export function codeUsages(clientDir: string, column: string, runsOn?: (file: string, fn: string) => string[]): UsageReport["code"] {
  const re = new RegExp(`["'\`]${escapeRe(column)}["'\`]`, "i");
  // Extensionless files under WebResources are scripts named without ".js" in Dataverse.
  const files = findFiles(
    clientDir,
    (name, full) =>
      (/\.(js|ts|cs|html?)$/i.test(name) && !name.endsWith(".d.ts")) ||
      (!path.extname(name) && full.split(path.sep).some((part) => part.toLowerCase() === "webresources"))
  );
  const hits: UsageReport["code"] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!re.test(text)) continue;
    const isCs = /\.cs$/i.test(file);
    const outline = isCs ? [] : outlineJs(text);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    text.split(/\r?\n/).forEach((line, i) => {
      if (!re.test(line)) return;
      const fn = isCs ? csMethodAt(text, i) : functionAt(outline, lineStarts[i] + Math.max(0, line.search(re)))?.name;
      hits.push({ file, line: i + 1, text: line.trim().slice(0, 160), fn, runsOn: fn && !isCs && runsOn ? runsOn(file, fn) : undefined });
    });
  }
  return hits;
}

export async function findUsages(
  dv: DataverseClient,
  table: string,
  column: string,
  forms: FormMeta[],
  clientDir: string,
  webResourceName?: (file: string) => string | undefined
): Promise<UsageReport> {
  const runsOn = (file: string, fn: string) => registrationsOf(forms, webResourceName?.(file), fn);
  const report: UsageReport = { table, column, forms: formUsages(forms, column), views: [], processes: [], steps: [], code: codeUsages(clientDir, column, runsOn), failures: [] };
  const word = new RegExp(`(^|[^\\w])${escapeRe(column)}([^\\w]|$)`, "i");
  const attr = (name: string) => new RegExp(`${name}\\s*=\\s*["']${escapeRe(column)}["']`, "i");

  const section = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      report.failures.push({ section: name, message: err instanceof Error ? err.message : String(err) });
    }
  };

  await Promise.all([
    section("Views", async () => {
      const rows = await dv.getAll<{ name: string; querytype: number; fetchxml: string | null; layoutxml: string | null }>(
        `savedqueries?$select=name,querytype,fetchxml,layoutxml&$filter=returnedtypecode eq '${table}'`
      );
      for (const v of rows) {
        const uses: string[] = [];
        const fx = v.fetchxml ?? "";
        if (attr("name").test(v.layoutxml ?? "")) uses.push("shown as a column");
        if (/<condition\b[^>]*>/i.test(fx) && [...fx.matchAll(/<condition\b[^>]*>/gi)].some((m) => attr("attribute").test(m[0]))) uses.push("filter");
        if ([...fx.matchAll(/<order\b[^>]*>/gi)].some((m) => attr("attribute").test(m[0]))) uses.push("sort");
        if (!uses.length && [...fx.matchAll(/<attribute\b[^>]*>/gi)].some((m) => attr("name").test(m[0]))) uses.push("retrieved");
        if (uses.length) report.views.push({ name: v.name, kind: VIEW_KIND[v.querytype] ?? `Type ${v.querytype}`, uses });
      }
    }),
    section("Processes", async () => {
      const rows = await dv.getAll<{ name: string; category: number; statecode: number; xaml: string | null }>(
        `workflows?$select=name,category,statecode,xaml&$filter=primaryentity eq '${table}' and type eq 1`
      );
      for (const w of rows) {
        if (word.test(w.xaml ?? "")) report.processes.push({ name: w.name, category: CATEGORY[w.category] ?? `Category ${w.category}`, active: w.statecode === 1 });
      }
    }),
    section("Plug-in steps", async () => {
      const rows = await dv.getAll<{ name: string; statecode: number; filteringattributes: string | null; sdkmessageid?: { name?: string } | null }>(
        `sdkmessageprocessingsteps?$select=name,statecode,filteringattributes&$expand=sdkmessageid($select=name)` +
          `&$filter=sdkmessagefilterid/primaryobjecttypecode eq '${table}'`
      );
      for (const s of rows) {
        const attrs = (s.filteringattributes ?? "").split(",").map((a) => a.trim().toLowerCase());
        if (attrs.includes(column)) report.steps.push({ name: s.name, message: s.sdkmessageid?.name ?? "", active: s.statecode === 0 });
      }
    }),
  ]);
  return report;
}

export function usageMarkdown(r: UsageReport, columnLabel: string, fileLink: (file: string, line: number) => string, clientDir: string): string {
  const total = r.forms.length + r.views.length + r.processes.length + r.steps.length + r.code.length;
  const lines = [`# Where ${columnLabel} (\`${r.column}\`) is used`, "", `Table \`${r.table}\`. ${total ? `Found in ${total} place${total === 1 ? "" : "s"}.` : "No uses found."}`, ""];

  lines.push(`## Forms (${r.forms.length})`, "");
  if (!r.forms.length) lines.push("Not on any form. `getAttribute` returns `null` for it in form scripts.", "");
  for (const f of r.forms) {
    lines.push(`**${f.form}** (${f.type})`, "", ...f.where.map((w) => `- ${w}`), "");
  }

  lines.push(`## Views (${r.views.length})`, "");
  for (const v of r.views) lines.push(`- **${v.name}** (${v.kind}): ${v.uses.join(", ")}`);
  lines.push("");

  lines.push(`## Business rules, workflows, and actions (${r.processes.length})`, "");
  for (const p of r.processes) lines.push(`- **${p.name}** (${p.category}${p.active ? "" : ", inactive"})`);
  lines.push("");

  lines.push(`## Plug-in steps filtering on it (${r.steps.length})`, "");
  for (const s of r.steps) lines.push(`- **${s.name}** (${s.message}${s.active ? "" : ", disabled"})`);
  if (r.steps.length) lines.push("", "Update steps with no filtering columns also run when it changes; they aren't listed here.");
  lines.push("");

  lines.push(`## Code in this client folder (${r.code.length})`, "");
  for (const c of r.code) {
    const where = c.fn ? ` in **${c.fn}**${c.runsOn?.length ? ` (runs on ${c.runsOn.join("; ")})` : ""}` : "";
    lines.push(`- [${path.relative(clientDir, c.file).split(path.sep).join("/")}:${c.line}](${fileLink(c.file, c.line)})${where}: \`${c.text.replace(/`/g, "'")}\``);
  }
  lines.push("");

  if (r.failures.length) {
    lines.push("## Not searched", "");
    for (const f of r.failures) lines.push(`- ${f.section}: ${f.message}`);
    lines.push("");
  }
  lines.push("Cloud flows and canvas apps aren't searched.", "");
  return lines.join("\n");
}
