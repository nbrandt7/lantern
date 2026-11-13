import * as fs from "fs";
import * as path from "path";
import { findFiles } from "./files";
import { ColumnMeta, TableMeta } from "./metadata";

/**
 * C# classes for Dataverse tables, generated from metadata: one partial class per
 * table with only the columns picked, so a plug-in project carries what it uses.
 *
 * Regenerating never loses anything: the columns already in a class are offered
 * pre-picked, columns that are only in your code (gone from Dataverse) are kept
 * as written (with their enums), a choice column keeps the type its code already
 * uses (its enum, or OptionSetValue), and tables not picked are left alone. Every
 * public member has an XML comment, so there's nothing for #pragma warning disable
 * to hide.
 */

export interface ExistingColumn {
  property: string;
  /** As declared, e.g. "string", "account_statuscode?", "Microsoft.Xrm.Sdk.EntityReference". */
  type: string;
  /** The property's source, for keeping a column that's no longer in Dataverse. */
  source?: string;
}

export interface ExistingClass {
  file: string;
  className: string;
  table: string;
  namespace?: string;
  columns: Map<string, ExistingColumn>;
  /** Other table classes in the same file: then the file can't be rewritten for this one. */
  sharesFile: boolean;
  /** Enums declared in the class's file, name to source, for keeping the ones kept columns use. */
  enums?: Map<string, string>;
}

export interface ExistingCode {
  classes: Map<string, ExistingClass>;
  /** Enum name to the file that declares it. */
  enums: Map<string, string>;
  namespace?: string;
}

const ENTITY_ATTR = /\[\s*(?:Microsoft\.Xrm\.Sdk\.Client\.)?EntityLogicalName(?:Attribute)?\s*\(\s*"([^"]+)"\s*\)\s*\]/g;
const COLUMN_ATTR = /\[\s*(?:Microsoft\.Xrm\.Sdk\.)?AttributeLogicalName(?:Attribute)?\s*\(\s*"([^"]+)"\s*\)\s*\]\s*(?:\[[^\]]*\]\s*)*public\s+(?:(?:virtual|override|new)\s+)*([\w.<>?,[\] ]+?)\s+(@?\w+)\s*\{/g;

