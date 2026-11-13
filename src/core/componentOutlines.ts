import * as fs from "fs";
import * as path from "path";
import { functionAt, outlineJs } from "./codeanalysis";
import { projectPluginClasses } from "./csharp";
import { DataverseClient } from "./dataverse";
import { UserError } from "./errors";
import { connectorName, searchFlowsByUse } from "./flowAnalysis";
import { FormMeta } from "./metadata";
import { findUsages, registrationsOf, usageMarkdown } from "./references";
import { findPluginProjects } from "./solutions";

/**
 * Outlines for AI assistants to explain from: a plug-in (registration, every
 * step with its filters and images, and its source when the project is in the
 * folder), a web resource (content, forms it's on, solutions), and a column
 * (everything that can change it or how it behaves).
 */

const q = (s: string) => s.replace(/'/g, "''");
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const STAGE: Record<number, string> = { 10: "Pre-validation", 20: "Pre-operation", 30: "Main operation", 40: "Post-operation" };
const IMAGE: Record<number, string> = { 0: "pre-image", 1: "post-image", 2: "pre- and post-image" };
const shortName = (typeName: string) => typeName.split(/[.+]/).pop() ?? typeName;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- plug-ins ----------

interface AssemblyRow { pluginassemblyid: string; name: string; version: string; description: string | null; isolationmode: number; ismanaged: boolean; _packageid_value?: string | null }
interface TypeRow { plugintypeid: string; typename: string; name: string | null; friendlyname: string | null; description: string | null; isworkflowactivity: boolean; workflowactivitygroupname: string | null; _pluginassemblyid_value: string }
interface StepRow {
  sdkmessageprocessingstepid: string;
  name: string;
  description: string | null;
  stage: number;
  mode: number;
  rank: number;
  statecode: number;
  filteringattributes: string | null;
  configuration: string | null;
  asyncautodelete: boolean | null;
  _impersonatinguserid_value?: string | null;
  "_impersonatinguserid_value@OData.Community.Display.V1.FormattedValue"?: string;
  sdkmessageid?: { name?: string } | null;
  sdkmessagefilterid?: { primaryobjecttypecode?: string } | null;
}
interface ImageRow { name: string; entityalias: string; imagetype: number; attributes: string | null; _sdkmessageprocessingstepid_value: string }

async function stepsFor(dv: DataverseClient, typeIds: string[]): Promise<{ steps: Map<string, StepRow[]>; images: Map<string, ImageRow[]> }> {
  const steps = new Map<string, StepRow[]>();
  const images = new Map<string, ImageRow[]>();
  for (const id of typeIds) {
    const rows = await dv.getAll<StepRow>(
      `sdkmessageprocessingsteps?$select=name,description,stage,mode,rank,statecode,filteringattributes,configuration,asyncautodelete,_impersonatinguserid_value` +
        `&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode)&$filter=_plugintypeid_value eq ${id}`,
      { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' }
    );
    rows.sort((a, b) => (a.sdkmessagefilterid?.primaryobjecttypecode ?? "").localeCompare(b.sdkmessagefilterid?.primaryobjecttypecode ?? "") || (a.sdkmessageid?.name ?? "").localeCompare(b.sdkmessageid?.name ?? "") || a.stage - b.stage || a.rank - b.rank);
    steps.set(id, rows);
    for (let i = 0; i < rows.length; i += 30) {
      const filter = rows.slice(i, i + 30).map((s) => `_sdkmessageprocessingstepid_value eq ${s.sdkmessageprocessingstepid}`).join(" or ");
      for (const img of await dv.getAll<ImageRow>(`sdkmessageprocessingstepimages?$select=name,entityalias,imagetype,attributes,_sdkmessageprocessingstepid_value&$filter=${encodeURIComponent(filter)}`)) {
        const list = images.get(img._sdkmessageprocessingstepid_value) ?? [];
        list.push(img);
        images.set(img._sdkmessageprocessingstepid_value, list);
      }
    }
  }
  return { steps, images };
}

function stepLine(s: StepRow, images: ImageRow[]): string[] {
  const table = s.sdkmessagefilterid?.primaryobjecttypecode;
  const head = `- **${s.sdkmessageid?.name ?? "?"}${table && table !== "none" ? ` of ${table}` : ""}**: ${STAGE[s.stage] ?? `stage ${s.stage}`}, ${s.mode === 1 ? "asynchronous" : "synchronous"}, order ${s.rank}${s.statecode === 0 ? "" : ", **disabled**"}`;
  const lines = [head];
  if (s.filteringattributes) lines.push(`  - runs only when these change: ${s.filteringattributes}`);
  else if ((s.sdkmessageid?.name ?? "").toLowerCase() === "update") lines.push("  - no filtering columns: runs on every update");
  for (const img of images) lines.push(`  - ${IMAGE[img.imagetype] ?? "image"} "${img.entityalias}": ${img.attributes || "all columns"}`);
  if (s._impersonatinguserid_value) lines.push(`  - runs as ${s["_impersonatinguserid_value@OData.Community.Display.V1.FormattedValue"] ?? s._impersonatinguserid_value}`);
  if (s.configuration) lines.push(`  - unsecure configuration: ${clip(s.configuration.replace(/\s+/g, " "), 300)}`);
  if (s.description) lines.push(`  - description: ${clip(s.description, 200)}`);
  return lines;
}

/**
 * A plug-in by class (full or short type name, or display name) or a whole
 * assembly by name. With neither, the registered assemblies are listed.
 */
export async function outlinePlugin(dv: DataverseClient, input: { plugin?: string; assembly?: string }, clientDir: string): Promise<string> {
  const assemblies = await dv.getAll<AssemblyRow>("pluginassemblies?$select=pluginassemblyid,name,version,description,isolationmode,ismanaged,_packageid_value&$filter=customizationlevel eq 1&$orderby=name");
  const types = await dv.getAll<TypeRow>("plugintypes?$select=plugintypeid,typename,name,friendlyname,description,isworkflowactivity,workflowactivitygroupname,_pluginassemblyid_value&$filter=customizationlevel eq 1");
  const assemblyOf = (t: TypeRow) => assemblies.find((a) => a.pluginassemblyid === t._pluginassemblyid_value);
  const wantedAssembly = input.assembly?.trim().toLowerCase();
  const pool = wantedAssembly ? types.filter((t) => assemblyOf(t)?.name.toLowerCase() === wantedAssembly) : types;
  if (wantedAssembly && !assemblies.some((a) => a.name.toLowerCase() === wantedAssembly)) {
    const others = assemblies.filter((a) => !(a.ismanaged && /^Microsoft/i.test(a.name)));
    throw new UserError(`No plug-in assembly is named ${input.assembly}. Registered${others.length < assemblies.length ? " (besides Microsoft's)" : ""}: ${others.map((a) => a.name).join(", ") || "none"}.`);
  }

  const wanted = input.plugin?.trim().toLowerCase();
  if (!wanted && !wantedAssembly) {
    if (!assemblies.length) return "No custom plug-in assemblies are registered in this environment.";
    // customizationlevel 1 also takes in a hundred or so managed Microsoft assemblies; the tenant's own come first, with their classes.
    const isPlatform = (a: AssemblyRow) => a.ismanaged && /^Microsoft/i.test(a.name);
    const own = assemblies.filter((a) => !isPlatform(a));
    const platform = assemblies.filter(isPlatform);
    return [
      own.length ? "Plug-in assemblies (pass assembly or plugin to see one):" : "No plug-in assemblies besides Microsoft's are registered.",
      "",
      ...own.map((a) => {
        const classes = types.filter((t) => t._pluginassemblyid_value === a.pluginassemblyid);
        return `- ${a.name} ${a.version}${a.ismanaged ? " (managed)" : ""}: ${classes.map((t) => shortName(t.typename)).join(", ") || "no classes"}`;
      }),
      ...(platform.length ? ["", `Also ${platform.length} managed Microsoft assembl${platform.length === 1 ? "y" : "ies"}: ${platform.map((a) => a.name).join(", ")}.`] : []),
    ].join("\n");
  }

  let chosen: TypeRow[] = pool;
  if (wanted) {
    const exact = pool.filter((t) => t.typename.toLowerCase() === wanted || shortName(t.typename).toLowerCase() === wanted);
    const loose = exact.length ? exact : pool.filter((t) => t.typename.toLowerCase().includes(wanted) || (t.friendlyname ?? "").toLowerCase().includes(wanted) || (t.name ?? "").toLowerCase().includes(wanted));
    if (!loose.length) throw new UserError(`No registered plug-in class matches "${input.plugin}".`);
    if (loose.length > 1) return `${loose.length} plug-in classes match "${input.plugin}": ${loose.slice(0, 25).map((t) => `${t.typename} (in ${assemblyOf(t)?.name ?? "?"})`).join("; ")}. Pass the full type name.`;
    chosen = loose;
  }

  const { steps, images } = await stepsFor(dv, chosen.map((t) => t.plugintypeid));
  const lines: string[] = [];
  const byAssembly = new Map<string, TypeRow[]>();
  for (const t of chosen) byAssembly.set(t._pluginassemblyid_value, [...(byAssembly.get(t._pluginassemblyid_value) ?? []), t]);
  const projects = findPluginProjects(clientDir);
  for (const [assemblyId, list] of byAssembly) {
    const a = assemblies.find((x) => x.pluginassemblyid === assemblyId);
    lines.push(`# ${a?.name ?? "?"} ${a?.version ?? ""}`.trim(), "");
    lines.push([a?.isolationmode === 2 ? "sandboxed" : "not sandboxed", a?._packageid_value ? "in a plug-in package" : "", a?.ismanaged ? "managed" : "unmanaged"].filter(Boolean).join(" · "));
    if (a?.description) lines.push("", a.description);
    const project = projects.find((p) => p.assembly.toLowerCase() === (a?.name ?? "").toLowerCase());
    const classes = project ? projectPluginClasses(project.project, clientDir) : [];
    for (const t of list.sort((x, y) => x.typename.localeCompare(y.typename))) {
      const friendly = t.friendlyname && !GUID.test(t.friendlyname) && t.friendlyname !== t.typename ? t.friendlyname : "";
      lines.push("", `## ${t.typename}${t.isworkflowactivity ? " (workflow activity)" : ""}`);
      if (friendly) lines.push(`Display name: ${friendly}`);
      if (t.description) lines.push(`Description: ${t.description}`);
      if (t.isworkflowactivity && t.workflowactivitygroupname) lines.push(`Workflow group: ${t.workflowactivitygroupname}`);
      const own = steps.get(t.plugintypeid) ?? [];
      lines.push("", own.length ? "Steps:" : t.isworkflowactivity ? "Runs as a step in classic workflows, not from plug-in steps." : "No steps registered: it never runs.");
      for (const s of own) lines.push(...stepLine(s, images.get(s.sdkmessageprocessingstepid) ?? []));
      const cls = classes.find((c) => c.fullName === t.typename);
      if (cls && chosen.length === 1) {
        const source = fs.readFileSync(cls.file, "utf8");
        const cut = source.split(/\r?\n/).slice(0, 500).join("\n");
        lines.push("", `Source (${path.relative(clientDir, cls.file)}${cut.length < source.length ? ", first 500 lines" : ""}):`, "", "```csharp", cut, "```");
      } else if (cls) {
        lines.push("", `Source: ${path.relative(clientDir, cls.file)}:${cls.line + 1}`);
      } else if (chosen.length === 1) {
        lines.push("", project ? "Its class isn't in the project in this folder (removed or renamed?)." : "No project in this folder builds this assembly. Lantern's Get Source decompiles it into one.");
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ---------- web resources ----------

const WR_TYPE: Record<number, string> = { 1: "HTML", 2: "CSS", 3: "JavaScript", 4: "XML", 5: "PNG", 6: "JPG", 7: "GIF", 8: "Silverlight", 9: "XSL", 10: "ICO", 11: "SVG", 12: "RESX" };
const TEXT_TYPES = new Set([1, 2, 3, 4, 9, 11, 12]);

interface WebResourceRow { webresourceid: string; name: string; displayname: string | null; description: string | null; webresourcetype: number; ismanaged: boolean; content?: string | null }

/** Forms that load a library, with the events each of its functions handles. */
async function formsUsingLibrary(dv: DataverseClient, name: string): Promise<string[]> {
  const rows = await dv.getAll<{ name: string; objecttypecode: string; formxml: string | null }>(
    `systemforms?$select=name,objecttypecode,formxml&$filter=${encodeURIComponent(`contains(formxml,'${q(name)}')`)}`
  );
  const out: string[] = [];
  const attr = (tag: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`, "i").exec(tag)?.[1];
  for (const f of rows) {
    const xml = f.formxml ?? "";
    if (!new RegExp(`<Library\\b[^>]*name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i").test(xml)) continue;
    const handlers: string[] = [];
    for (const ev of xml.matchAll(/<event\b([^>]*)>([\s\S]*?)<\/event>/gi)) {
      for (const h of ev[2].matchAll(/<Handler\b[^>]*>/gi)) {
        if ((attr(h[0], "libraryName") ?? "").toLowerCase() !== name.toLowerCase()) continue;
        const column = attr(ev[1], "attribute");
        handlers.push(`${attr(h[0], "functionName")} on ${attr(ev[1], "name")}${column ? ` of ${column}` : ""}${attr(h[0], "enabled") === "false" ? " (disabled)" : ""}`);
      }
    }
    out.push(`- ${f.name} (${f.objecttypecode}): ${handlers.length ? handlers.join("; ") : "loaded, no event handlers"}`);
  }
  return out;
}

export async function outlineWebResource(dv: DataverseClient, nameOrPart: string): Promise<string> {
  const text = nameOrPart.trim();
  const select = "webresourceid,name,displayname,description,webresourcetype,ismanaged";
  let rows = await dv.getAll<WebResourceRow>(`webresourceset?$select=${select}&$filter=${encodeURIComponent(`name eq '${q(text)}'`)}`);
  if (!rows.length) {
    rows = await dv.getAll<WebResourceRow>(`webresourceset?$select=${select}&$filter=${encodeURIComponent(`contains(name,'${q(text)}') or contains(displayname,'${q(text)}')`)}`);
    if (!rows.length) throw new UserError(`No web resource's name contains "${text}".`);
    if (rows.length > 1) return `${rows.length} web resources match "${text}": ${rows.slice(0, 30).map((r) => r.name).join(", ")}. Pass the full name.`;
  }
  const r = rows[0];
  const full = await dv.getJson<WebResourceRow>(`webresourceset(${r.webresourceid})?$select=content`);
  const lines = [`# ${r.name}`, "", `${WR_TYPE[r.webresourcetype] ?? `type ${r.webresourcetype}`}${r.displayname && r.displayname !== r.name ? ` · "${r.displayname}"` : ""} · ${r.ismanaged ? "managed" : "unmanaged"}`];
  if (r.description) lines.push("", r.description);
  const solutions = await dv.getAll<{ _solutionid_value: string; "_solutionid_value@OData.Community.Display.V1.FormattedValue"?: string }>(
    `solutioncomponents?$select=_solutionid_value&$filter=componenttype eq 61 and objectid eq ${r.webresourceid}`,
    { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' }
  );
  const names = solutions.map((s) => s["_solutionid_value@OData.Community.Display.V1.FormattedValue"] ?? "").filter((n) => n && !/^(default solution|active solution)$/i.test(n));
  if (names.length) lines.push("", `Solutions: ${names.join(", ")}`);
  if (r.webresourcetype === 3) {
    try {
      const forms = await formsUsingLibrary(dv, r.name);
      lines.push("", "## Forms that load it", ...(forms.length ? forms : ["- none (it may be loaded from the ribbon, another script, or an HTML page)"]));
    } catch (err) {
      lines.push("", `## Forms that load it`, `- couldn't check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const content = full.content ? Buffer.from(full.content, "base64") : Buffer.alloc(0);
  if (TEXT_TYPES.has(r.webresourcetype)) {
    const source = content.toString("utf8").replace(/^\uFEFF/, "");
    if (r.webresourcetype === 3) {
      const fns = outlineJs(source).map((f) => f.written || f.name);
      if (fns.length) lines.push("", "## Functions", ...[...new Set(fns)].slice(0, 80).map((f) => `- ${f}`));
    }
    const cut = source.length > 60_000 ? `${source.slice(0, 60_000)}\n… (cut at 60,000 characters)` : source;
    const lang = { 1: "html", 2: "css", 3: "javascript", 4: "xml", 9: "xml", 11: "xml", 12: "xml" }[r.webresourcetype as 1] ?? "";
    lines.push("", "## Content", "", "```" + lang, cut, "```");
  } else {
    lines.push("", `${content.length.toLocaleString()} bytes of ${WR_TYPE[r.webresourcetype] ?? "binary"} data.`);
  }
  return lines.join("\n");
}

// ---------- tracing a column ----------

const SETTERS = /\.(setValue|setRequiredLevel|setVisible|setDisabled|setDefaultValue|addOnChange|removeOnChange|fireOnChange|setNotification|clearNotification|setSubmitMode|addPreSearch|addCustomFilter)\s*\(/;

/** Lines in deployed form libraries that use the column, with the function they're in and where it runs. */
async function formScriptHits(dv: DataverseClient, forms: FormMeta[], column: string): Promise<string[]> {
  const libraries = [...new Set(forms.flatMap((f) => f.libraries))];
  const quoted = new RegExp(`["'\`]${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`, "i");
  const out: string[] = [];
  for (const lib of libraries) {
    const wr = await dv.findWebResource(lib);
    if (!wr?.content) continue;
    const source = Buffer.from(wr.content, "base64").toString("utf8");
    if (!quoted.test(source)) continue;
    const outline = outlineJs(source);
    let offset = 0;
    // Split on \n alone and count the raw line, so a CRLF file's offsets don't drift a character per line.
    source.split("\n").forEach((raw, i) => {
      const line = raw.replace(/\r$/, "");
      const at = line.search(quoted);
      if (at >= 0) {
        const fn = functionAt(outline, offset + at)?.name;
        const runs = fn ? registrationsOf(forms, lib, fn) : [];
        const what = SETTERS.exec(line)?.[1];
        out.push(`- ${lib}:${i + 1}${fn ? ` in ${fn}()` : ""}${runs.length ? ` (runs on ${runs.join("; ")})` : ""}${what ? ` **${what}**` : ""}: \`${clip(line.trim(), 160)}\``);
      }
      offset += raw.length + 1;
    });
  }
  return out;
}

/** Code lines listed in a column trace or where-used answer for an AI tool; a common column name can match hundreds. */
export const TRACE_MAX_CODE_LINES = 40;

/**
 * Everything that can explain how a column behaves: its definition (calculated,
 * rollup, required, secured), forms and form scripts (deployed and local), business
 * rules and workflows, cloud flows that filter on it or write it, plug-in steps
 * that run when it changes or on every update, and the code that mentions it.
 */
export async function traceColumn(
  dv: DataverseClient,
  table: string,
  column: string,
  forms: FormMeta[],
  clientDir: string,
  webResourceName?: (file: string) => string | undefined
): Promise<string> {
  const lines = [`# What affects ${table}.${column}`];
  const problems: string[] = [];
  const section = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (err) {
      problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const meta = await section("Column definition", () => dv.getJson<Record<string, unknown>>(`EntityDefinitions(LogicalName='${q(table)}')/Attributes(LogicalName='${q(column)}')`));
  if (meta) {
    const label = (v: unknown) => (v as { UserLocalizedLabel?: { Label?: string } } | undefined)?.UserLocalizedLabel?.Label ?? "";
    const facts = [
      `${label(meta.DisplayName) || column} (${String(meta.AttributeTypeName && (meta.AttributeTypeName as { Value?: string }).Value || meta.AttributeType || "")})`,
      `required: ${(meta.RequiredLevel as { Value?: string } | undefined)?.Value ?? "?"}`,
      meta.SourceType === 1 ? "**calculated**" : meta.SourceType === 2 ? "**rollup**" : meta.SourceType === 3 ? "**formula (Power Fx)**" : "",
      meta.IsSecured ? "**field security**: only some users can read or change it" : "",
      meta.AutoNumberFormat ? `**autonumber** ${meta.AutoNumberFormat}` : "",
      meta.IsValidForUpdate === false ? "can't be updated after create" : "",
    ].filter(Boolean);
    lines.push("", "## Definition", `- ${facts.join(" · ")}`);
    if (label(meta.Description)) lines.push(`- description: ${label(meta.Description)}`);
    if (typeof meta.FormulaDefinition === "string" && meta.FormulaDefinition) lines.push(`- formula: \`${clip(meta.FormulaDefinition.replace(/\s+/g, " "), 1500)}\``);
    if (meta.DefaultFormValue !== undefined && meta.DefaultFormValue !== null && meta.DefaultFormValue !== -1) lines.push(`- default on new rows: ${meta.DefaultFormValue}`);
  }

  // Forms, views, business rules and workflows, filtered plug-in steps, local code.
  const usage = await section("Where it's used", () => findUsages(dv, table, column, forms, clientDir, webResourceName));
  // Absolute link targets: the AI client asking usually runs in another folder. Code lines are capped to keep the result in its size limit.
  if (usage) lines.push("", usageMarkdown(usage, `${table}.${column}`, (file, line) => `${file}:${line}`, clientDir, TRACE_MAX_CODE_LINES).replace(/^#\s.*\n/, ""));

  const scripts = await section("Form scripts", () => formScriptHits(dv, forms, column));
  if (scripts) lines.push("", "## Deployed form scripts", ...(scripts.length ? scripts : ["- no script on this table's forms mentions it"]));

  // Steps that run on every create or update of the table could change it without naming it in their filters.
  const broad = await section("Plug-in steps on every update", () => dv.getAll<{ name: string; stage: number; statecode: number; filteringattributes: string | null; sdkmessageid?: { name?: string } | null; plugintypeid?: { typename?: string } | null }>(
    `sdkmessageprocessingsteps?$select=name,stage,statecode,filteringattributes&$expand=sdkmessageid($select=name),plugintypeid($select=typename)&$filter=customizationlevel eq 1 and sdkmessagefilterid/primaryobjecttypecode eq '${q(table)}'`
  ));
  if (broad) {
    const unfiltered = broad.filter((s) => ["create", "update"].includes((s.sdkmessageid?.name ?? "").toLowerCase()) && (s.sdkmessageid?.name?.toLowerCase() === "create" || !s.filteringattributes) && s.stage <= 20);
    if (unfiltered.length) {
      lines.push("", "## Plug-in steps that can set it before it's saved", "Pre-validation and pre-operation steps on create, or on every update, can change any column in Target:");
      for (const s of unfiltered) lines.push(`- ${s.plugintypeid?.typename ?? s.name}: ${s.sdkmessageid?.name} ${STAGE[s.stage] ?? ""}${s.statecode === 0 ? "" : " (disabled)"}`);
    }
  }

  const flows = await section("Cloud flows", () => searchFlowsByUse(dv, column, { limit: 40 }));
  if (flows) {
    lines.push("", "## Cloud flows that mention it");
    if (!flows.flows.length) lines.push("- none");
    for (const f of flows.flows) {
      const roles = f.steps.map((s) => {
        const keys = Object.keys(s.parameters).filter((k) => k.toLowerCase().endsWith(`/${column.toLowerCase()}`) || k.toLowerCase() === column.toLowerCase());
        const writes = /createrecord|updaterecord|updateonlyrecord|upsert/i.test(s.operation ?? "") && keys.length;
        const role = s.kind === "trigger" ? "triggers on it" : writes ? `**sets it** (${keys.map((k) => `${k} = ${clip(String(s.parameters[k]), 80)}`).join(", ")})` : "reads or filters on it";
        return `"${s.name}" (${s.connector ? `${connectorName(s.connector)} · ` : ""}${s.operation ?? s.type}) ${role}`;
      });
      lines.push(`- **${f.name}** (${f.on ? "on" : "off"}), ID ${f.id}: ${roles.slice(0, 5).join("; ")}${roles.length > 5 ? `; and ${roles.length - 5} more` : ""}`);
    }
  }

  if (problems.length) lines.push("", "## Couldn't check", ...problems.map((p) => `- ${p}`));
  return lines.join("\n");
}
