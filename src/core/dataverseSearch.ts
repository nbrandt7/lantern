import type { Client } from "./clients";
import type { DataverseClient } from "./dataverse";
import type { SolutionFlow } from "./flows";
import { fetchOrgSolutions, OrgSolution } from "./admin";
import { fetchTables } from "./metadata";
import type { SearchComponent } from "./commandParser";

/** Rank exact, prefix, substring, and ordered-character matches. */
function solutionMatchScore(solution: OrgSolution, text: string): number | undefined {
  const query = text.toLowerCase();
  const unique = solution.uniqueName.toLowerCase();
  const friendly = solution.friendlyName.toLowerCase();
  if (unique === query) return 0;
  if (unique.startsWith(query)) return 1;
  if (friendly.startsWith(query)) return 2;
  if (unique.includes(query)) return 3;
  if (friendly.includes(query)) return 4;
  const subsequence = (value: string): boolean => {
    let index = 0;
    for (const char of value) if (char === query[index]) index++;
    return index === query.length;
  };
  if (subsequence(unique)) return 5;
  if (subsequence(friendly)) return 6;
  return undefined;
}

/** Search visible Dataverse solutions by unique and display name. */
export async function searchSolutions(query: string, dv: DataverseClient): Promise<OrgSolution[]> {
  const matches = (await fetchOrgSolutions(dv))
    .map((solution) => ({ solution, score: solutionMatchScore(solution, query.trim()) }))
    .filter((entry): entry is { solution: OrgSolution; score: number } => entry.score !== undefined);
  return matches.sort((a, b) => a.score - b.score || a.solution.friendlyName.localeCompare(b.solution.friendlyName))
    .map((entry) => entry.solution);
}

export interface PowerAutomateFlowSearchResult {
  client: Client;
  flow: SolutionFlow;
  solutions: string[];
  solutionId?: string;
}

/** Search cloud flow names in the selected tenant's Dataverse environment. */
export async function searchPowerAutomateFlows(
  client: Client,
  query: string,
  dv: DataverseClient,
  solutionUniqueName?: string
): Promise<PowerAutomateFlowSearchResult[]> {
  const escaped = query.replace(/'/g, "''");
  const filter = `category eq 5 and type eq 1 and contains(name,'${escaped}')`;
  const results: PowerAutomateFlowSearchResult[] = [];
  if (!client.config.org) return results;
  let targetSolutionId: string | undefined;
  if (solutionUniqueName) {
    const solutionFilter = `uniquename eq '${solutionUniqueName.replace(/'/g, "''")}'`;
    const matches = await dv.getAll<{ solutionid: string }>(
      `solutions?$select=solutionid&$filter=${encodeURIComponent(solutionFilter)}`
    );
    if (!matches.length) throw new Error(`Solution "${solutionUniqueName}" was not found in the selected environment.`);
    targetSolutionId = matches[0].solutionid.toLowerCase();
  }
  {
      const rows = await dv.getAll<{
        workflowid: string;
        name: string;
        description: string | null;
        statecode: number;
      }>(`workflows?$select=workflowid,name,description,statecode&$filter=${encodeURIComponent(filter)}`);
      const ids = [...new Set(rows.map((row) => row.workflowid.toLowerCase()))];
      const memberships = new Map<string, string[]>();
      const matchingSolutionFlows = new Set<string>();
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const componentFilter = `componenttype eq 29 and (${chunk.map((id) => `objectid eq ${id}`).join(" or ")})`;
        const components = await dv.getAll<{ objectid: string; _solutionid_value: string }>(
          `solutioncomponents?$select=objectid,_solutionid_value&$filter=${encodeURIComponent(componentFilter)}`
        );
        const solutionIds = [...new Set(components.map((component) => component._solutionid_value.toLowerCase()))];
        const solutions = new Map<string, string>();
        for (let j = 0; j < solutionIds.length; j += 40) {
          const solutionFilter = solutionIds.slice(j, j + 40).map((id) => `solutionid eq ${id}`).join(" or ");
          const solutionRows = await dv.getAll<{ solutionid: string; friendlyname: string; uniquename: string }>(
            `solutions?$select=solutionid,friendlyname,uniquename&$filter=${encodeURIComponent(solutionFilter)}`
          );
          for (const solution of solutionRows) {
            if (solution.uniquename.toLowerCase() === "default") continue;
            solutions.set(solution.solutionid.toLowerCase(), solution.friendlyname || solution.uniquename);
          }
        }
        for (const component of components) {
          const flowId = component.objectid.toLowerCase();
          const solutionId = component._solutionid_value.toLowerCase();
          if (solutionId === targetSolutionId) matchingSolutionFlows.add(flowId);
          const name = solutions.get(solutionId);
          if (!name) continue;
          const flowSolutions = memberships.get(flowId) ?? [];
          if (!flowSolutions.includes(name)) flowSolutions.push(name);
          memberships.set(flowId, flowSolutions);
        }
      }
      results.push(...rows.filter((row) => !targetSolutionId || matchingSolutionFlows.has(row.workflowid.toLowerCase())).map((row) => ({
        client,
        flow: { id: row.workflowid, name: row.name, description: row.description ?? "", state: row.statecode },
        solutions: (memberships.get(row.workflowid.toLowerCase()) ?? []).sort((a, b) => a.localeCompare(b)),
        solutionId: targetSolutionId,
      })));
  }

  results.sort((a, b) => a.flow.name.localeCompare(b.flow.name));
  return results;
}

