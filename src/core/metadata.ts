import * as fs from "fs";
import * as path from "path";
import { DataverseClient } from "./dataverse";

// ---------- model ----------

export interface TableMeta {
  logicalName: string;
  displayName: string;
  schemaName: string;
  entitySetName: string;
  primaryId: string;
  primaryName: string;
  isCustom: boolean;
  metadataId: string;
}

export interface OptionMeta {
  value: number;
  label: string;
}

export interface ColumnMeta {
  logicalName: string;
  displayName: string;
  schemaName: string;
  /** Friendly type, e.g. "String", "Lookup", "Picklist". */
  type: string;
  requiredLevel: string;
  isCustom: boolean;
  description: string;
  /** Set for helper columns like "parentaccountidname" that belong to another column. */
  attributeOf?: string;
  /** False for columns that can't be retrieved (selecting them in a query fails). Undefined in older caches. */
  readable?: boolean;
  maxLength?: number;
  targets?: string[];
  options?: OptionMeta[];
}

export interface ControlMeta {
  /** Name for formContext.getControl(). */
  id: string;
  /** Column it's bound to, if any. */
  field?: string;
  label: string;
  visible: boolean;
  kind: "field" | "subgrid" | "webresource" | "composite-part" | "other";
}

export interface SectionMeta {
  name: string;
  label: string;
  visible: boolean;
  controls: ControlMeta[];
}

export interface TabMeta {
  name: string;
  label: string;
  visible: boolean;
  sections: SectionMeta[];
}

export interface HandlerMeta {
  functionName: string;
  libraryName: string;
  enabled: boolean;
  passExecutionContext: boolean;
}

export interface EventMeta {
  /** onload, onsave, onchange, tabstatechange... */
  name: string;
  /** Column for onchange events. */
  attribute?: string;
  handlers: HandlerMeta[];
}

export interface FormMeta {
  id: string;
  name: string;
  type: string;
  tabs: TabMeta[];
  header: ControlMeta[];
  libraries: string[];
  events: EventMeta[];
}

// ---------- labels ----------

interface Label {
  UserLocalizedLabel?: { Label?: string } | null;
  LocalizedLabels?: Array<{ Label?: string }>;
}

export function labelOf(label: Label | null | undefined): string {
  return label?.UserLocalizedLabel?.Label ?? label?.LocalizedLabels?.[0]?.Label ?? "";
}

// ---------- fetching ----------

interface RawTable {
  LogicalName: string;
  SchemaName: string;
  DisplayName: Label;
  EntitySetName: string | null;
  PrimaryIdAttribute: string | null;
  PrimaryNameAttribute: string | null;
  IsCustomEntity: boolean;
  MetadataId: string;
}