/** The index just past the brace that closes the one at `open`, skipping strings and comments. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
    } else if (ch === '"' || ch === "'") {
      const verbatim = text[i - 1] === "@";
      for (i++; i < text.length; i++) {
        if (!verbatim && text[i] === "\\") i++;
        else if (text[i] === ch && !(verbatim && text[i + 1] === ch)) break;
        else if (verbatim && text[i] === ch) i++;
      }
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Enums declared in a file's text: name to source, from the doc comment and attributes above each to its closing brace. */
function enumsIn(text: string): Map<string, string> {
  const enums = new Map<string, string>();
  for (const m of text.matchAll(/^[ \t]*(?:(?:public|internal)\s+)?enum\s+(\w+)[^{;]*\{/gm)) {
    const end = closingBrace(text, m.index! + m[0].length - 1);
    if (end < 0) continue;
    let start = m.index!;
    for (;;) {
      const lineStart = start > 0 ? text.lastIndexOf("\n", start - 2) + 1 : 0;
      if (lineStart === start || !/^\s*(?:\/\/\/|\[)/.test(text.slice(lineStart, start))) break;
      start = lineStart;
    }
    enums.set(m[1], text.slice(start, end).trimStart());
  }
  return enums;
}

/** The table classes in one file's text, with where each starts (for CodeLens) and its columns. */
export function classesIn(text: string, file = ""): Array<ExistingClass & { index: number }> {
  const ns = /^\s*namespace\s+([\w.]+)/m.exec(text)?.[1];
  const enums = enumsIn(text);
  const out: Array<ExistingClass & { index: number }> = [];
  const tables = [...text.matchAll(ENTITY_ATTR)];
  for (const [i, t] of tables.entries()) {
    const decl = /(?:public\s+|internal\s+)?(?:(?:partial|sealed)\s+)*class\s+(\w+)/.exec(text.slice(t.index!));
    if (!decl) continue;
    const open = text.indexOf("{", t.index! + decl.index + decl[0].length);
    const end = open < 0 ? -1 : closingBrace(text, open);
    const body = end < 0 ? text.slice(t.index!, tables[i + 1]?.index ?? text.length) : text.slice(t.index!, end);
    const columns = new Map<string, ExistingColumn>();
    for (const c of body.matchAll(COLUMN_ATTR)) {
      const logical = c[1].toLowerCase();
      // pac also tags the Id override with the primary key's name; the column's own property is the one to keep.
      if (c[3] === "Id" || columns.has(logical)) continue;
      const propOpen = c.index! + c[0].length - 1;
      const propEnd = closingBrace(body, propOpen);
      columns.set(logical, { property: c[3].replace(/^@/, ""), type: c[2].trim(), source: propEnd > 0 ? body.slice(c.index!, propEnd) : undefined });
    }
    out.push({ file, className: decl[1], table: t[1].toLowerCase(), namespace: ns, columns, sharesFile: tables.length > 1, enums, index: t.index! });
  }
  return out;
}

/** What's in the output folder now: table classes and their columns, enums, the namespace in use. */
export function scanExisting(outDir: string): ExistingCode {
  const code: ExistingCode = { classes: new Map(), enums: new Map() };
  if (!fs.existsSync(outDir)) return code;
  for (const file of findFiles(outDir, (n) => n.toLowerCase().endsWith(".cs"))) {
    const text = fs.readFileSync(file, "utf8");
    const ns = /^\s*namespace\s+([\w.]+)/m.exec(text)?.[1];
    if (ns && !code.namespace) code.namespace = ns;
    for (const m of text.matchAll(/\benum\s+(\w+)/g)) code.enums.set(m[1], file);
    for (const { index: _index, ...cls } of classesIn(text, file)) code.classes.set(cls.table, cls);
  }
  return code;
}

// ---------- types ----------

const SIMPLE: Record<string, string> = {
  String: "string",
  Memo: "string",
  EntityName: "string",
  Integer: "int?",
  BigInt: "long?",
  Decimal: "decimal?",
  Double: "double?",
  Money: "Money",
  Boolean: "bool?",
  DateTime: "DateTime?",
  Lookup: "EntityReference",
  Customer: "EntityReference",
  Owner: "EntityReference",
  Uniqueidentifier: "Guid?",
  MultiSelectPicklist: "OptionSetValueCollection",
  PartyList: "EntityCollection",
  Image: "byte[]",
  File: "Guid?",
  ManagedProperty: "BooleanManagedProperty",
};
const CHOICE = new Set(["Picklist", "State", "Status"]);

/** Columns a class can have: what the SDK can read and write as a typed value. */
export const generatable = (c: ColumnMeta) => !c.attributeOf && c.readable !== false && (CHOICE.has(c.type) || c.type in SIMPLE);

const KEYWORDS = new Set(("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while").split(" "));
/** Entity's own members: a column property named like one would hide it. */
const ENTITY_MEMBERS = new Set(["Id", "Attributes", "LogicalName", "EntityState", "FormattedValues", "KeyAttributes", "RelatedEntities", "RowVersion", "ExtensionData", "Item", "Fields", "EntityLogicalName", "PrimaryIdAttribute", "PrimaryNameAttribute"]);

export function identifier(text: string): string {
  // NFKD splits é into e and an accent; the accent goes, so "Café" is Cafe rather than two words.
  const words = text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\w\s]/g, " ").split(/[\s_]+/).filter(Boolean);
  let id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (!id) return "";
  if (/^\d/.test(id)) id = `_${id}`;
  return KEYWORDS.has(id) ? `@${id}` : id;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ").trim();
const doc = (pad: string, text: string) => `${pad}/// <summary>${xml(text)}</summary>`;

export interface GenerateOptions {
  namespace?: string;
  existing?: ExistingClass;
  /** Enums declared outside the file being written, with the file. */
  enums: Map<string, string>;
  source: string;
  /** Columns only in the code that the person chose to keep. */
  keep?: Set<string>;
}

/** A property's source moved to a new indent, keeping the indentation inside it. */
function reindent(source: string, pad: string): string[] {
  const lines = source.split(/\r?\n/);
  // The slice starts at the attribute, so its own indent is the closing brace's.
  const base = /^\s*/.exec(lines[lines.length - 1])![0].length;
  return lines.map((l, i) => (!l.trim() ? "" : `${pad}${i === 0 ? l.trimStart() : l.slice(Math.min(base, /^\s*/.exec(l)![0].length))}`));
}

/** One table's class (and its choice enums) as a file. */
export function generateClass(table: TableMeta, picked: ColumnMeta[], options: GenerateOptions): { text: string; className: string; columns: number; kept: string[] } {
  // The schema name as it is, like pac (ohcp_ProductRequest), so code written against its classes still compiles.
  const className = options.existing?.className ??
    (table.schemaName && /^[A-Za-z_]\w*$/.test(table.schemaName) && !KEYWORDS.has(table.schemaName) ? table.schemaName : identifier(table.schemaName || table.logicalName).replace(/^@/, "") || "Table");
  const ns = options.namespace?.trim();
  const pad = ns ? "        " : "    ";
  const outer = ns ? "    " : "";
  const file = options.existing?.file;
  const otherFile = (name: string) => {
    const where = options.enums.get(name);
    return !!where && where !== file;
  };
  const usedNames = new Set<string>([className]);
  const propertyName = (c: ColumnMeta) => {
    // The schema name as it is (what pac uses, so code written against its classes keeps compiling).
    const schema = c.schemaName && /^[A-Za-z_]\w*$/.test(c.schemaName) ? c.schemaName : identifier(c.schemaName || c.logicalName).replace(/^@/, "");
    let name = options.existing?.columns.get(c.logicalName)?.property ?? schema;
    if (!name || name === className || ENTITY_MEMBERS.has(name)) name = `${name || "Column"}1`;
    while (usedNames.has(name)) name = `${name}1`;
    usedNames.add(name);
    return KEYWORDS.has(name) ? `@${name}` : name;
  };

  // Columns that are only in the code now (removed from Dataverse, or a type this generator skips) and that
  // the person kept: their names are taken first, so a generated property never collides with one.
  const keptColumns = [...(options.existing?.columns ?? [])].filter(([logical, col]) => !picked.some((c) => c.logicalName === logical) && !!col.source && !!options.keep?.has(logical));
  for (const [, col] of keptColumns) usedNames.add(col.property);

  // Every column, generated or kept, in one order: the primary key, then by logical name.
  const entries: Array<{ logical: string; field: string[]; prop: string[] }> = [];
  const enums: Array<{ name: string; text: string }> = [];
  for (const c of picked) {
    const name = propertyName(c);
    const label = c.displayName || c.logicalName;
    const summary = `${label}${c.description ? `: ${c.description}` : ""} (${c.logicalName})`;
    const field = [doc(`${pad}    `, `${label} (${c.logicalName})`), `${pad}    public const string ${name} = "${c.logicalName}";`];
    const prop = [doc(pad, summary), `${pad}[AttributeLogicalName("${c.logicalName}")]`];
    if (c.logicalName === table.primaryId) {
      prop.push(
        `${pad}public Guid? ${name}`,
        `${pad}{`,
        `${pad}    get => GetAttributeValue<Guid?>("${c.logicalName}");`,
        `${pad}    set`,
        `${pad}    {`,
        `${pad}        SetAttributeValue("${c.logicalName}", value);`,
        `${pad}        base.Id = value ?? Guid.Empty;`,
        `${pad}    }`,
        `${pad}}`
      );
    } else if (CHOICE.has(c.type) && c.options?.length && !/^(?:Microsoft\.Xrm\.Sdk\.)?OptionSetValue$/.test(options.existing?.columns.get(c.logicalName)?.type ?? "")) {
      // Keep the enum the code already uses; otherwise pac's naming, table_column. A CrmSvcUtil-style
      // OptionSetValue property stays one (below): plug-in code calls new OptionSetValue(1) and .Value on it.
      const before = options.existing?.columns.get(c.logicalName)?.type.replace(/\?$/, "").split(".").pop();
      const enumName = before && options.enums.has(before) ? before : `${table.logicalName}_${c.logicalName}`;
      if (!otherFile(enumName) && !enums.some((e) => e.name === enumName)) {
        const seen = new Set<string>();
        const members = c.options.map((o) => {
          let m = identifier(o.label).replace(/^@/, "") || `Value${o.value}`;
          if (seen.has(m)) m = `${m}_${o.value}`;
          seen.add(m);
          return [doc(`${outer}    `, o.label || String(o.value)), `${outer}    ${m} = ${o.value},`].join("\n");
        });
        enums.push({ name: enumName, text: [doc(outer, `Choices of ${label} (${table.logicalName}.${c.logicalName})`), `${outer}public enum ${enumName}`, `${outer}{`, members.join("\n"), `${outer}}`].join("\n") });
      }
      prop.push(
        `${pad}public ${enumName}? ${name}`,
        `${pad}{`,
        `${pad}    get`,
        `${pad}    {`,
        `${pad}        var value = GetAttributeValue<OptionSetValue>("${c.logicalName}");`,
        `${pad}        return value == null ? (${enumName}?)null : (${enumName})value.Value;`,
        `${pad}    }`,
        `${pad}    set => SetAttributeValue("${c.logicalName}", value.HasValue ? new OptionSetValue((int)value.Value) : null);`,
        `${pad}}`
      );
    } else {
      const type = CHOICE.has(c.type) ? "OptionSetValue" : SIMPLE[c.type];
      prop.push(
        `${pad}public ${type} ${name}`,
        `${pad}{`,
        `${pad}    get => GetAttributeValue<${type}>("${c.logicalName}");`,
        `${pad}    set => SetAttributeValue("${c.logicalName}", value);`,
        `${pad}}`
      );
    }
    entries.push({ logical: c.logicalName, field, prop });
  }
  const kept: string[] = [];
  for (const [logical, col] of keptColumns) {
    kept.push(logical);
    // pac's setters raise change events through methods this class doesn't have.
    const source = col.source!.replace(/^[ \t]*this\.OnPropertyChang(?:ing|ed)\([^;]*\);[ \t]*\r?\n/gm, "");
    // The enum it uses, when it was declared in this file: only picked choice columns' enums are generated.
    for (const name of col.type.match(/\w+/g) ?? []) {
      const text = options.existing?.enums?.get(name);
      if (text && !otherFile(name) && !enums.some((e) => e.name === name)) enums.push({ name, text: reindent(text, outer).join("\n") });
    }
    entries.push({
      logical,
      field: [doc(`${pad}    `, `${logical} (kept from your code)`), `${pad}    public const string ${KEYWORDS.has(col.property) ? "@" : ""}${col.property} = "${logical}";`],
      // A doc comment of its own keeps CS1591 quiet; pac's code never had one.
      prop: [...(/^\s*\/\/\//.test(source) ? [] : [doc(pad, `${logical}: kept from your code (it isn't generated from Dataverse).`)]), ...reindent(source, pad)],
    });
  }
  entries.sort((x, y) => Number(y.logical === table.primaryId) - Number(x.logical === table.primaryId) || x.logical.localeCompare(y.logical));
  enums.sort((x, y) => x.name.localeCompare(y.name));
  const fields = entries.flatMap((e) => e.field);
  const props = entries.flatMap((e) => [...e.prop, ""]);
  const columns = picked;

  const body = [
    doc(outer, `${table.displayName || table.logicalName} (${table.logicalName})`),
    `${outer}[EntityLogicalName("${table.logicalName}")]`,
    `${outer}public partial class ${className} : Entity`,
    `${outer}{`,
    doc(pad, "The table's logical name."),
    `${pad}public const string EntityLogicalName = "${table.logicalName}";`,
    doc(pad, "The primary key column."),
    `${pad}public const string PrimaryIdAttribute = "${table.primaryId}";`,
    ...(table.primaryName ? [doc(pad, "The primary name column."), `${pad}public const string PrimaryNameAttribute = "${table.primaryName}";`] : []),
    "",
    doc(pad, "Column logical names, for ColumnSet and queries."),
    `${pad}public static class Fields`,
    `${pad}{`,
    ...fields,
    `${pad}}`,
    "",
    doc(pad, `A new ${table.logicalName} row.`),
    `${pad}public ${className}() : base(EntityLogicalName) { }`,
    "",
    doc(pad, `A ${table.logicalName} row with this ID.`),
    `${pad}public ${className}(Guid id) : base(EntityLogicalName, id) { }`,
    "",
    ...props,
  ];
  while (body[body.length - 1] === "") body.pop();
  body.push(`${outer}}`);

  const text = [
    "// <auto-generated>",
    `// Generated by Lantern from ${options.source}. Generate C# Classes again to add or remove columns;`,
    "// the columns here are offered pre-picked. Put your own code in another file: the class is partial.",
    "// </auto-generated>",
    "using System;",
    "using Microsoft.Xrm.Sdk;",
    "using Microsoft.Xrm.Sdk.Client;",
    "",
    ...(ns ? [`namespace ${ns}`, "{"] : []),
    body.join("\n"),
    ...(enums.length ? ["", enums.map((e) => e.text).join("\n\n")] : []),
    ...(ns ? ["}"] : []),
    "",
  ].join("\n");
  return { text, className, columns: columns.length, kept };
}

// ---------- project wiring ----------

/** The .csproj that owns a folder: the nearest one at or above it. */
export function owningProject(dir: string, stopAt: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(d)) {
      const proj = fs.readdirSync(d).find((n) => n.toLowerCase().endsWith(".csproj"));
      if (proj) return path.join(d, proj);
    }
    if (d === path.resolve(stopAt) || path.dirname(d) === d) return undefined;
  }
}

/** Whether any .cs file in the project already has [assembly: ProxyTypesAssembly]. */
export function hasProxyTypesAttribute(projectDir: string): boolean {
  return findFiles(projectDir, (n) => n.toLowerCase().endsWith(".cs")).some((f) => /\[\s*assembly\s*:\s*(?:Microsoft\.Xrm\.Sdk\.Client\.)?ProxyTypesAssembly/.test(fs.readFileSync(f, "utf8")));
}

export const PROXY_TYPES_FILE = [
  "// <auto-generated>",
  "// Generated by Lantern: lets the organization service return these classes instead of Entity.",
  "// </auto-generated>",
  "[assembly: Microsoft.Xrm.Sdk.Client.ProxyTypesAssembly]",
  "",
].join("\n");

/**
 * Old-style projects (no Sdk attribute) list every file. New files get
 * <Compile Include> entries there; SDK-style projects pick them up by themselves.
 */
export function includeInOldStyleProject(csproj: string, files: string[]): string[] {
  const xmlText = fs.readFileSync(csproj, "utf8");
  if (/<Project\b[^>]*\bSdk\s*=/i.test(xmlText)) return [];
  const dir = path.dirname(csproj);
  const missing = files
    .map((f) => path.relative(dir, f).split(path.sep).join("\\"))
    .filter((rel) => !new RegExp(`<Compile\\s+Include\\s*=\\s*"${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i").test(xmlText));
  if (!missing.length) return [];
  const eol = xmlText.includes("\r\n") ? "\r\n" : "\n";
  const group = `  <ItemGroup>${eol}${missing.map((m) => `    <Compile Include="${m}" />`).join(eol)}${eol}  </ItemGroup>${eol}`;
  fs.writeFileSync(csproj, xmlText.replace(/<\/Project>\s*$/i, `${group}</Project>${eol}`));
  return missing;
}

// ---------- snippets for plug-in code ----------

/** The C# type GetAttributeValue<T> reads a column as. */
export function csharpTypeOf(c: ColumnMeta): string {
  if (CHOICE.has(c.type)) return "OptionSetValue";
  return SIMPLE[c.type] ?? "object";
}

/** An example value of the column's type for a set statement: `new Money(0m)`, `new EntityReference("contact", id)`, ... */
export function csharpExampleValue(c: ColumnMeta): { code: string; comment?: string } {
  const first = c.options?.[0];
  switch (c.type) {
    case "String":
    case "Memo":
    case "EntityName":
      return { code: '"text"' };
    case "Integer":
      return { code: "0" };
    case "BigInt":
      return { code: "0L" };
    case "Decimal":
      return { code: "0m" };
    case "Double":
      return { code: "0d" };
    case "Money":
      return { code: "new Money(0m)" };
    case "Boolean":
      return { code: "true" };
    case "DateTime":
      return { code: "DateTime.UtcNow" };
    case "Lookup":
    case "Customer":
    case "Owner":
      return { code: `new EntityReference("${c.targets?.[0] ?? "table"}", id)`, comment: c.targets && c.targets.length > 1 ? `or ${c.targets.slice(1).join(", ")}` : undefined };
    case "Uniqueidentifier":
      return { code: "Guid.NewGuid()" };
    case "MultiSelectPicklist":
      return { code: `new OptionSetValueCollection { new OptionSetValue(${first?.value ?? 0}) }`, comment: first?.label };
    case "PartyList":
      return { code: "new EntityCollection()" };
    case "Image":
      return { code: "bytes" };
    default:
      return CHOICE.has(c.type) ? { code: `new OptionSetValue(${first?.value ?? 0})`, comment: first?.label } : { code: "value" };
  }
}

/** How code names a column: Account.Fields.Revenue when a generated class has it, otherwise its logical name. */
export function fieldReference(c: ColumnMeta, cls?: ExistingClass): string {
  const prop = cls?.columns.get(c.logicalName)?.property;
  return prop ? `${cls!.className}.Fields.${KEYWORDS.has(prop) ? `@${prop}` : prop}` : `"${c.logicalName}"`;
}

// ---------- matching names from a user story ----------

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A table or column named the way a person writes it: the logical name, the
 * schema name, or the display name, ignoring case, spaces and punctuation.
 * Anything less certain isn't picked; it comes back as suggestions.
 */
export function matchName<T extends { logicalName: string; schemaName?: string; displayName?: string }>(items: T[], text: string): { match?: T; suggestions: T[] } {
  const t = text.trim().toLowerCase();
  const exact = items.find((i) => i.logicalName.toLowerCase() === t) ?? items.find((i) => (i.schemaName ?? "").toLowerCase() === t);
  if (exact) return { match: exact, suggestions: [] };
  const byDisplay = items.filter((i) => (i.displayName ?? "").trim().toLowerCase() === t);
  if (byDisplay.length === 1) return { match: byDisplay[0], suggestions: [] };
  const q = squash(text);
  const squashed = items.filter((i) => [i.logicalName, i.schemaName ?? "", i.displayName ?? ""].some((n) => squash(n) === q));
  if (squashed.length === 1) return { match: squashed[0], suggestions: [] };
  const near = (squashed.length > 1 ? squashed : byDisplay.length > 1 ? byDisplay : items.filter((i) => q.length >= 3 && [i.logicalName, i.displayName ?? ""].some((n) => squash(n).includes(q) || (squash(n).length >= 3 && q.includes(squash(n))))))
    .slice(0, 5);
  return { suggestions: near };
}
