import { ColumnMeta, TableMeta } from "./metadata";

/**
 * Table models for form scripts and web resources, in JavaScript or TypeScript:
 * the table's names, the logical names of the columns picked, an enum per choice
 * column (like the C# classes'), a form wrapper with an object per column, and in TypeScript the row shape Xrm.WebApi returns. Plain global
 * scripts (Acme.Models.Account), like the form-script template and module: none
 * tsconfigs, so they work as a form library with no bundler.
 *
 * The header records the columns, so regenerating offers them pre-picked and a
 * column gone from Dataverse is kept by name instead of disappearing.
 */

export type ScriptLanguage = "js" | "ts";

const COLUMNS_LINE = /^\/\/ lantern-columns: (.*)$/m;
const MODEL_LINE = /^\/\/ lantern-model: (\w+)$/m;

/** A Lantern model file's table and columns, from its header; undefined for any other file. */
export function readModel(text: string): { table: string; columns: string[] } | undefined {
  const table = MODEL_LINE.exec(text)?.[1];
  if (!table) return undefined;
  const columns = (COLUMNS_LINE.exec(text)?.[1] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  return { table, columns };
}

/** Columns a model can have: what forms and the Web API work with. */
export const modelable = (c: ColumnMeta) => !c.attributeOf && c.readable !== false && !["Virtual", "CalendarRules", "ManagedProperty", "EntityName"].includes(c.type);

const KEYWORDS = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(" "));
const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) && !KEYWORDS.has(name) ? name : JSON.stringify(name));
const member = (label: string, value: number, seen: Set<string>) => {
  let m = label.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\w\s]/g, " ").split(/[\s_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || `Value${value}`;
  if (/^\d/.test(m)) m = `_${m}`;
  if (seen.has(m)) m = `${m}_${value}`;
  seen.add(m);
  return m;
};
const isChoice = (c: ColumnMeta) => ["Picklist", "State", "Status", "MultiSelectPicklist"].includes(c.type) && !!c.options?.length;

/** What Xrm.WebApi returns for the column: its property name and TypeScript type. */
function webApiProperty(c: ColumnMeta): { name: string; type: string } {
  if (["Lookup", "Customer", "Owner"].includes(c.type)) return { name: `_${c.logicalName}_value`, type: "string" };
  const type: Record<string, string> = {
    String: "string", Memo: "string", Uniqueidentifier: "string", DateTime: "string", Image: "string", File: "string", MultiSelectPicklist: "string",
    Integer: "number", BigInt: "number", Decimal: "number", Double: "number", Money: "number", Picklist: "number", State: "number", Status: "number",
    Boolean: "boolean", PartyList: "unknown",
  };
  return { name: c.logicalName, type: type[c.type] ?? "unknown" };
}

/** What formContext.getAttribute(…).getValue() returns for the column, in TypeScript. */
function formType(c: ColumnMeta | undefined, choiceType: string | undefined): string | undefined {
  if (!c) return "unknown";
  if (choiceType) return c.type === "MultiSelectPicklist" ? `${choiceType}[]` : choiceType;
  const type: Record<string, string> = {
    String: "string", Memo: "string", Integer: "number", BigInt: "number", Decimal: "number", Double: "number", Money: "number",
    Boolean: "boolean", DateTime: "Date", Lookup: "Xrm.LookupValue[]", Customer: "Xrm.LookupValue[]", Owner: "Xrm.LookupValue[]", PartyList: "Xrm.LookupValue[]",
    Picklist: "number", State: "number", Status: "number", MultiSelectPicklist: "number[]",
  };
  // Images, files and IDs aren't form values to get and set.
  return type[c.type];
}

/** The Xrm attribute and control types for a column, in TypeScript. */
function formObjects(c: ColumnMeta | undefined, choiceType: string | undefined): { attribute: string; control: string } {
  if (!c) return { attribute: "Xrm.Attributes.Attribute", control: "Xrm.Controls.StandardControl" };
  if (c.type === "MultiSelectPicklist") return { attribute: `Xrm.Attributes.MultiSelectOptionSetAttribute${choiceType ? `<${choiceType}>` : ""}`, control: "Xrm.Controls.MultiSelectOptionSetControl" };
  if (["Picklist", "State", "Status"].includes(c.type)) return { attribute: `Xrm.Attributes.OptionSetAttribute${choiceType ? `<${choiceType}>` : ""}`, control: "Xrm.Controls.OptionSetControl" };
  const map: Record<string, [string, string]> = {
    String: ["StringAttribute", "StringControl"], Memo: ["StringAttribute", "StringControl"],
    Integer: ["NumberAttribute", "NumberControl"], BigInt: ["NumberAttribute", "NumberControl"], Decimal: ["NumberAttribute", "NumberControl"], Double: ["NumberAttribute", "NumberControl"], Money: ["NumberAttribute", "NumberControl"],
    Boolean: ["BooleanAttribute", "BooleanControl"], DateTime: ["DateAttribute", "DateControl"],
    Lookup: ["LookupAttribute", "LookupControl"], Customer: ["LookupAttribute", "LookupControl"], Owner: ["LookupAttribute", "LookupControl"], PartyList: ["LookupAttribute", "LookupControl"],
  };
  const [attribute, control] = map[c.type] ?? ["Attribute", "StandardControl"];
  return { attribute: `Xrm.Attributes.${attribute}`, control: `Xrm.Controls.${control}` };
}

export interface ModelOptions {
  language: ScriptLanguage;
  /** Acme.Models: the global namespace the model goes on. */
  namespace: string;
  source: string;
  /** Columns in the model now that Dataverse doesn't have any more: kept by name. */
  keep?: string[];
}

/** A table's model file. Columns are sorted by logical name, the primary key first. */
export function generateModel(table: TableMeta, picked: ColumnMeta[], o: ModelOptions): string {
  const byName = new Map(picked.map((c) => [c.logicalName, c]));
  const rest = [...new Set([...picked.map((c) => c.logicalName), ...(o.keep ?? [])])].filter((n) => n !== table.primaryId).sort();
  const names = [table.primaryId, ...rest];
  const choices = names.map((n) => byName.get(n)).filter((c): c is ColumnMeta => !!c && isChoice(c));
  const ts = o.language === "ts";
  const ns = o.namespace.trim();
  const pad = ts ? "        " : "    ";
  // One class per table, named like the C# class (the schema name): Acme.Models.Account.
  const className = (table.schemaName || table.logicalName).replace(/[^\w$]/g, "");
  const choiceType = (c: ColumnMeta) => (ts && isChoice(c) ? `${className}.${c.logicalName}` : undefined);

  // The table's names and fields, static on the class like the C# EntityLogicalName and Fields.
  const stat = (name: string, value: string) => (ts ? `${pad}static readonly ${name} = ${value};` : `${pad}${name}: ${value},`);
  const statics: string[] = [
    stat("logicalName", `"${table.logicalName}"`),
    stat("entitySetName", `"${table.entitySetName}"`),
    stat("primaryId", `"${table.primaryId}"`),
    ...(table.primaryName ? [stat("primaryName", `"${table.primaryName}"`)] : []),
    ts ? `${pad}static readonly fields = {` : `${pad}fields: Object.freeze({`,
    ...names.map((n) => `${pad}    ${key(n)}: "${n}",`),
    ts ? `${pad}} as const;` : `${pad}}),`,
  ];
  // An enum per choice column on the class too: Account.statuscode.Inactive.
  const enums = choices.flatMap((c) => {
    const seen = new Set<string>();
    const values = (c.options ?? []).map((opt) => `${pad}    ${member(opt.label, opt.value, seen)}${ts ? " = " : ": "}${opt.value},`);
    return ts ? ["", `${pad}export enum ${c.logicalName} {`, ...values, `${pad}}`] : [`${pad}${c.logicalName}: Object.freeze({`, ...values, `${pad}}),`];
  });

  // An instance is a record, from a form or a Web API row: the values are properties (like the
  // C# class), and fields.<name> has the column's attribute and controls when there's a form.
  const inner = `${pad}    `;
  const deep = `${inner}    `;
  const deeper = `${deep}    `;
  const T = (s: string) => (ts ? s : "");
  // How a Web API row holds the column, when it isn't just the value.
  const KIND: Record<string, string> = { Lookup: "lookup", Customer: "lookup", Owner: "lookup", PartyList: "lookup", DateTime: "date", MultiSelectPicklist: "multi" };
  const columns: string[] = [];
  const properties: string[] = [];
  for (const n of rest) {
    const c = byName.get(n);
    const choice = c ? choiceType(c) : undefined;
    const type = formType(c, choice);
    if (!type) continue;
    const objects = formObjects(c, choice);
    const kind = c && KIND[c.type] ? `, "${KIND[c.type]}"` : "";
    columns.push(`${inner}${key(n)}: this.field${ts ? `<${type}, ${objects.attribute}, ${objects.control}>` : ""}(${JSON.stringify(n)}${kind}),`);
    properties.push(
      "",
      `${pad}get ${n}()${T(`: ${type} | null`)} {`,
      `${inner}return this.fields.${n}.value;`,
      `${pad}}`,
      `${pad}set ${n}(value${T(`: ${type} | null`)}) {`,
      `${inner}this.fields.${n}.value = value;`,
      `${pad}}`
    );
  }
  const accessors: string[] = [
    ...(ts
      ? [
          `${pad}readonly formContext: Xrm.FormContext | null;`,
          `${pad}private readonly record: Record<string, unknown>;`,
          `${pad}readonly fields = {`,
          ...columns,
          `${pad}};`,
          "",
          `${pad}constructor(source: Xrm.FormContext | ${className}.Row) {`,
          `${inner}this.formContext = typeof (source as Xrm.FormContext).getAttribute === "function" ? (source as Xrm.FormContext) : null;`,
          `${inner}this.record = this.formContext ? {} : (source as Record<string, unknown>);`,
        ]
      : [
          `${pad}constructor(source) {`,
          `${inner}this.formContext = typeof source.getAttribute === "function" ? source : null;`,
          `${inner}this.record = this.formContext ? {} : source;`,
          `${inner}this.fields = {`,
          ...columns.map((l) => `    ${l}`),
          `${inner}};`,
        ]),
    `${pad}}`,
    "",
    `${pad}get recordId()${T(": string | null")} {`,
    `${inner}const id = this.formContext ? this.formContext.data.entity.getId() : ${ts ? `(this.record[${JSON.stringify(table.primaryId)}] as string | undefined)` : `this.record[${JSON.stringify(table.primaryId)}]`};`,
    `${inner}return id ? id.replace(/[{}]/g, "").toLowerCase() : null;`,
    `${pad}}`,
    ...properties,
    "",
    // Any column by name. control and controls also find a column that's only inside a composite
    // control (address1_composite_compositionLinkControl_address1_line1, fullname_compositionLinkControl_firstname).
    `${pad}field${T("<V = unknown, A extends Xrm.Attributes.Attribute = Xrm.Attributes.Attribute, C extends Xrm.Controls.Control = Xrm.Controls.StandardControl>")}(name${T(": string")}, kind${T('?: "lookup" | "date" | "multi"')}) {`,
    // Read when used: class fields are set up before the constructor stores the source.
    `${inner}const self = this;`,
    `${inner}const attribute = ()${T(": A | null")} => (self.formContext ? ${ts ? "(self.formContext.getAttribute(name) as A | null)" : "self.formContext.getAttribute(name)"} : null) || null;`,
    `${inner}const controls = ()${T(": C[]")} => {`,
    `${deep}if (!self.formContext) return [];`,
    `${deep}const a = attribute();`,
    `${deep}const bound = a ? a.controls.get() : [];`,
    `${deep}if (bound.length) return ${ts ? "bound as unknown as C[]" : "bound"};`,
    `${deep}const suffix = "_compositionLinkControl_" + name;`,
    `${deep}return self.formContext.ui.controls.get((c) => c.getName().endsWith(suffix))${T(" as unknown as C[]")};`,
    `${inner}};`,
    // In a Web API row a lookup is _name_value plus its annotations, a date is ISO text, a multi-select is "1,2".
    `${inner}const fromRecord = ()${T(": V | null")} => {`,
    `${deep}const record = self.record;`,
    `${deep}if (kind === "lookup") {`,
    `${deeper}const id = record["_" + name + "_value"]${T(" as string | undefined")};`,
    `${deeper}return id ? ${ts ? "([{ id, name: record[\"_\" + name + \"_value@OData.Community.Display.V1.FormattedValue\"], entityType: record[\"_\" + name + \"_value@Microsoft.Dynamics.CRM.lookuplogicalname\"] }] as unknown as V)" : "[{ id, name: record[\"_\" + name + \"_value@OData.Community.Display.V1.FormattedValue\"], entityType: record[\"_\" + name + \"_value@Microsoft.Dynamics.CRM.lookuplogicalname\"] }]"} : null;`,
    `${deep}}`,
    `${deep}const raw = record[name];`,
    `${deep}if (raw === undefined || raw === null) return null;`,
    `${deep}if (kind === "date") return new Date(raw${T(" as string")})${T(" as unknown as V")};`,
    `${deep}if (kind === "multi") return String(raw).split(",").map(Number)${T(" as unknown as V")};`,
    `${deep}return raw${T(" as V")};`,
    `${inner}};`,
    `${inner}let assigned${T(": { value: V | null } | undefined")};`,
    `${inner}return {`,
    `${deep}name,`,
    `${deep}get value()${T(": V | null")} {`,
    `${deeper}if (!self.formContext) return assigned ? assigned.value : fromRecord();`,
    `${deeper}const a = attribute();`,
    `${deeper}return a ? ${ts ? "(a.getValue() as V)" : "a.getValue()"} : null;`,
    `${deep}},`,
    `${deep}set value(value${T(": V | null")}) {`,
    `${deeper}if (!self.formContext) {`,
    `${deeper}    assigned = { value };`,
    `${deeper}    return;`,
    `${deeper}}`,
    `${deeper}const a = attribute();`,
    `${deeper}if (a) a.setValue(value${T(" as never")});`,
    `${deep}},`,
    `${deep}get attribute() {`,
    `${deeper}return attribute();`,
    `${deep}},`,
    `${deep}get control()${T(": C | null")} {`,
    `${deeper}return self.formContext ? self.formContext.getControl${T("<C>")}(name) || controls()[0] || null : null;`,
    `${deep}},`,
    `${deep}get controls() {`,
    `${deeper}return controls();`,
    `${deep}},`,
    `${inner}};`,
    `${pad}}`,
  ];

  const header = [
    `// Generated by Lantern from ${o.source}. Use Edit Columns above the model to add or remove columns.`,
    `// lantern-model: ${table.logicalName}`,
    `// lantern-columns: ${names.join(", ")}`,
  ];
  if (!ts) {
    const parts = ns.split(".");
    const chain = parts.map((_, i) => parts.slice(0, i + 1).join("."));
    return [
      ...header,
      `var ${parts[0]} = ${parts[0]} || {};`,
      ...chain.slice(1).map((n) => `${n} = ${n} || {};`),
      "",
      `${ns}.${className} = class ${className} {`,
      ...accessors,
      "};",
      `Object.assign(${ns}.${className}, {`,
      ...statics,
      ...enums,
      "});",
      "",
    ].join("\n");
  }
  const row = names.map((n) => {
    const c = byName.get(n);
    const p = c ? webApiProperty(c) : { name: n, type: n === table.primaryId ? "string" : "unknown" };
    // A choice comes back as its number, which is the enum; a multi-select as "1,2".
    const type = (c && c.type !== "MultiSelectPicklist" ? choiceType(c) : undefined) ?? p.type;
    return `${pad}    ${key(p.name)}?: ${type}${type === "unknown" ? "" : " | null"};`;
  });
  return [
    ...header,
    `namespace ${ns} {`,
    `    export class ${className} {`,
    ...statics,
    "",
    ...accessors,
    "    }",
    "",
    // The enums and the shape Xrm.WebApi returns are on the class too: Account.statuscode, Account.Row.
    `    export namespace ${className} {`,
    ...enums.slice(1),
    ...(enums.length ? [""] : []),
    `${pad}export interface Row {`,
    ...row,
    `${pad}}`,
    "    }",
    "}",
    "",
  ].join("\n");
}
