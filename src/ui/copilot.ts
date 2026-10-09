import * as vscode from "vscode";
import { Client } from "../core/clients";
import { MetadataService } from "../core/metadata";
import { runQuery, cellText } from "../core/query";
import { findUsages, usageMarkdown } from "../core/references";
import { parseStatement } from "../core/sql";
import { resolveWebResourceName } from "../core/solutions";
import { dataverseFor } from "./auth";
import { scanAll, settings } from "./context";

/**
 * Tools Copilot Chat (agent mode) can call: they read from the client's Dataverse org
 * through Lantern's sign-in. Nothing here changes data: queries are SELECT or FetchXML
 * only, and each query asks before it runs.
 */
type LmApi = {
  registerTool?: (name: string, tool: unknown) => vscode.Disposable;
};

interface ToolOptions<T> {
  input: T;
}

export function registerCopilotTools(serviceFor: (c: Client) => MetadataService): vscode.Disposable[] {
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  const ResultClass = (vscode as unknown as { LanguageModelToolResult?: new (parts: unknown[]) => unknown }).LanguageModelToolResult;
  const TextPart = (vscode as unknown as { LanguageModelTextPart?: new (text: string) => unknown }).LanguageModelTextPart;
  if (!lm?.registerTool || !ResultClass || !TextPart) return [];
  const text = (t: string) => new ResultClass([new TextPart(t)]);

  const pick = (name?: string): Client => {
    const clients = scanAll().clients.filter((c) => c.config.org);
    if (!clients.length) throw new Error("No client folders are connected to Dataverse.");
    if (!name) {
      if (clients.length === 1) return clients[0];
      throw new Error(`Say which client: ${clients.map((c) => c.name).join(", ")}.`);
    }
    const c = clients.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`No client named ${name}. Clients: ${clients.map((x) => x.name).join(", ")}.`);
    return c;
  };
  const tool = <T>(invoke: (input: T) => Promise<string>, confirm?: (input: T) => { title: string; message: string }) => ({
    async invoke(options: ToolOptions<T>) {
      try {
        return text(await invoke(options.input));
      } catch (err) {
        return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    ...(confirm ? { prepareInvocation: (options: ToolOptions<T>) => ({ confirmationMessages: confirm(options.input) }) } : {}),
  });

  return [
    lm.registerTool(
      "lantern_clients",
      tool<Record<string, never>>(async () => {
        const lines = scanAll().clients.map((c) => {
          const envs = c.environments.length ? ` Environments: ${c.environments.map((e) => `${e.name}${e.protected ? " (protected)" : ""}`).join(", ")}; active ${c.envName}.` : "";
          return `- ${c.name}: ${c.config.org || "no org"}.${envs} Solutions: ${c.config.solutions.join(", ") || "none"}.`;
        });
        return lines.length ? lines.join("\n") : "No client folders in this workspace.";
      })
    ),
    lm.registerTool(
      "lantern_describe_table",
      tool<{ client?: string; table: string }>(async ({ client, table }) => {
        const c = pick(client);
        const svc = serviceFor(c);
        const t = (await svc.tables()).find((x) => x.logicalName === table.toLowerCase() || x.displayName.toLowerCase() === table.toLowerCase());
        if (!t) throw new Error(`There's no table named ${table} in ${c.orgHost}.`);
        const [columns, forms] = await Promise.all([svc.columns(t.logicalName), svc.forms(t.logicalName)]);
        const cols = columns
          .filter((x) => !x.attributeOf)
          .map((x) => `- ${x.logicalName} (${x.displayName}): ${x.type}${x.requiredLevel !== "None" ? `, ${x.requiredLevel}` : ""}${x.options?.length ? `, choices ${x.options.map((o) => `${o.value}=${o.label}`).join(", ")}` : ""}${x.targets?.length ? ` -> ${x.targets.join("/")}` : ""}`);
        const formLines = forms.map((f) => `- ${f.name} (${f.type}): ${f.events.flatMap((e) => e.handlers.map((h) => `${e.name}${e.attribute ? `(${e.attribute})` : ""} ${h.functionName}`)).join("; ") || "no handlers"}`);
        return `${t.displayName} (${t.logicalName}), entity set ${t.entitySetName}, primary ${t.primaryId} / ${t.primaryName}.\n\nColumns:\n${cols.join("\n")}\n\nForms:\n${formLines.join("\n")}`;
      })
    ),
    lm.registerTool(
      "lantern_query",
      tool<{ client?: string; query: string }>(
        async ({ client, query }) => {
          const c = pick(client);
          if (!/^\s*<fetch/i.test(query)) {
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
          const shown = set.rows.slice(0, 50);
          const md = [`| ${set.columns.join(" | ")} |`, `|${set.columns.map(() => "---").join("|")}|`, ...shown.map((r) => `| ${r.map((cell) => cellText(cell, true).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`)];
          return `${set.rows.length} row(s)${set.rows.length > shown.length ? `, first ${shown.length} shown` : ""}${set.truncated ? " (more exist)" : ""} from ${c.name}${c.envName ? ` ${c.envName}` : ""}:\n\n${md.join("\n")}`;
        },
        ({ client, query }) => {
          let where = client ?? "";
          try {
            const c = pick(client);
            where = `${c.name}${c.envName ? ` (${c.envName}${c.isProtected ? ", protected" : ""})` : ""}`;
          } catch {
            // reported when it runs
          }
          return { title: `Run a read-only query on ${where}?`, message: query };
        }
      )
    ),
    lm.registerTool(
      "lantern_where_used",
      tool<{ client?: string; table: string; column: string }>(async ({ client, table, column }) => {
        const c = pick(client);
        const forms = await serviceFor(c).forms(table.toLowerCase());
        const report = await findUsages(dataverseFor(c), table.toLowerCase(), column.toLowerCase(), forms, c.dir, (f) => resolveWebResourceName(f, c)?.name);
        return usageMarkdown(report, `${table}.${column}`, (file, line) => `${file}:${line}`, c.dir);
      })
    ),
  ];
}
