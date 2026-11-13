import { Client } from "../core/clients";
import { outlinePlugin, outlineWebResource, traceColumn, TRACE_MAX_CODE_LINES } from "../core/componentOutlines";
import { connectorName, findFlow, outlineFlow, searchFlowsByUse, solutionsOf, CAPABILITIES } from "../core/flowAnalysis";
import { searchPowerAutomateFlows } from "../core/dataverseSearch";
import { MetadataService } from "../core/metadata";
import { fetchXmlStart, runQuery, cellText } from "../core/query";
import { findUsages, usageMarkdown } from "../core/references";
import { parseStatement } from "../core/sql";
import { resolveWebResourceName } from "../core/solutions";
import { dataverseFor } from "./auth";
import { scanAll, settings } from "./context";

/**
 * The tools Lantern gives AI assistants: Copilot Chat calls them through VS Code,
 * Claude Code, Codex and other MCP clients through Lantern's local MCP server.
 * They read from the selected tenant's Dataverse org with Lantern's sign-in, and
 * none of them changes data.
 */

export interface LanternTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Copilot asks before running these; MCP clients ask by their own rules. */
  confirm?: (input: Record<string, unknown>) => { title: string; message: string };
  /** False for the tools that change something (MCP clients see readOnlyHint: false). */
  readOnly?: boolean;
  invoke(input: Record<string, unknown>): Promise<string>;
}

const TENANT = { type: "string", description: "Selected tenant name (optional)." };

/** What the C# classes tool needs from the queue in VS Code. */
export interface CSharpClassRequests {
  request(client: Client, items: Array<{ table: string; columns: string[] }>, options: { generate?: boolean; namespace?: string }): Promise<string>;
}

