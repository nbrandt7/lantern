import { DataverseClient } from "./dataverse";
import { EnvVarInfo, fetchEnvVars, fetchSolutionWebResources, fetchSteps, StepInfo } from "./admin";
import { ColumnMeta, FormMeta, MetadataService } from "./metadata";
import { UserError } from "./errors";

export interface Side {
  label: string;
  dv: DataverseClient;
  service: MetadataService;
}

export type Status = "only-a" | "only-b" | "differs";

export interface Difference {
  kind: "Table" | "Column" | "Form" | "Web resource" | "Plug-in step" | "Environment variable";
  name: string;
  status: Status;
  detail?: string;
}

export interface Comparison {
  solution: string;
  a: string;
  b: string;
  versions: { a?: string; b?: string };
  differences: Difference[];
  /** Web resources whose content differs, for a side-by-side diff. */
  webResourceContents: Map<string, { a: string; b: string }>;
  /** What was compared, for the report. */
  counts: Record<string, number>;
  /** Parts that couldn't be compared because one side failed to load, with why. */
  skipped: Array<{ part: string; reason: string }>;
}

async function solutionVersion(dv: DataverseClient, unique: string): Promise<string | undefined> {
  const rows = await dv.getAll<{ version: string }>(`solutions?$select=version&$filter=uniquename eq '${unique.replace(/'/g, "''")}'`);
  return rows[0]?.version;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Both sides of one part, or the reason it couldn't be loaded (so it's reported, never shown as differences). */
async function bothSides<T>(a: () => Promise<T>, b: () => Promise<T>, labels: [string, string]): Promise<{ a: T; b: T } | { error: string }> {
  const [ra, rb] = await Promise.allSettled([a(), b()]);
  if (ra.status === "rejected") return { error: `${labels[0]}: ${reason(ra.reason)}` };
  if (rb.status === "rejected") return { error: `${labels[1]}: ${reason(rb.reason)}` };
  return { a: ra.value, b: rb.value };
}

function diffKeys<T>(a: Map<string, T>, b: Map<string, T>, same: (x: T, y: T) => string | undefined, kind: Difference["kind"]): Difference[] {
  const out: Difference[] = [];
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y) out.push({ kind, name: k, status: "only-a" });
    else {
      const why = same(x, y);
      if (why) out.push({ kind, name: k, status: "differs", detail: why });
    }
  }
  for (const k of b.keys()) if (!a.has(k)) out.push({ kind, name: k, status: "only-b" });
  return out;
}

const colDiff = (x: ColumnMeta, y: ColumnMeta): string | undefined => {
  const parts: string[] = [];
  if (x.type !== y.type) parts.push(`type ${x.type} vs ${y.type}`);
  if (x.requiredLevel !== y.requiredLevel) parts.push(`required ${x.requiredLevel} vs ${y.requiredLevel}`);
  if ((x.maxLength ?? 0) !== (y.maxLength ?? 0)) parts.push(`max length ${x.maxLength ?? "-"} vs ${y.maxLength ?? "-"}`);
  if (x.displayName !== y.displayName) parts.push(`label "${x.displayName}" vs "${y.displayName}"`);
  const ox = JSON.stringify(x.options ?? []);
  const oy = JSON.stringify(y.options ?? []);
  if (ox !== oy) parts.push("choice values differ");
  return parts.length ? parts.join(", ") : undefined;
};

const formDiff = (x: FormMeta, y: FormMeta): string | undefined => {
  const parts: string[] = [];
  const layout = (f: FormMeta) => JSON.stringify(f.tabs.map((t) => [t.name, t.visible, t.sections.map((s) => [s.name, s.visible, s.controls.map((c) => [c.id, c.visible])])]));
  if (layout(x) !== layout(y)) parts.push("tabs, sections, or controls");
  if (JSON.stringify(x.header.map((c) => c.id)) !== JSON.stringify(y.header.map((c) => c.id))) parts.push("header");
  if (JSON.stringify(x.events) !== JSON.stringify(y.events)) parts.push("event handlers");
  if (JSON.stringify(x.libraries) !== JSON.stringify(y.libraries)) parts.push("libraries");
  return parts.length ? `${parts.join(", ")} differ` : undefined;
};

