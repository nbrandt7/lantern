import * as vscode from "vscode";
import { fetchOrgSolutions, OrgSolution } from "../core/admin";
import { Client } from "../core/clients";
import { MetadataService, TableMeta } from "../core/metadata";
import { addToSolution, ComponentKind, ComponentRef, idsInSolution, KIND_LABEL, removeFromSolution, solutionsContaining } from "../core/solutionComponents";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, reportError, withProgress } from "../ui/context";
import { makerEnvironmentId, openEnvironmentUrl } from "../ui/environmentBrowser";
import { openPowerAutomateFlow } from "./openPowerAutomateFlow";
import { openSolution } from "./openSolution";
import { componentFor, NodeComponent } from "../ui/solutionRefs";

/**
 * Add to Solution and Remove from Solution on plug-in assemblies and packages,
 * steps, web resources, cloud flows, tables and columns: the maker portal's Add
 * existing (with Select components for a table's columns), without leaving VS Code.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const where = (c: Client) => c.envName || c.orgHost;

/** A solution to change: the tenant's own first, then the org's other unmanaged ones. */
async function pickSolution(client: Client, solutions: OrgSolution[], inIt: Set<string>, title: string): Promise<OrgSolution | undefined> {
  const mine = new Set(client.config.solutions.map((s) => s.toLowerCase()));
  const items = solutions
    .filter((s) => !s.managed && !["default", "active"].includes(s.uniqueName.toLowerCase()))
    .map((s) => ({
      label: s.friendlyName,
      description: [s.uniqueName, mine.has(s.uniqueName.toLowerCase()) ? "this tenant's" : "", inIt.has(s.uniqueName) ? "already in it" : ""].filter(Boolean).join(" · "),
      s,
      order: mine.has(s.uniqueName.toLowerCase()) ? 0 : 1,
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  if (!items.length) {
    void vscode.window.showWarningMessage(`${where(client)} has no unmanaged solutions to add to.`);
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { title, placeHolder: "Which solution?", matchOnDescription: true }))?.s;
}

async function addCommand(arg: unknown, serviceFor: (c: Client) => MetadataService, onChanged: (c: Client) => void): Promise<void> {
  const target = await componentFor(arg);
  if (!target) {
    void vscode.window.showWarningMessage("Lantern can't add this to a solution. Plug-ins have to be registered first.");
    return;
  }
  const { client, ref } = target;
  const dv = dataverseFor(client);
  const loaded = await withProgress("Checking solutions", async () => ({ membership: await solutionsContaining(dv, ref), solutions: await fetchOrgSolutions(dv) }));
  if (!loaded) return;
  const inIt = new Set(loaded.membership.map((m) => m.uniqueName));
  const solution = await pickSolution(client, loaded.solutions, inIt, `Add ${ref.label} to a solution`);
  if (!solution) return;
  const already = inIt.has(solution.uniqueName);
  if (already && ref.kind !== "table") {
    void vscode.window.showInformationMessage(`${ref.label} is already in ${solution.friendlyName}.`);
    return;
  }

  let addRequired = false;
  let tableOnly = false;
  let columns: { add: ComponentRef[]; remove: ComponentRef[] } | undefined;
  if (ref.kind === "step" || ref.kind === "flow") {
    const pick = await vscode.window.showQuickPick(
      ref.kind === "step"
        ? [
            { label: "The step and the assembly it runs", description: "needed to import the step into another environment", required: true },
            { label: "Only the step", description: "the assembly is in the solution already, or comes another way", required: false },
          ]
        : [
            { label: "The flow and what it needs", description: "its connection references, environment variables and child flows", required: true },
            { label: "Only the flow", required: false },
          ],
      { title: `Add ${ref.label} to ${solution.friendlyName}` }
    );
    if (!pick) return;
    addRequired = pick.required;
  } else if (ref.kind === "table") {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(checklist) The table and the columns I pick…", description: "the table's definition plus only those columns", value: "pick" },
        { label: "Only the table", description: "its definition (metadata), without columns, forms or views", value: "only" },
        { label: "The table and everything in it", description: "every column, form, view, chart, relationship and key", value: "all" },
      ],
      { title: `Add ${ref.label} to ${solution.friendlyName}`, placeHolder: already ? "The table is already in it: pick columns to add or remove" : undefined }
    );
    if (!pick) return;
    tableOnly = pick.value !== "all";
    if (pick.value === "pick") {
      const table = (arg as { table: { logicalName: string } }).table;
      const all = await withProgress(`Loading ${table.logicalName}'s columns`, () => serviceFor(client).columns(table.logicalName));
      if (!all) return;
      const cols = all.filter((c) => !c.attributeOf && c.metadataId);
      const present = await withProgress("Checking which columns are in the solution", () => idsInSolution(dv, solution.id, "column", cols.map((c) => c.metadataId!)));
      if (!present) return;
      const isIn = (id: string) => present.has(id.toLowerCase());
      const picked = await vscode.window.showQuickPick(
        cols
          .map((c) => ({ label: c.displayName || c.logicalName, description: `${c.logicalName} · ${c.type}${isIn(c.metadataId!) ? " · in the solution" : ""}`, picked: isIn(c.metadataId!), c }))
          .sort((a, b) => Number(b.picked) - Number(a.picked) || Number(b.c.isCustom) - Number(a.c.isCustom) || a.label.localeCompare(b.label)),
        { title: `${ref.label} columns in ${solution.friendlyName}`, placeHolder: "Tick the columns the solution should have. What's in it now is ticked; untick to take one out.", canPickMany: true, matchOnDescription: true, ignoreFocusOut: true }
      );
      if (!picked) return;
      const want = new Set(picked.map((p: { c: { metadataId?: string } }) => p.c.metadataId!.toLowerCase()));
      const toRef = (c: (typeof cols)[number]): ComponentRef => ({ kind: "column", id: c.metadataId!, label: `${c.displayName || c.logicalName} (${c.logicalName})` });
      columns = { add: cols.filter((c) => want.has(c.metadataId!.toLowerCase()) && !isIn(c.metadataId!)).map(toRef), remove: cols.filter((c) => !want.has(c.metadataId!.toLowerCase()) && isIn(c.metadataId!)).map(toRef) };
      if (columns.remove.length) {
        const go = "Remove Them";
        const answer = await vscode.window.showWarningMessage(
          `Take ${plural(columns.remove.length, "column")} out of ${solution.friendlyName}?`,
          { modal: true, detail: `${columns.remove.map((c) => c.label).join(", ")}. They stay in the environment; the solution just stops including them.` },
          go
        );
        if (answer !== go) return;
      }
      if (already && !columns.add.length && !columns.remove.length) {
        void vscode.window.showInformationMessage(`No change to ${ref.label} in ${solution.friendlyName}.`);
        return;
      }
    } else if (already) {
      void vscode.window.showInformationMessage(`${ref.label} is already in ${solution.friendlyName}.`);
      return;
    }
  }
  if (!(await confirmProtected(client, `Change the solution ${solution.friendlyName}`))) return;

  const done = await withProgress(`Adding ${ref.label} to ${solution.friendlyName}`, async (ctx) => {
    const notes: string[] = [];
    // A column needs its table in the solution; the maker portal adds it as metadata only.
    if (ref.kind === "column" && target.table?.metadataId) {
      const tableRef: ComponentRef = { kind: "table", id: target.table.metadataId, label: target.table.displayName || target.table.logicalName };
      const tableIn = (await solutionsContaining(dv, tableRef)).some((m) => m.uniqueName === solution.uniqueName);
      if (!tableIn) {
        await addToSolution(dv, tableRef, solution.uniqueName, { addRequired: false, tableOnly: true });
        notes.push(`added its table, ${tableRef.label}, as metadata only`);
      }
    }
    if (!already) {
      await addToSolution(dv, ref, solution.uniqueName, { addRequired, tableOnly });
      ctx.log(`Added ${KIND_LABEL[ref.kind]} ${ref.label} to ${solution.uniqueName}\n`);
    }
    for (const c of columns?.add ?? []) {
      await addToSolution(dv, c, solution.uniqueName, { addRequired: false });
      ctx.log(`Added column ${c.label}\n`);
    }
    for (const c of columns?.remove ?? []) {
      await removeFromSolution(dv, c, solution.uniqueName);
      ctx.log(`Removed column ${c.label}\n`);
    }
    if (columns?.add.length) notes.push(`added ${plural(columns.add.length, "column")}`);
    if (columns?.remove.length) notes.push(`took out ${plural(columns.remove.length, "column")}`);
    if (ref.kind === "table" && !already) notes.push(tableOnly ? "as metadata only" : "with everything in it");
    if (addRequired) notes.push(ref.kind === "step" ? "with the assembly it runs" : "with what it needs");
    return notes;
  });
  onChanged(client);
  if (done) void vscode.window.showInformationMessage(`${already ? "Updated" : "Added"} ${ref.label} ${already ? "in" : "to"} ${solution.friendlyName}${done.length ? `: ${done.join(", ")}` : ""}.`);
}

