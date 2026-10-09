import * as vscode from "vscode";
import { fetchUsers } from "../core/admin";
import { Client } from "../core/clients";
import { MetadataService } from "../core/metadata";
import { ResultSet } from "../core/query";
import { ACTIONS, DEPTH_LABEL, explainAccess, rolePrivileges } from "../core/security";
import { dataverseFor } from "../ui/auth";
import { reportError, resolveClient, withProgress } from "../ui/context";
import { ResultsView } from "../ui/results";
import { resolveRecord } from "./admin";
import { TableDocProvider } from "./metadata";

export function registerSecurityCommands(serviceFor: (c: Client) => MetadataService, results: ResultsView, docs: TableDocProvider): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });
  return [
    r("lantern.security.role", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org) return;
      const dv = dataverseFor(client);
      const roles = await withProgress("Loading security roles", () =>
        dv.getAll<{ roleid: string; name: string }>("roles?$select=roleid,name&$filter=_parentroleid_value eq null&$orderby=name")
      );
      if (!roles) return;
      const pick = await vscode.window.showQuickPick(roles.map((x) => ({ label: x.name, role: x })), { placeHolder: "Which security role?" });
      if (!pick) return;
      const set = await withProgress(`Reading ${pick.role.name}`, async () => {
        const tables = await serviceFor(client).tables();
        const privs = await rolePrivileges(dv, pick.role.roleid, tables);
        const byName = new Map(tables.map((t) => [t.logicalName, t]));
        const rows = [...privs.tables.entries()]
          .map(([table, actions]) => ({ table, display: byName.get(table)?.displayName ?? table, actions }))
          .sort((a, b) => a.display.localeCompare(b.display));
        const result: ResultSet = {
          source: `Security role: ${pick.role.name}`,
          table: "role",
          fetchXml: "",
          columns: ["Table", "Logical name", ...ACTIONS.map((a) => (a === "AppendTo" ? "Append To" : a))],
          rows: rows.map((row) => [{ raw: row.display }, { raw: row.table }, ...ACTIONS.map((a) => ({ raw: row.actions[a] ? DEPTH_LABEL[row.actions[a]!] : null }))]),
          rowIds: [],
          truncated: false,
          elapsedMs: 0,
          kind: "report",
        };
        return result;
      });
      if (set) await results.show(`${pick.role.name} (${client.name})`, client, { sets: [set], errors: [] });
    }),

    r("lantern.security.whyAccess", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client?.config.org) return;
      const dv = dataverseFor(client);
      const users = await withProgress(`Loading users from ${client.orgHost}`, () => fetchUsers(dv));
      if (!users) return;
      const user = await vscode.window.showQuickPick(users.map((u) => ({ label: u.fullname, description: u.domainname, u })), {
        placeHolder: "Whose access should be checked?",
        matchOnDescription: true,
      });
      if (!user) return;
      const clip = await vscode.env.clipboard.readText();
      const input = await vscode.window.showInputBox({
        title: `Can ${user.label} see this record?`,
        prompt: "Paste a record URL from the app, a GUID, or table:GUID",
        value: /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(clip) ? clip.trim() : "",
        ignoreFocusOut: true,
      });
      if (!input) return;
      const service = serviceFor(client);
      const target = await resolveRecord(client, input, service);
      if (!target) return;
      const e = await withProgress(`Checking ${user.label}'s access`, async () => explainAccess(dv, user.u.systemuserid, target.table, target.id, await service.tables()));
      if (!e) return;
      const lines = [
        `# Can ${user.label} see this ${target.table.displayName}?`,
        "",
        `**${e.canRead ? "Yes" : "No"}.** Dataverse reports: ${e.rights.length ? e.rights.map((x) => x.replace(/Access$/, "")).join(", ") : "no access"}.`,
        "",
        "## Why",
        "",
        ...e.reasons.map((x) => `- ${x}`),
        "",
        "## Details",
        "",
        `- Record: ${target.table.logicalName} \`${target.id}\`, owned by ${e.owner}, in business unit ${e.recordBusinessUnit}`,
        `- ${user.label}'s business unit: ${e.userBusinessUnit}`,
        `- Best Read level from their roles: ${e.readDepth ? DEPTH_LABEL[e.readDepth] : "none"}`,
        `- Their roles: ${e.roles.join(", ") || "none"}`,
        `- Roles through teams: ${e.teamRoles.join(", ") || "none"}`,
        "",
      ];
      const uri = vscode.Uri.from({ scheme: TableDocProvider.scheme, path: `/${client.name}/access-${target.id}.md` });
      docs.set(uri, lines.join("\n"));
      try {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
      } catch {
        await vscode.window.showTextDocument(uri, { preview: true });
      }
    }),
  ];
}