const stepDiff = (x: StepInfo, y: StepInfo): string | undefined => {
  const parts: string[] = [];
  if (x.enabled !== y.enabled) parts.push(`${x.enabled ? "on" : "off"} vs ${y.enabled ? "on" : "off"}`);
  if (x.stage !== y.stage) parts.push(`${x.stage} vs ${y.stage}`);
  if (x.mode !== y.mode) parts.push(`${x.mode} vs ${y.mode}`);
  if (x.filtering !== y.filtering) parts.push(`filtering "${x.filtering}" vs "${y.filtering}"`);
  return parts.length ? parts.join(", ") : undefined;
};

const envValue = (v: EnvVarInfo) => v.value ?? v.defaultValue;

/**
 * Compares one solution between two environments: version, tables and their columns,
 * forms, web resource contents, plus every custom plug-in step and environment variable.
 */
export async function compareEnvironments(a: Side, b: Side, solution: string, onProgress: (m: string) => void = () => undefined): Promise<Comparison> {
  const result: Comparison = { solution, a: a.label, b: b.label, versions: {}, differences: [], webResourceContents: new Map(), counts: {}, skipped: [] };
  const labels: [string, string] = [a.label, b.label];
  const skip = (part: string, error: string) => result.skipped.push({ part, reason: error });

  // The version also proves both environments answer; if one doesn't, there's nothing to compare.
  const versions = await bothSides(() => solutionVersion(a.dv, solution), () => solutionVersion(b.dv, solution), labels);
  if ("error" in versions) throw new UserError(`Couldn't read ${versions.error}`);
  result.versions = { a: versions.a, b: versions.b };

  onProgress("tables");
  const tables = await bothSides(() => a.service.solutionTables([solution]), () => b.service.solutionTables([solution]), labels);
  if ("error" in tables) skip("Tables, columns, and forms", tables.error);
  else {
    const ta = new Set(tables.a);
    const tb = new Set(tables.b);
    const allTables = [...new Set([...ta, ...tb])].sort();
    result.counts.tables = allTables.length;
    for (const t of allTables) {
      if (!tb.has(t)) {
        result.differences.push({ kind: "Table", name: t, status: "only-a" });
        continue;
      }
      if (!ta.has(t)) {
        result.differences.push({ kind: "Table", name: t, status: "only-b" });
        continue;
      }
      onProgress(`table ${t}`);
      const parts = await bothSides(
        async () => ({ columns: await a.service.columns(t), forms: await a.service.forms(t) }),
        async () => ({ columns: await b.service.columns(t), forms: await b.service.forms(t) }),
        labels
      );
      if ("error" in parts) {
        skip(`Table ${t}`, parts.error);
        continue;
      }
      const cols = (list: ColumnMeta[]) => new Map(list.filter((c) => !c.attributeOf).map((c) => [`${t}.${c.logicalName}`, c]));
      result.differences.push(...diffKeys(cols(parts.a.columns), cols(parts.b.columns), colDiff, "Column"));
      const forms = (list: FormMeta[]) => new Map(list.map((f) => [`${t}: ${f.name} (${f.type})`, f]));
      result.differences.push(...diffKeys(forms(parts.a.forms), forms(parts.b.forms), formDiff, "Form"));
    }
  }

  onProgress("web resources");
  const wr = await bothSides(() => fetchSolutionWebResources(a.dv, solution), () => fetchSolutionWebResources(b.dv, solution), labels);
  if ("error" in wr) skip("Web resources", wr.error);
  else {
    const namesA = new Set(wr.a.map((w) => w.name));
    const namesB = new Set(wr.b.map((w) => w.name));
    result.counts.webResources = new Set([...namesA, ...namesB]).size;
    for (const w of wr.a) if (!namesB.has(w.name)) result.differences.push({ kind: "Web resource", name: w.name, status: "only-a" });
    for (const w of wr.b) if (!namesA.has(w.name)) result.differences.push({ kind: "Web resource", name: w.name, status: "only-b" });
    for (const w of wr.a.filter((x) => namesB.has(x.name))) {
      const content = await bothSides(() => a.dv.findWebResource(w.name), () => b.dv.findWebResource(w.name), labels);
      if ("error" in content) {
        skip(`Web resource ${w.name}`, content.error);
        continue;
      }
      if (content.a && content.b && content.a.content !== content.b.content) {
        result.differences.push({ kind: "Web resource", name: w.name, status: "differs", detail: "content differs" });
        result.webResourceContents.set(w.name, {
          a: Buffer.from(content.a.content, "base64").toString("utf8"),
          b: Buffer.from(content.b.content, "base64").toString("utf8"),
        });
      }
    }
  }

  onProgress("plug-in steps and environment variables");
  const steps = await bothSides(() => fetchSteps(a.dv), () => fetchSteps(b.dv), labels);
  if ("error" in steps) skip("Plug-in steps", steps.error);
  else {
    result.counts.steps = new Set([...steps.a, ...steps.b].map((s) => s.name)).size;
    result.differences.push(...diffKeys(new Map(steps.a.map((s) => [s.name, s])), new Map(steps.b.map((s) => [s.name, s])), stepDiff, "Plug-in step"));
  }
  const vars = await bothSides(() => fetchEnvVars(a.dv), () => fetchEnvVars(b.dv), labels);
  if ("error" in vars) skip("Environment variables", vars.error);
  else {
    result.counts.envVars = new Set([...vars.a, ...vars.b].map((v) => v.schemaName)).size;
    result.differences.push(
      ...diffKeys(
        new Map(vars.a.map((v) => [v.schemaName, v])),
        new Map(vars.b.map((v) => [v.schemaName, v])),
        (x: EnvVarInfo, y: EnvVarInfo) => (x.type === "Secret" || envValue(x) === envValue(y) ? undefined : `"${envValue(x)}" vs "${envValue(y)}"`),
        "Environment variable"
      )
    );
  }
  return result;
}

