import type { Client } from "./clients";
import type { DataverseClient } from "./dataverse";
import type { SolutionFlow } from "./flows";

export interface PowerAutomateFlowSearchResult {
  client: Client;
  flow: SolutionFlow;
  solutions: string[];
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
      })));
  }

  results.sort((a, b) => a.flow.name.localeCompare(b.flow.name));
  return results;
}
