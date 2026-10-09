import { fetchXmlStart } from "./query";
import { Cond, parseSql, SelectQuery, translateQuery, TranslateOptions } from "./sql";

export type CodeFormat = "xrmWebApi" | "webApiUrl" | "csFetch" | "csQuery";

export const CODE_FORMATS: Array<{ format: CodeFormat; label: string; detail: string }> = [
  { format: "xrmWebApi", label: "JavaScript: Xrm.WebApi", detail: "For form scripts and web resources" },
  { format: "webApiUrl", label: "Web API URL", detail: "For Postman, fetch(), or the browser" },
  { format: "csFetch", label: "C#: FetchExpression", detail: "For plug-ins and .NET code, using the FetchXML" },
  { format: "csQuery", label: "C#: QueryExpression", detail: "For plug-ins and .NET code, strongly structured" },
];

export interface CodeInput {
  /** SQL or FetchXML. */
  text: string;
  isFetchXml: boolean;
  org: string;
  entitySetOf: (table: string) => string | undefined;
  options?: TranslateOptions;
}

/** Generates code for one statement, or explains why the format can't express it. */
export function generate(format: CodeFormat, input: CodeInput): { code: string } | { error: string } {
  let fetchXml: string;
  let table: string;
  let query: SelectQuery | undefined;
  let havingNote = "";
  if (input.isFetchXml) {
    const start = fetchXmlStart(input.text);
    fetchXml = input.text.slice(Math.max(0, start)).trim();
    table = /<entity\s+name\s*=\s*["']([\w]+)["']/i.exec(fetchXml)?.[1] ?? "";
  } else {
    query = parseSql(input.text);
    const t = translateQuery(query, input.options);
    fetchXml = t.fetchXml;
    table = t.table;
    if (t.having) havingNote = `FetchXML has no HAVING. Keep only the rows where ${t.having.map((h) => h.text).join(" and ")}.`;
  }
  switch (format) {
    case "xrmWebApi":
      return {
        code: [
          ...(havingNote ? [`// ${havingNote}`] : []),
          `const fetchXml = \`${fetchXml.replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`;`,
          `const result = await Xrm.WebApi.retrieveMultipleRecords("${table}", "?fetchXml=" + encodeURIComponent(fetchXml));`,
          "for (const row of result.entities) {",
          "  // row.<column>, row[\"<column>@OData.Community.Display.V1.FormattedValue\"] for display text",
          "}",
        ].join("\n"),
      };
    case "webApiUrl": {
      const set = input.entitySetOf(table);
      if (!set) return { error: `Couldn't find the Web API entity set for ${table}.` };
      if (havingNote) return { error: `${havingNote} A URL can't do that filtering, so copy it as JavaScript or C# instead.` };
      return { code: `${input.org.replace(/\/+$/, "")}/api/data/v9.2/${set}?fetchXml=${encodeURIComponent(fetchXml.replace(/\s*\n\s*/g, ""))}` };
    }
    case "csFetch":
      return {
        code: [
          ...(havingNote ? [`// ${havingNote}`] : []),
          `var fetchXml = @"${fetchXml.replace(/"/g, '""')}";`,
          "var results = service.RetrieveMultiple(new FetchExpression(fetchXml));",
          "foreach (var row in results.Entities)",
          "{",
          "    // row.GetAttributeValue<string>(\"name\"), row.FormattedValues[\"<column>\"] for display text",
          "}",
        ].join("\n"),
      };
    case "csQuery":
      if (!query) return { error: "QueryExpression code is generated from SQL. For FetchXML, use FetchExpression." };
      if (query.groupBy.length || query.items.some((i) => i.kind === "aggregate")) {
        return { error: "QueryExpression can't do GROUP BY or aggregates. Use FetchExpression instead." };
      }
      return { code: queryExpression(query) };
  }
}

const OPERATOR: Record<string, string> = {
  eq: "Equal", ne: "NotEqual", lt: "LessThan", le: "LessEqual", gt: "GreaterThan", ge: "GreaterEqual",
  like: "Like", "not-like": "NotLike", in: "In", "not-in": "NotIn", null: "Null", "not-null": "NotNull",
  between: "Between", "not-between": "NotBetween",
};

const csString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const csValue = (v: string | number | null) => (typeof v === "number" ? String(v) : v === null ? "null" : csString(v));

function queryExpression(q: SelectQuery): string {
  const root = q.from;
  const lines: string[] = [];
  const aliasVar = new Map<string, string>([[root.alias, "query"]]);
  const columnsFor = (alias: string): string[] =>
    q.items.flatMap((i) => (i.kind === "column" && (i.ref.table ?? root.alias) === alias ? [i.ref.column] : []));
  const allFor = (alias: string) => q.items.some((i) => i.kind === "all" && (i.table ?? root.alias) === alias);
  const columnSet = (alias: string) => (allFor(alias) ? "new ColumnSet(true)" : `new ColumnSet(${columnsFor(alias).map(csString).join(", ")})`);

  lines.push(`var query = new QueryExpression(${csString(root.table)})`, "{", `    ColumnSet = ${columnSet(root.alias)},`);
  if (q.top !== undefined) lines.push(`    TopCount = ${q.top},`);
  if (q.distinct) lines.push("    Distinct = true,");
  lines.push("};");

  q.joins.forEach((j, n) => {
    const mine = (j.left.table ?? root.alias) === j.alias ? j.left : j.right;
    const theirs = mine === j.left ? j.right : j.left;
    const parentAlias = theirs.table ?? root.alias;
    const parentVar = aliasVar.get(parentAlias) ?? "query";
    const v = `link${n + 1}`;
    aliasVar.set(j.alias, v);
    lines.push(
      `var ${v} = ${parentVar}.AddLink(${csString(j.table)}, ${csString(theirs.column)}, ${csString(mine.column)}, JoinOperator.${j.outer ? "LeftOuter" : "Inner"});`,
      `${v}.EntityAlias = ${csString(j.alias)};`,
      `${v}.Columns = ${columnSet(j.alias)};`
    );
  });

  if (q.where) {
    const cond = (c: Cond, filterVar: string, depth: number): void => {
      if (c.kind === "cmp") {
        const entity = c.ref.table && c.ref.table !== root.alias ? `${csString(c.ref.table)}, ` : "";
        const values = c.values.length ? `, ${c.values.map(csValue).join(", ")}` : "";
        lines.push(`${filterVar}.AddCondition(${entity}${csString(c.ref.column)}, ConditionOperator.${OPERATOR[c.op] ?? c.op}${values});`);
        return;
      }
      if (c.kind === "not") {
        lines.push(`// NOT isn't expressible directly; it was rewritten below.`);
        cond(negate(c.item), filterVar, depth);
        return;
      }
      const v = `filter${depth}`;
      lines.push(`var ${v} = new FilterExpression(LogicalOperator.${c.kind === "and" ? "And" : "Or"});`);
      for (const item of c.items) cond(item, v, depth + 1);
      lines.push(`${filterVar}.AddFilter(${v});`);
    };
    cond(q.where, "query.Criteria", 1);
  }

  for (const o of q.orderBy) {
    const alias = o.ref.table ?? root.alias;
    const target = aliasVar.get(alias) ?? "query";
    lines.push(`${target}.${target === "query" ? "AddOrder" : "Orders.Add(new OrderExpression"}(${csString(o.ref.column)}, OrderType.${o.desc ? "Descending" : "Ascending"})${target === "query" ? "" : ")"};`);
  }
  lines.push("", "var results = service.RetrieveMultiple(query);");
  return lines.join("\n");
}

const NEGATE: Record<string, string> = {
  eq: "ne", ne: "eq", lt: "ge", ge: "lt", gt: "le", le: "gt", like: "not-like", "not-like": "like",
  in: "not-in", "not-in": "in", null: "not-null", "not-null": "null", between: "not-between", "not-between": "between",
};

function negate(c: Cond): Cond {
  if (c.kind === "cmp") return { ...c, op: NEGATE[c.op] };
  if (c.kind === "not") return c.item;
  return { kind: c.kind === "and" ? "or" : "and", items: c.items.map(negate) };
}