export interface ComponentSearchResult {
  kind: "table" | "businessRule" | "app";
  id: string;
  name: string;
  detail: string;
  solutions: string[];
  /** The selected solution's ID, when the command is solution-scoped. */
  solutionId?: string;
  /** Business rules are shown under their table in the maker portal. */
  tableName?: string;
  appType?: "model-driven" | "canvas" | "code";
}

/** Exact, prefix, substring, then ordered-character matches. */
function matchScore(values: string[], text: string): number | undefined {
  const query = text.trim().toLowerCase();
  const names = values.map((value) => value.toLowerCase());
  if (names.some((name) => name === query)) return 0;
  if (names.some((name) => name.startsWith(query))) return 1;
  if (names.some((name) => name.includes(query))) return 2;
  if (names.some((name) => {
    let offset = 0;
    for (const character of name) if (character === query[offset]) offset++;
    return offset === query.length;
  })) return 3;
  return undefined;
}

/** Search tables, business rules, or model-driven and canvas apps in the active environment. */
export async function searchComponents(
  component: Exclude<SearchComponent, "powerAutomateFlow">,
  query: string,
  dv: DataverseClient,
  solutionUniqueName?: string
): Promise<ComponentSearchResult[]> {
  let solutionId: string | undefined;
  if (solutionUniqueName) {
    const filter = `uniquename eq '${solutionUniqueName.replace(/'/g, "''")}'`;
    const found = await dv.getAll<{ solutionid: string }>(`solutions?$select=solutionid&$filter=${encodeURIComponent(filter)}`);
    if (!found.length) throw new Error(`Solution "${solutionUniqueName}" was not found in the selected environment.`);
    solutionId = found[0].solutionid.toLowerCase();
  }

  type Candidate = Omit<ComponentSearchResult, "solutions" | "solutionId"> & { componentType: number; score: number };
  const candidates: Candidate[] = [];
  if (component === "table") {
    for (const table of await fetchTables(dv)) {
      const score = matchScore([table.displayName, table.logicalName, table.schemaName], query);
      if (score !== undefined) candidates.push({ kind: "table", id: table.metadataId, name: table.displayName,
        detail: table.logicalName, componentType: 1, score });
    }
  } else if (component === "businessRule") {
    const rows = await dv.getAll<{ workflowid: string; name: string; primaryentity: string }>(
      "workflows?$select=workflowid,name,primaryentity&$filter=category eq 2 and type eq 1"
    );
    for (const rule of rows) {
      const score = matchScore([rule.name], query);
      if (score !== undefined) candidates.push({ kind: "businessRule", id: rule.workflowid, name: rule.name,
        detail: rule.primaryentity || "Business rule", tableName: rule.primaryentity, componentType: 29, score });
    }
  } else {
    const [modelApps, canvasApps] = await Promise.all([
      dv.getAll<{ appmoduleid: string; name: string; uniquename: string }>("appmodules?$select=appmoduleid,name,uniquename"),
      dv.getAll<{ canvasappid: string; name: string; displayname: string; canvasapptype: number }>(
        "canvasapps?$select=canvasappid,name,displayname,canvasapptype"
      ),
    ]);
    for (const app of modelApps) {
      const score = matchScore([app.name, app.uniquename], query);
      if (score !== undefined) candidates.push({ kind: "app", id: app.appmoduleid, name: app.name,
        detail: `Model-driven app · ${app.uniquename}`, appType: "model-driven", componentType: 80, score });
    }
    for (const app of canvasApps) {
      if (app.canvasapptype !== 0 && app.canvasapptype !== 4) continue;
      const score = matchScore([app.displayname || app.name, app.name], query);
      if (score !== undefined) candidates.push({ kind: "app", id: app.canvasappid, name: app.displayname || app.name,
        detail: app.canvasapptype === 4 ? "Code app" : "Canvas app",
        appType: app.canvasapptype === 4 ? "code" : "canvas", componentType: 300, score });
    }
  }

  const memberships = new Map<string, Set<string>>();
  const solutionIds = new Set<string>();
  const selected = new Set<string>();
  for (let i = 0; i < candidates.length; i += 30) {
    const chunk = candidates.slice(i, i + 30);
    const filters = [...new Set(chunk.map((row) => row.componentType))].map((type) =>
      `(componenttype eq ${type} and (${chunk.filter((row) => row.componentType === type).map((row) => `objectid eq ${row.id}`).join(" or ")}))`
    );
    const rows = await dv.getAll<{ objectid: string; componenttype: number; _solutionid_value: string }>(
      `solutioncomponents?$select=objectid,componenttype,_solutionid_value&$filter=${encodeURIComponent(filters.join(" or "))}`
    );
    for (const row of rows) {
      const key = `${row.componenttype}|${row.objectid.toLowerCase()}`;
      const id = row._solutionid_value.toLowerCase();
      if (id === solutionId) selected.add(key);
      solutionIds.add(id);
      const list = memberships.get(key) ?? new Set<string>();
      list.add(id);
      memberships.set(key, list);
    }
  }
  const labels = new Map<string, string>();
  const ids = [...solutionIds];
  for (let i = 0; i < ids.length; i += 30) {
    const filter = ids.slice(i, i + 30).map((id) => `solutionid eq ${id}`).join(" or ");
    const rows = await dv.getAll<{ solutionid: string; friendlyname: string; uniquename: string }>(
      `solutions?$select=solutionid,friendlyname,uniquename&$filter=${encodeURIComponent(filter)}`
    );
    for (const row of rows) if (!["default", "active"].includes(row.uniquename.toLowerCase())) {
      labels.set(row.solutionid.toLowerCase(), row.friendlyname || row.uniquename);
    }
  }
  return candidates.filter((row) => !solutionId || selected.has(`${row.componentType}|${row.id.toLowerCase()}`))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .map(({ componentType, score, ...row }) => ({ ...row, solutionId,
      solutions: [...(memberships.get(`${componentType}|${row.id.toLowerCase()}`) ?? [])]
        .map((id) => labels.get(id)).filter((name): name is string => !!name).sort((a, b) => a.localeCompare(b)),
    }));
}