async function removeCommand(arg: unknown, onChanged: (c: Client) => void): Promise<void> {
  const target: NodeComponent | undefined = await componentFor(arg);
  if (!target) return;
  const { client, ref } = target;
  const dv = dataverseFor(client);
  const membership = await withProgress("Checking solutions", () => solutionsContaining(dv, ref));
  if (!membership) return;
  const candidates = membership.filter((m) => !m.managed && (!target.solution || m.uniqueName.toLowerCase() === target.solution.toLowerCase()));
  if (!candidates.length) {
    void vscode.window.showInformationMessage(`${ref.label} isn't in ${target.solution ?? "any unmanaged solution"}.`);
    return;
  }
  const solution = candidates.length === 1
    ? candidates[0]
    : (await vscode.window.showQuickPick(candidates.map((m) => ({ label: m.friendlyName, description: m.uniqueName, m })), { title: `Remove ${ref.label} from which solution?` }))?.m;
  if (!solution) return;
  const go = "Remove";
  const answer = await vscode.window.showWarningMessage(
    `Remove ${ref.label} from ${solution.friendlyName}?`,
    { modal: true, detail: `It stays in ${where(client)}; the solution just stops including it.` },
    go
  );
  if (answer !== go || !(await confirmProtected(client, `Change the solution ${solution.friendlyName}`))) return;
  const ok = await withProgress(`Removing ${ref.label} from ${solution.friendlyName}`, async () => {
    await removeFromSolution(dv, ref, solution.uniqueName);
    return true;
  });
  onChanged(client);
  if (ok) void vscode.window.showInformationMessage(`Removed ${ref.label} from ${solution.friendlyName}. It's still in ${where(client)}.`);
}