export async function fetchTables(dv: DataverseClient): Promise<TableMeta[]> {
  const rows = await dv.getAll<RawTable>(
    "EntityDefinitions?$select=LogicalName,SchemaName,DisplayName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,IsCustomEntity,MetadataId"
  );
  return rows
    .map((r) => ({
      logicalName: r.LogicalName,
      displayName: labelOf(r.DisplayName) || r.SchemaName,
      schemaName: r.SchemaName,
      entitySetName: r.EntitySetName ?? "",
      primaryId: r.PrimaryIdAttribute ?? "",
      primaryName: r.PrimaryNameAttribute ?? "",
      isCustom: r.IsCustomEntity,
      metadataId: r.MetadataId,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

interface RawColumn {
  LogicalName: string;
  SchemaName: string;
  DisplayName: Label;
  Description: Label;
  AttributeType: string;
  AttributeTypeName?: { Value?: string } | null;
  RequiredLevel?: { Value?: string } | null;
  IsCustomAttribute: boolean;
  AttributeOf: string | null;
  IsValidForRead?: boolean;
}

interface RawOptionSet {
  Options?: Array<{ Value: number; Label: Label }>;
  TrueOption?: { Value: number; Label: Label } | null;
  FalseOption?: { Value: number; Label: Label } | null;
}

function optionsOf(set: RawOptionSet | null | undefined): OptionMeta[] | undefined {
  if (!set) return undefined;
  if (set.Options?.length) return set.Options.map((o) => ({ value: o.Value, label: labelOf(o.Label) }));
  const pair = [set.FalseOption, set.TrueOption].filter((o): o is { Value: number; Label: Label } => !!o);
  return pair.length ? pair.map((o) => ({ value: o.Value, label: labelOf(o.Label) })) : undefined;
}

export async function fetchColumns(dv: DataverseClient, table: string): Promise<ColumnMeta[]> {
  const base = `EntityDefinitions(LogicalName='${table}')/Attributes`;
  const cast = (type: string) => `${base}/Microsoft.Dynamics.CRM.${type}`;
  const [rows, strings, lookups, ...optionSets] = await Promise.all([
    dv.getAll<RawColumn>(
      `${base}?$select=LogicalName,SchemaName,DisplayName,Description,AttributeType,AttributeTypeName,RequiredLevel,IsCustomAttribute,AttributeOf,IsValidForRead`
    ),
    dv.getAll<{ LogicalName: string; MaxLength: number }>(`${cast("StringAttributeMetadata")}?$select=LogicalName,MaxLength`),
    dv.getAll<{ LogicalName: string; Targets: string[] }>(`${cast("LookupAttributeMetadata")}?$select=LogicalName,Targets`),
    ...["PicklistAttributeMetadata", "MultiSelectPicklistAttributeMetadata", "StateAttributeMetadata", "StatusAttributeMetadata", "BooleanAttributeMetadata"].map(
      (t) => dv.getAll<{ LogicalName: string; OptionSet?: RawOptionSet; GlobalOptionSet?: RawOptionSet }>(`${cast(t)}?$select=LogicalName&$expand=OptionSet`)
    ),
  ]);

  const maxLength = new Map(strings.map((s) => [s.LogicalName, s.MaxLength]));
  const targets = new Map(lookups.map((l) => [l.LogicalName, l.Targets]));
  const options = new Map<string, OptionMeta[]>();
  for (const set of optionSets) {
    for (const row of set) {
      const o = optionsOf(row.OptionSet) ?? optionsOf(row.GlobalOptionSet);
      if (o) options.set(row.LogicalName, o);
    }
  }

  return rows
    .map((r) => ({
      logicalName: r.LogicalName,
      displayName: labelOf(r.DisplayName),
      schemaName: r.SchemaName,
      type: (r.AttributeTypeName?.Value ?? r.AttributeType).replace(/Type$/, ""),
      requiredLevel: r.RequiredLevel?.Value ?? "None",
      isCustom: r.IsCustomAttribute,
      description: labelOf(r.Description),
      attributeOf: r.AttributeOf ?? undefined,
      readable: r.IsValidForRead,
      maxLength: maxLength.get(r.LogicalName),
      targets: targets.get(r.LogicalName),
      options: options.get(r.LogicalName),
    }))
    .sort((a, b) => (a.displayName || a.logicalName).localeCompare(b.displayName || b.logicalName));
}

const FORM_TYPES: Record<number, string> = {
  0: "Dashboard", 2: "Main", 5: "Mobile", 6: "Quick View", 7: "Quick Create", 11: "Card", 12: "Main (interactive)",
};

export async function fetchForms(dv: DataverseClient, table: string): Promise<FormMeta[]> {
  const rows = await dv.getAll<{ formid: string; name: string; type: number; formxml: string }>(
    `systemforms?$select=formid,name,type,formxml&$filter=objecttypecode eq '${table}' and formactivationstate eq 1`
  );
  return rows
    .filter((r) => r.type !== 0 && r.formxml)
    .map((r) => ({ id: r.formid, name: r.name, type: FORM_TYPES[r.type] ?? `Type ${r.type}`, ...parseFormXml(r.formxml) }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

/** Logical names of tables that are components of the given solutions. */
export async function fetchSolutionTables(dv: DataverseClient, solutions: string[], tables: TableMeta[]): Promise<string[]> {
  if (!solutions.length) return [];
  const byId = new Map(tables.map((t) => [t.metadataId.toLowerCase(), t.logicalName]));
  const names = new Set<string>();
  for (const unique of solutions) {
    const found = await dv.getAll<{ solutionid: string }>(`solutions?$select=solutionid&$filter=uniquename eq '${unique.replace(/'/g, "''")}'`);
    if (!found[0]) continue;
    const components = await dv.getAll<{ objectid: string }>(
      `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${found[0].solutionid} and componenttype eq 1`
    );
    for (const c of components) {
      const name = byId.get(c.objectid.toLowerCase());
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

// ---------- FormXml ----------

const ADDRESS_PARTS = ["line1", "line2", "line3", "city", "stateorprovince", "postalcode", "country"];
const NAME_PARTS = ["firstname", "middlename", "lastname"];

function decode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? "");
  return out;
}

const SUBGRID_CLASS = "{e7a81278-8635-4d9e-8d4d-59480b391c5b}";
const WEBRESOURCE_CLASS = "{9fdf5f91-88b1-47f4-ad53-c11efc01a01d}";

function controlKind(a: Record<string, string>): ControlMeta["kind"] {
  const cls = (a.classid ?? "").toLowerCase();
  if (cls === SUBGRID_CLASS || a.indicationofsubgrid === "true") return "subgrid";
  if (cls === WEBRESOURCE_CLASS || (a.id ?? "").startsWith("WebResource_")) return "webresource";
  return a.datafieldname ? "field" : "other";
}

/** The runtime controls inside a composite (address or full name) control. */
export function compositeParts(control: ControlMeta): ControlMeta[] {
  const field = control.field ?? "";
  let parts: string[] = [];
  if (field === "fullname") parts = NAME_PARTS;
  else if (field.endsWith("_composite")) {
    const prefix = field.slice(0, -"_composite".length);
    parts = ADDRESS_PARTS.map((p) => `${prefix}_${p}`);
  }
  return parts.map((p) => ({
    id: `${control.id}_compositionLinkControl_${p}`,
    field: p,
    label: "",
    visible: control.visible,
    kind: "composite-part" as const,
  }));
}

/**
 * Pulls tabs, sections, controls, header controls, libraries, and event handlers out
 * of a form's FormXml. A small tag scanner rather than a full XML parser: FormXml is
 * machine-written and regular, and this keeps the extension dependency-free.
 */
export function parseFormXml(xml: string): Omit<FormMeta, "id" | "name" | "type"> {
  const result: Omit<FormMeta, "id" | "name" | "type"> = { tabs: [], header: [], libraries: [], events: [] };
  const stack: string[] = [];
  let tab: TabMeta | undefined;
  let section: SectionMeta | undefined;
  let cell: { label: string; visible: boolean } | undefined;
  let event: EventMeta | undefined;
  let inHeader = false;

  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const [, closing, rawName, attrText, selfClosing] = m;
    const name = rawName.toLowerCase();

    if (closing) {
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) stack.length = idx;
      if (name === "tab") tab = undefined;
      else if (name === "section") section = undefined;
      else if (name === "cell") cell = undefined;
      else if (name === "event") event = undefined;
      else if (name === "header") inHeader = false;
      continue;
    }

    const a = attrs(attrText);
    const parent = stack[stack.length - 1];
    const grandparent = stack[stack.length - 2];

    switch (name) {
      case "header":
        inHeader = true;
        break;
      case "tab":
        if (!inHeader) {
          tab = { name: a.name ?? "", label: "", visible: a.visible !== "false", sections: [] };
          result.tabs.push(tab);
        }
        break;
      case "section":
        if (tab) {
          section = { name: a.name ?? "", label: "", visible: a.visible !== "false", controls: [] };
          tab.sections.push(section);
        }
        break;
      case "cell":
        cell = { label: "", visible: a.visible !== "false" };
        break;
      case "label":
        // <labels><label description="..."/></labels>, owned by the cell, section, or tab around it.
        // The first label wins unless an English (1033) one comes later.
        if (parent === "labels" && a.description) {
          const english = a.languagecode === "1033";
          if (grandparent === "cell" && cell && (!cell.label || english)) cell.label = a.description;
          else if (grandparent === "section" && section && (!section.label || english)) section.label = a.description;
          else if (grandparent === "tab" && tab && (!tab.label || english)) tab.label = a.description;
        }
        break;
      case "control":
        if (cell && a.id) {
          const control: ControlMeta = {
            id: a.id,
            field: a.datafieldname || undefined,
            label: cell.label,
            visible: cell.visible,
            kind: controlKind(a),
          };
          const target = inHeader ? result.header : section?.controls;
          if (target) target.push(control, ...compositeParts(control));
        }
        break;
      case "library":
        if (a.name && !result.libraries.includes(a.name)) result.libraries.push(a.name);
        break;
      case "event":
        event = { name: (a.name ?? "").toLowerCase(), attribute: a.attribute || undefined, handlers: [] };
        result.events.push(event);
        break;
      case "handler":
        // Only <Handlers>, not the platform's <InternalHandlers>.
        if (event && parent === "handlers") {
          event.handlers.push({
            functionName: a.functionname ?? "",
            libraryName: a.libraryname ?? "",
            enabled: a.enabled !== "false",
            passExecutionContext: a.passexecutioncontext === "true",
          });
        }
        break;
    }

    if (!selfClosing) stack.push(name);
  }
  result.events = result.events.filter((e) => e.handlers.length);
  return result;
}

// ---------- caching service ----------

interface CacheFile<T> {
  savedAt: string;
  data: T;
}

export interface LoadOptions {
  /** Ignore the cache and fetch again. */
  force?: boolean;
  /** Never prompt for sign-in (editor features call this while you type). */
  silent?: boolean;
}

/**
 * Metadata for one org, cached in memory and on disk (one JSON file per table), so the
 * viewer and completions are instant after the first load and work offline.
 */
export class MetadataService {
  private readonly memory = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string, private readonly client: (silent: boolean) => DataverseClient) {}

  tables(o: LoadOptions = {}): Promise<TableMeta[]> {
    return this.load("tables", (dv) => fetchTables(dv), o);
  }

  columns(table: string, o: LoadOptions = {}): Promise<ColumnMeta[]> {
    return this.load(`columns/${table}`, (dv) => fetchColumns(dv, table), o);
  }

  forms(table: string, o: LoadOptions = {}): Promise<FormMeta[]> {
    return this.load(`forms/${table}`, (dv) => fetchForms(dv, table), o);
  }

  solutionTables(solutions: string[], o: LoadOptions = {}): Promise<string[]> {
    const key = `solution-tables/${solutions.map((s) => s.toLowerCase()).sort().join("+") || "none"}`;
    return this.load(key, async (dv) => fetchSolutionTables(dv, solutions, await this.tables(o)), o);
  }

  /** What's already cached, without touching the network. */
  cached<T>(key: string): T | undefined {
    if (this.memory.has(key)) return this.memory.get(key) as T;
    const file = this.fileFor(key);
    if (!fs.existsSync(file)) return undefined;
    try {
      const data = (JSON.parse(fs.readFileSync(file, "utf8")) as CacheFile<T>).data;
      this.memory.set(key, data);
      return data;
    } catch {
      return undefined;
    }
  }

  /** Drops cached entries whose key starts with the prefix (e.g. "solution-tables/"). */
  forget(prefix: string): void {
    for (const key of [...this.memory.keys()]) if (key.startsWith(prefix)) this.memory.delete(key);
    const dir = path.join(this.dir, prefix);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Drops one table's cached columns and forms, or everything when no table is given. */
  clear(table?: string): void {
    if (table) {
      for (const key of [`columns/${table}`, `forms/${table}`]) {
        this.memory.delete(key);
        fs.rmSync(this.fileFor(key), { force: true });
      }
      return;
    }
    this.memory.clear();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private async load<T>(key: string, fetcher: (dv: DataverseClient) => Promise<T>, o: LoadOptions): Promise<T> {
    if (!o.force) {
      const hit = this.cached<T>(key);
      if (hit !== undefined) return hit;
    }
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      // A silent load (from typing) mustn't fail a visible one that's allowed to sign in: retry it.
      return o.silent ? pending : pending.catch(() => this.load(key, fetcher, { ...o, force: true }));
    }
    const promise = fetcher(this.client(!!o.silent))
      .then((data) => {
        this.memory.set(key, data);
        try {
          const file = this.fileFor(key);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const payload: CacheFile<T> = { savedAt: new Date().toISOString(), data };
          fs.writeFileSync(file, JSON.stringify(payload));
        } catch {
          // The cache on disk is a convenience; the data is still good.
        }
        return data;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private fileFor(key: string): string {
    return path.join(this.dir, `${key.replace(/[^a-zA-Z0-9_/+-]/g, "_")}.json`);
  }
}

// ---------- which table a script is for ----------

/**
 * Best guess at the table a script works with, from its file name: the longest table
 * logical name found in it, ignoring a publisher prefix. "cr36f_AccountFormOnLoad" -> account,
 * "acme_/scripts/opportunity.js" -> opportunity.
 */
export function guessTable(fileName: string, tables: TableMeta[]): string | undefined {
  const base = path.basename(fileName).toLowerCase().replace(/\.[a-z]+$/, "");
  const names = tables.map((t) => t.logicalName).filter((n) => n.length >= 4);
  // An exact custom table name (with prefix) wins, e.g. "acme_project.js".
  if (names.includes(base)) return base;
  // "acme_accountform" loses its publisher prefix; "account_main" keeps "account" (it's a table, not a prefix).
  const stripped = base.replace(/^[a-z0-9]{2,8}_/, "");
  let best: string | undefined;
  for (const n of names) {
    const candidate = n.replace(/^[a-z0-9]{2,8}_/, "");
    if (candidate.length < 4) continue;
    if ((stripped.includes(candidate) || base.includes(candidate)) && (!best || candidate.length > best.replace(/^[a-z0-9]{2,8}_/, "").length)) best = n;
  }
  return best;
}

/** A table named in an XrmDefinitelyTyped annotation, e.g. Form.account.Main.Information. */
export function tableFromAnnotation(text: string): string | undefined {
  return /\bForm\.([a-z][a-z0-9_]*)\./.exec(text)?.[1];
}