export function comparisonMarkdown(c: Comparison): string {
  const lines = [`# ${c.solution}: ${c.a} vs ${c.b}`, ""];
  lines.push(`Solution version: **${c.versions.a ?? "not installed"}** in ${c.a}, **${c.versions.b ?? "not installed"}** in ${c.b}.`, "");
  lines.push(
    `Compared ${c.counts.tables ?? 0} tables (columns and forms), ${c.counts.webResources ?? 0} web resources, ${c.counts.steps ?? 0} plug-in steps, and ${c.counts.envVars ?? 0} environment variables. ` +
      (c.differences.length
        ? `**${c.differences.length} difference${c.differences.length === 1 ? "" : "s"}.**`
        : c.skipped.length
          ? "**No differences in what could be compared.**"
          : "**No differences.**"),
    ""
  );
  const kinds: Difference["kind"][] = ["Table", "Column", "Form", "Web resource", "Plug-in step", "Environment variable"];
  for (const kind of kinds) {
    const list = c.differences.filter((d) => d.kind === kind);
    if (!list.length) continue;
    lines.push(`## ${kind === "Plug-in step" ? "Plug-in steps" : kind === "Environment variable" ? "Environment variables" : `${kind}s`} (${list.length})`, "");
    lines.push(`| ${kind} | Difference |`, "|---|---|");
    for (const d of list) {
      const what = d.status === "only-a" ? `only in ${c.a}` : d.status === "only-b" ? `only in ${c.b}` : d.detail ?? "differs";
      lines.push(`| ${d.name.replace(/\|/g, "\\|")} | ${what.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  if (c.skipped.length) {
    lines.push("## Not compared", "", "These couldn't be read, so they're left out rather than shown as differences:", "");
    for (const s of c.skipped) lines.push(`- **${s.part}**: ${s.reason}`);
    lines.push("");
  }
  if (c.webResourceContents.size) lines.push("Use **Diff Web Resources** on the notification to see changed web resources side by side.", "");
  return lines.join("\n") + "\n";
}