type SectionNode = {
  kind?: string;
  client: Client;
  /** solutionPart: the solution's unique name. */
  unique?: string;
  part?: "tables" | "webresources" | "flows";
  /** Columns and Forms under a solution's table. */
  solution?: string;
  table?: TableMeta;
};

/**
 * The + on a solution's Tables, Web resources and Power Automate flows, and on Columns
 * and Forms under one of its tables: a searchable list of what isn't in the solution
 * yet, tick several, add them all.
 */
async function addExisting(arg: unknown, serviceFor: (c: Client) => MetadataService, onChanged: (c: Client) => void): Promise<void> {
  const n = arg as SectionNode | undefined;
  if (!n?.client) return;
  const client = n.client;
  const unique = n.kind === "solutionPart" ? n.unique : n.solution;
  const kind: ComponentKind | undefined =
    n.kind === "solutionPart" ? ({ tables: "table", webresources: "webResource", flows: "flow" } as const)[n.part!] : n.kind === "columns" ? "column" : n.kind === "forms" ? "form" : undefined;
  if (!unique || !kind) return;
  const dv = dataverseFor(client);
  const service = serviceFor(client);
  const loaded = await withProgress(`Loading what can go into ${unique}`, async () => {
    const [solution] = await dv.getAll<{ solutionid: string; friendlyname: string; ismanaged: boolean }>(`solutions?$select=solutionid,friendlyname,ismanaged&$filter=uniquename eq '${unique.replace(/'/g, "''")}'`);
    if (!solution) throw new Error(`There's no solution named ${unique}.`);
    let candidates: Array<ComponentRef & { description: string; detail?: string }> = [];
    // Fresh metadata: what's being added may have been created a moment ago.
    if (kind === "table") {
      candidates = (await service.tables({ force: true })).filter((t) => t.metadataId).map((t) => ({ kind, id: t.metadataId, label: t.displayName || t.logicalName, description: t.logicalName, detail: t.isCustom ? "custom" : undefined }));
    } else if (kind === "column") {
      candidates = (await service.columns(n.table!.logicalName, { force: true })).filter((c) => !c.attributeOf && c.metadataId).map((c) => ({ kind, id: c.metadataId!, label: c.displayName || c.logicalName, description: `${c.logicalName} · ${c.type}`, detail: c.isCustom ? "custom" : undefined }));
    } else if (kind === "form") {
      candidates = (await service.forms(n.table!.logicalName, { force: true })).map((f) => ({ kind, id: f.id, label: f.name, description: f.type }));
    } else if (kind === "webResource") {
      const rows = await dv.getAll<{ webresourceid: string; name: string; displayname: string | null; webresourcetype: number }>("webresourceset?$select=webresourceid,name,displayname,webresourcetype&$filter=ismanaged eq false&$orderby=name");
      candidates = rows.map((r) => ({ kind, id: r.webresourceid, label: r.name, description: r.displayname && r.displayname !== r.name ? r.displayname : "" }));
    } else {
      const rows = await dv.getAll<{ workflowid: string; name: string; statecode: number }>(`workflows?$select=workflowid,name,statecode&$filter=${encodeURIComponent("category eq 5 and type eq 1")}&$orderby=name`);
      candidates = rows.map((r) => ({ kind, id: r.workflowid, label: r.name, description: r.statecode === 1 ? "on" : "off" }));
    }
    const present = await idsInSolution(dv, solution.solutionid, kind, candidates.map((c) => c.id));
    return { solution, candidates: candidates.filter((c) => !present.has(c.id.toLowerCase())) };
  });
  if (!loaded) return;
  const { solution, candidates } = loaded;
  if (solution.ismanaged) {
    void vscode.window.showWarningMessage(`${solution.friendlyname} is managed, so nothing can be added to it here.`);
    return;
  }
  const what = { table: "tables", column: "columns", form: "forms", webResource: "web resources", flow: "cloud flows" }[kind as "table"];
  if (!candidates.length) {
    void vscode.window.showInformationMessage(`Every ${what.replace(/s$/, "")} ${kind === "column" || kind === "form" ? `of ${n.table!.logicalName} ` : ""}is in ${solution.friendlyname} already.`);
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    candidates
      .sort((a, b) => Number(!!b.detail) - Number(!!a.detail) || a.label.localeCompare(b.label))
      .map((c) => ({ label: c.label, description: c.description, detail: c.detail, ref: { kind: c.kind, id: c.id, label: c.label } as ComponentRef })),
    { title: `Add ${what} to ${solution.friendlyname}${n.table ? ` (${n.table.logicalName})` : ""}`, placeHolder: `Search and tick the ${what} to add (only ones not in the solution are listed)`, canPickMany: true, matchOnDescription: true, ignoreFocusOut: true }
  );
  if (!chosen?.length) return;
  const picks = chosen.map((c: { ref: ComponentRef }) => c.ref);
  let tableOnly = false;
  let addRequired = false;
  if (kind === "table") {
    const mode = await vscode.window.showQuickPick(
      [
        { label: "Only the tables", description: "their definitions (metadata); add columns and forms from each table's + later", value: true },
        { label: "The tables and everything in them", description: "every column, form, view, chart, relationship and key", value: false },
      ],
      { title: `Add ${plural(picks.length, "table")} to ${solution.friendlyname}` }
    );
    if (!mode) return;
    tableOnly = mode.value;
  } else if (kind === "flow") {
    const mode = await vscode.window.showQuickPick(
      [
        { label: "The flows and what they need", description: "their connection references, environment variables and child flows", value: true },
        { label: "Only the flows", value: false },
      ],
      { title: `Add ${plural(picks.length, "flow")} to ${solution.friendlyname}` }
    );
    if (!mode) return;
    addRequired = mode.value;
  }
  if (!(await confirmProtected(client, `Change the solution ${solution.friendlyname}`))) return;
  const done = await withProgress(`Adding ${plural(picks.length, what.replace(/s$/, ""), what)} to ${solution.friendlyname}`, async (ctx, progress) => {
    for (const p of picks) {
      progress.report({ message: p.label });
      await addToSolution(dv, p, unique, { addRequired, tableOnly });
      ctx.log(`Added ${KIND_LABEL[kind]} ${p.label} to ${unique}\n`);
    }
    return true;
  });
  onChanged(client);
  if (done) void vscode.window.showInformationMessage(`Added ${picks.length === 1 ? picks[0].label : plural(picks.length, what.replace(/s$/, ""), what)} to ${solution.friendlyname}.`);
}