export function lanternTools(serviceFor: (c: Client) => MetadataService, csharp?: CSharpClassRequests): LanternTool[] {
  const pick = (name?: unknown): Client => {
    const clients = scanAll().clients.filter((c) => c.config.org);
    if (!clients.length) throw new Error("Select a tenant connected to Dataverse in Lantern.");
    if (typeof name !== "string" || !name) {
      if (clients.length === 1) return clients[0];
      throw new Error(`Select a tenant in Lantern.`);
    }
    const c = clients.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`The selected tenant is ${clients[0].name}, not ${name}.`);
    return c;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  /** A table or column logical name; these go into OData filters, so nothing else gets through. */
  const logicalName = (v: unknown, what: "table" | "column"): string => {
    const name = String(v ?? "").trim().toLowerCase();
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`"${String(v ?? "")}" isn't a ${what} logical name. Pass the logical name, like ${what === "table" ? "account" : "statuscode"}.`);
    return name;
  };
  const where = (c: Client) => `${c.name}${c.envName ? ` (${c.envName})` : ""}`;

  return [
    {
      name: "lantern_tenants",
      title: "Lantern: tenants",
      description: "Shows the selected Dynamics 365 / Dataverse tenant, its org URL, environments, and solutions. Select a tenant in Lantern first.",
      inputSchema: { type: "object", properties: {} },
      async invoke() {
        const lines = scanAll().clients.map((c) => {
          const envs = c.environments.length ? ` Environments: ${c.environments.map((e) => `${e.name}${e.protected ? " (protected)" : ""}`).join(", ")}; active ${c.envName}.` : "";
          return `- ${c.name}: ${c.config.org || "no org"}.${envs} Solutions: ${c.config.solutions.join(", ") || "none"}.`;
        });
        return lines.length ? lines.join("\n") : "No tenant is selected.";
      },
    },
    {
      name: "lantern_describe_table",
      title: "Lantern: describe a table",
      description: "Describes a Dataverse table from a client's org: every column with its logical name, display name, type, required level, choice values, and lookup targets, plus each form and its event handlers. Use it before writing form scripts, plug-ins, or queries against the table.",
      inputSchema: { type: "object", properties: { tenant: TENANT, table: { type: "string", description: "Table logical name (like account) or display name." } }, required: ["table"] },
      async invoke(input) {
        const c = pick(input.tenant);
        const table = String(input.table ?? "");
        const svc = serviceFor(c);
        const t = (await svc.tables()).find((x) => x.logicalName === table.toLowerCase() || x.displayName.toLowerCase() === table.toLowerCase());
        if (!t) throw new Error(`There's no table named ${table} in ${c.orgHost}.`);
        const [columns, forms] = await Promise.all([svc.columns(t.logicalName), svc.forms(t.logicalName)]);
        const cols = columns
          .filter((x) => !x.attributeOf)
          .map((x) => `- ${x.logicalName} (${x.displayName}): ${x.type}${x.requiredLevel !== "None" ? `, ${x.requiredLevel}` : ""}${x.options?.length ? `, choices ${x.options.map((o) => `${o.value}=${o.label}`).join(", ")}` : ""}${x.targets?.length ? ` -> ${x.targets.join("/")}` : ""}`);
        const formLines = forms.map((f) => `- ${f.name} (${f.type}): ${f.events.flatMap((e) => e.handlers.map((h) => `${e.name}${e.attribute ? `(${e.attribute})` : ""} ${h.functionName}`)).join("; ") || "no handlers"}`);
        return `${t.displayName} (${t.logicalName}), entity set ${t.entitySetName}, primary ${t.primaryId} / ${t.primaryName}.\n\nColumns:\n${cols.join("\n")}\n\nForms:\n${formLines.join("\n")}`;
      },
    },
    {
      name: "lantern_query",
      title: "Lantern: run a read-only query",
      description: "Runs a read-only query against a client's Dataverse org and returns up to 50 rows as a table. Accepts a SQL SELECT (Lantern's dialect: SELECT [TOP n] columns FROM table [alias] [JOIN ... ON a.x = b.y] [WHERE ...] [GROUP BY ...] [HAVING ...] [ORDER BY ...], using logical names) or a FetchXML document. UPDATE, DELETE, and INSERT are refused. The person confirms each query before it runs.",
      inputSchema: { type: "object", properties: { tenant: TENANT, query: { type: "string", description: "A SQL SELECT statement or a FetchXML document." } }, required: ["query"] },
      confirm(input) {
        let at = str(input.tenant) ?? "";
        try {
          const c = pick(input.tenant);
          at = `${c.name}${c.envName ? ` (${c.envName}${c.isProtected ? ", protected" : ""})` : ""}`;
        } catch {
          // reported when it runs
        }
        return { title: `Run a read-only query on ${at}?`, message: String(input.query ?? "") };
      },
      async invoke(input) {
        const c = pick(input.tenant);
        const query = String(input.query ?? "");
        // The same test runQuery uses, so FetchXML with an <?xml?> prolog or a leading comment isn't taken for SQL.
        if (fetchXmlStart(query) < 0) {
          const st = parseStatement(query);
          if (st.kind !== "select") throw new Error("Only SELECT queries and FetchXML can run from chat. Run changes from a query document so you can review them.");
        }
        const svc = serviceFor(c);
        const tables = await svc.tables();
        const set = await runQuery(query, {
          dv: dataverseFor(c),
          maxRows: Math.min(settings().queryMaxRows, 200),
          primaryIdOf: (t: string) => tables.find((x) => x.logicalName === t)?.primaryId,
          entitySetOf: async (t: string) => {
            const found = tables.find((x) => x.logicalName === t.toLowerCase());
            if (!found) throw new Error(`There's no table named ${t}.`);
            return found.entitySetName;
          },
        });
        // FetchXML with no rows has no columns to show (they come from the rows), so no table either.
        if (!set.columns.length) return `0 row(s) from ${c.name}${c.envName ? ` ${c.envName}` : ""}.`;
        const shown = set.rows.slice(0, 50);
        const md = [`| ${set.columns.join(" | ")} |`, `|${set.columns.map(() => "---").join("|")}|`, ...shown.map((r) => `| ${r.map((cell) => cellText(cell, true).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`)];
        return `${set.rows.length} row(s)${set.rows.length > shown.length ? `, first ${shown.length} shown` : ""}${set.truncated ? " (more exist)" : ""} from ${c.name}${c.envName ? ` ${c.envName}` : ""}:\n\n${md.join("\n")}`;
      },
    },
    {
      name: "lantern_where_used",
      title: "Lantern: where a column is used",
      description: "Finds where a Dataverse column is used: on forms, in views, business rules and workflows, plug-in step filtering, and in the client folder's code (with the function each use is in). Use before renaming, removing, or changing a column.",
      inputSchema: { type: "object", properties: { tenant: { type: "string" }, table: { type: "string", description: "Table logical name." }, column: { type: "string", description: "Column logical name." } }, required: ["table", "column"] },
      async invoke(input) {
        const c = pick(input.tenant);
        const table = logicalName(input.table, "table");
        const column = logicalName(input.column, "column");
        const forms = await serviceFor(c).forms(table);
        const report = await findUsages(dataverseFor(c), table, column, forms, c.dir, (f) => resolveWebResourceName(f, c)?.name);
        return usageMarkdown(report, `${table}.${column}`, (file, line) => `${file}:${line}`, c.dir, TRACE_MAX_CODE_LINES);
      },
    },
    {
      name: "lantern_search_flows",
      title: "Lantern: search cloud flows",
      description:
        `Finds Power Automate cloud flows in the selected tenant's environment by name, by what they do, or both. "uses" looks inside each flow's definition: one of the shortcuts ${Object.keys(CAPABILITIES).join(", ")} (email finds every flow that sends email: Outlook, Mail, SendGrid, SMTP, Dataverse SendEmail), or any text (a table name, a connector like shared_sharepointonline, an action name, a URL). ` +
        "Returns each flow's ID, name, on/off state, solutions, and the steps that matched. Use lantern_explain_flow with an ID to see the whole flow.",
      inputSchema: {
        type: "object",
        properties: {
          tenant: TENANT,
          name: { type: "string", description: "Text the flow's name contains (optional)." },
          uses: { type: "string", description: `What the flow does: ${Object.keys(CAPABILITIES).join(", ")}, or text to find in its definition (optional).` },
          solution: { type: "string", description: "Only flows in this solution (unique name, optional)." },
          limit: { type: "number", description: "Most flows to return (default 50)." },
        },
      },
      async invoke(input) {
        const c = pick(input.tenant);
        const dv = dataverseFor(c);
        const name = str(input.name)?.trim();
        const uses = str(input.uses)?.trim();
        const solution = str(input.solution)?.trim() || undefined;
        const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
        if (!name && !uses) throw new Error('Pass "name", "uses", or both.');
        if (!uses) {
          const found = (await searchPowerAutomateFlows(c, name!, dv, solution)).slice(0, limit);
          if (!found.length) return `No cloud flow in ${where(c)} has a name containing "${name}".`;
          return [`${found.length} flow(s) in ${where(c)} named like "${name}":`, "", ...found.map((f) =>
            `- ${f.flow.name} (${f.flow.state === 1 ? "on" : "off"}), ID ${f.flow.id}${f.solutions.length ? `, in ${f.solutions.join(", ")}` : ""}`)].join("\n");
        }
        const r = await searchFlowsByUse(dv, uses, { name, solution, limit });
        if (!r.flows.length) return `No cloud flow in ${where(c)}${solution ? ` (solution ${solution})` : ""} has a step that would ${r.capability.label}.`;
        const lines = [`${r.total} flow(s) in ${where(c)} ${r.capability.label}${r.total > r.flows.length ? `; first ${r.flows.length} shown` : ""}${r.scannedAll ? " (the org refused a text filter, so every flow's definition was read)" : ""}:`, ""];
        for (const f of r.flows) {
          lines.push(`- **${f.name}** (${f.on ? "on" : "off"}), ID ${f.id}${f.solutions.length ? `, in ${f.solutions.join(", ")}` : ""}`);
          for (const s of f.steps.slice(0, 6)) {
            const at = s.branch.length ? ` inside ${s.branch.join(" › ")}` : "";
            const to = s.parameters["emailMessage/To"] ?? s.parameters["To"] ?? s.parameters["to"];
            lines.push(`  - ${s.kind === "trigger" ? "trigger" : "step"} "${s.name}": ${s.connector ? `${connectorName(s.connector)} · ` : ""}${s.operation ?? s.type}${at}${to ? `, to ${String(to).slice(0, 120)}` : ""}`);
          }
          if (f.steps.length > 6) lines.push(`  - and ${f.steps.length - 6} more`);
        }
        return lines.join("\n");
      },
    },
    {
      name: "lantern_explain_flow",
      title: "Lantern: outline a cloud flow",
      description:
        "Outlines one Power Automate cloud flow from its definition so you can explain what it does: the trigger (table, change, filters, schedule), every step in order with its connector, operation and key parameters, conditions and loops with their expressions, and the connections it uses. Pass the flow's ID (from lantern_search_flows) or its name.",
      inputSchema: { type: "object", properties: { tenant: TENANT, flow: { type: "string", description: "The flow's ID, or its name." } }, required: ["flow"] },
      async invoke(input) {
        const c = pick(input.tenant);
        const dv = dataverseFor(c);
        const row = await findFlow(dv, String(input.flow ?? ""));
        const solutions = (await solutionsOf(dv, [row.workflowid])).get(row.workflowid.toLowerCase()) ?? [];
        const md = outlineFlow(row, solutions);
        // Big flows stay readable for the model: the outline is cut, never the JSON dumped.
        return md.length > 60_000 ? `${md.slice(0, 60_000)}\n\n(outline cut at 60,000 characters)` : md;
      },
    },
    {
      name: "lantern_explain_plugin",
      title: "Lantern: outline a plug-in",
      description:
        "Outlines a Dataverse plug-in so you can explain what it does and when it runs: its assembly, display name and description, every registered step (message, table, stage, sync or async, order, enabled, filtering columns, pre/post images and their columns, run-as user, unsecure configuration), and its C# source when a project in the tenant folder builds it. " +
        "Pass plugin (full or short class name, or display name) or assembly (assembly name, for every class in it). With neither, lists the registered assemblies.",
      inputSchema: {
        type: "object",
        properties: {
          tenant: TENANT,
          plugin: { type: "string", description: "Plug-in class: full type name, class name, or display name (optional)." },
          assembly: { type: "string", description: "Assembly name (optional)." },
        },
      },
      async invoke(input) {
        const c = pick(input.tenant);
        return outlinePlugin(dataverseFor(c), { plugin: str(input.plugin), assembly: str(input.assembly) }, c.dir);
      },
    },
    {
      name: "lantern_explain_web_resource",
      title: "Lantern: outline a web resource",
      description:
        "Shows a Dataverse web resource so you can explain it: type, display name, description, solutions, and its deployed content (scripts, HTML, CSS, XML). For a JavaScript library, also the functions it defines and the forms that load it with the events each function handles (OnLoad, OnSave, OnChange of a column). Pass the full name (like acme_/scripts/account.js) or part of it.",
      inputSchema: { type: "object", properties: { tenant: TENANT, name: { type: "string", description: "Web resource name, or part of it." } }, required: ["name"] },
      async invoke(input) {
        const c = pick(input.tenant);
        return outlineWebResource(dataverseFor(c), String(input.name ?? ""));
      },
    },
    {
      name: "lantern_trace_column",
      title: "Lantern: what affects a column",
      description:
        "Use when someone asks why a field behaves a certain way (gets a value, changes, is required, hidden, locked, or cleared). Gathers everything that can cause it: the column's definition (calculated, rollup or formula, required level, field security, autonumber, default), forms it's on and form events, deployed form-script lines that use it (setValue, setVisible, setRequiredLevel, setDisabled, ...) with the event that runs them, business rules and classic workflows, cloud flows that trigger on it or set it, plug-in steps that filter on it or can change it before save, and code in the tenant folder that mentions it. " +
        "Then use lantern_explain_flow, lantern_explain_plugin or lantern_explain_web_resource on what looks responsible.",
      inputSchema: {
        type: "object",
        properties: { tenant: TENANT, table: { type: "string", description: "Table logical name, like account." }, column: { type: "string", description: "Column logical name, like statuscode." } },
        required: ["table", "column"],
      },
      async invoke(input) {
        const c = pick(input.tenant);
        const table = logicalName(input.table, "table");
        const column = logicalName(input.column, "column");
        const forms = await serviceFor(c).forms(table);
        const md = await traceColumn(dataverseFor(c), table, column, forms, c.dir, (f) => resolveWebResourceName(f, c)?.name);
        return md.length > 60_000 ? `${md.slice(0, 60_000)}\n\n(cut at 60,000 characters)` : md;
      },
    },
    {
      name: "lantern_generate_csharp_classes",
      title: "Lantern: C# classes for plug-ins",
      readOnly: false,
      description:
        "Adds tables and columns to the tenant's C# classes for plug-ins (one partial class per table, only the columns asked for). Use it when someone pastes a user story, spec, or ticket that lists the tables and fields a plug-in reads or writes: extract every table and column it mentions and pass them; display names (\"Approval Status\") or logical names (ohcp_approvalstatus) both work. " +
        "It only adds: columns already in the classes or the queue are kept. By default the tables go into the C# classes queue in VS Code, shown in the status bar, for the person to review and generate; pass generate: true only when they asked for the files to be written now. " +
        "Names it can't match come back with suggestions: check them with lantern_describe_table and call again with the logical names.",
      inputSchema: {
        type: "object",
        properties: {
          tenant: TENANT,
          tables: {
            type: "array",
            description: "Each table the story mentions, with the columns it needs.",
            items: {
              type: "object",
              properties: {
                table: { type: "string", description: "Table logical name or display name, like ohcp_productrequest or Product Request." },
                columns: { type: "array", items: { type: "string" }, description: "Column logical names or display names." },
              },
              required: ["table", "columns"],
            },
          },
          generate: { type: "boolean", description: "Write the .cs files now instead of queueing them for review (default false)." },
          namespace: { type: "string", description: "C# namespace for the classes when generating (optional; empty for none)." },
        },
        required: ["tables"],
      },
      confirm(input) {
        const items = Array.isArray(input.tables) ? (input.tables as Array<{ table?: unknown; columns?: unknown }>) : [];
        const summary = items.map((t) => `${String(t.table)}: ${Array.isArray(t.columns) ? t.columns.join(", ") : ""}`).join("\n");
        return { title: input.generate ? "Write C# classes for these tables now?" : "Queue these tables for C# classes?", message: summary };
      },
      async invoke(input) {
        if (!csharp) throw new Error("C# classes aren't available in this window.");
        const c = pick(input.tenant);
        const items = (Array.isArray(input.tables) ? (input.tables as Array<{ table?: unknown; columns?: unknown }>) : [])
          .map((t) => ({ table: String(t.table ?? "").trim(), columns: Array.isArray(t.columns) ? t.columns.map((x) => String(x).trim()).filter(Boolean) : [] }))
          .filter((t) => t.table);
        if (!items.length) throw new Error('Pass "tables": each with a table name and its columns.');
        return csharp.request(c, items, { generate: input.generate === true, namespace: typeof input.namespace === "string" ? input.namespace : undefined });
      },
    },
  ];
}