/** The solution's ID by unique name, or the Default solution's when the item isn't under one. */
async function solutionId(client: Client, unique: string | undefined): Promise<string> {
  const rows = await dataverseFor(client).getAll<{ solutionid: string }>(`solutions?$select=solutionid&$filter=uniquename eq '${(unique || "Default").replace(/'/g, "''")}'`);
  if (!rows[0]) throw new Error(`There's no solution named ${unique || "Default"}.`);
  return rows[0].solutionid;
}

/** Open in Maker Portal: the solution, table (columns open their table), form, web resource or flow. */
async function openInMaker(arg: unknown): Promise<void> {
  const n = arg as { kind?: string; client?: Client; unique?: string; solution?: string; table?: TableMeta; form?: { id: string }; resource?: { id: string }; flow?: { id: string } } | undefined;
  const client = n?.client;
  if (!client?.config.org) return;
  const env = await makerEnvironmentId(client);
  const base = `https://make.powerapps.com/environments/${encodeURIComponent(env)}`;
  switch (n!.kind) {
    case "solution":
      return openSolution(client, await solutionId(client, n!.unique));
    case "table":
    case "column": {
      const sid = await solutionId(client, n!.solution);
      return openEnvironmentUrl(client, `${base}/solutions/${encodeURIComponent(sid)}/entities/${encodeURIComponent(n!.table!.metadataId)}`);
    }
    case "form": {
      const sid = await solutionId(client, n!.solution);
      return openEnvironmentUrl(client, `https://make.powerapps.com/e/${encodeURIComponent(env)}/s/${encodeURIComponent(sid)}/entity/${encodeURIComponent(n!.table!.logicalName)}/form/edit/${encodeURIComponent(n!.form!.id)}`);
    }
    case "webResource": {
      // The maker portal has no page for one web resource, so the solution's Web resources list is
      // the closest; it opens the editor from there. Without a solution, the classic editor (etc is
      // the web resource type code; without it main.aspx falls through to the app's default page).
      const unique = n!.unique ?? n!.solution;
      if (!unique) return openEnvironmentUrl(client, `${client.config.org.replace(/\/$/, "")}/main.aspx?etc=9333&pagetype=webresourceedit&id=%7b${encodeURIComponent(n!.resource!.id)}%7d`);
      const sid = await solutionId(client, unique);
      return openEnvironmentUrl(client, `${base}/solutions/${encodeURIComponent(sid)}/objects/web%20resources`);
    }
    case "flow":
      return openPowerAutomateFlow(client, n!.flow!.id, n!.unique ? await solutionId(client, n!.unique) : undefined);
  }
}

export function registerSolutionComponents(serviceFor: (c: Client) => MetadataService, onChanged: (c: Client) => void): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });
  return [
    r("lantern.solutions.addComponent", (arg: unknown) => addCommand(arg, serviceFor, onChanged)),
    r("lantern.solutions.removeComponent", (arg: unknown) => removeCommand(arg, onChanged)),
    r("lantern.solutions.addExisting", (arg: unknown) => addExisting(arg, serviceFor, onChanged)),
    r("lantern.openInMaker", (arg: unknown) => openInMaker(arg)),
  ];
}
