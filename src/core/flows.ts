import { DataverseClient } from "./dataverse";
import { UserError } from "./errors";

export interface SolutionFlow {
  id: string;
  name: string;
  description: string;
  state: number;
}

/** Solution process components include classic workflows; category 5 selects cloud flows. */
export async function fetchSolutionFlows(dv: DataverseClient, uniqueName: string): Promise<SolutionFlow[]> {
  const solutions = await dv.getAll<{ solutionid: string }>(
    `solutions?$select=solutionid&$filter=uniquename eq '${uniqueName.replace(/'/g, "''")}'`
  );
  if (!solutions[0]) throw new UserError(`There's no solution named ${uniqueName} in this org.`);
  const components = await dv.getAll<{ objectid: string }>(
    `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${solutions[0].solutionid} and componenttype eq 29`
  );
  const ids = [...new Set(components.map((c) => c.objectid.toLowerCase()))];
  const flows: SolutionFlow[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const filter = `category eq 5 and type eq 1 and (${ids.slice(i, i + 40).map((id) => `workflowid eq ${id}`).join(" or ")})`;
    const rows = await dv.getAll<{ workflowid: string; name: string; description: string | null; statecode: number }>(
      `workflows?$select=workflowid,name,description,statecode&$filter=${encodeURIComponent(filter)}`
    );
    flows.push(...rows.map((r) => ({ id: r.workflowid, name: r.name, description: r.description ?? "", state: r.statecode })));
  }
  return flows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function flowEditorUrl(dv: DataverseClient, flowId: string): Promise<string> {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(flowId)) throw new UserError("The flow ID is invalid. Refresh the solution and try again.");
  const { Detail } = await dv.getJson<{ Detail: { EnvironmentId?: string } }>(
    "RetrieveCurrentOrganization(AccessType=@p)?@p=Microsoft.Dynamics.CRM.EndpointAccessType'Default'"
  );
  const environmentId = Detail?.EnvironmentId?.trim();
  if (!environmentId) throw new UserError("Dataverse didn't return a Power Platform environment ID for this org.");
  return `https://make.powerautomate.com/environments/${encodeURIComponent(environmentId)}/flows/${encodeURIComponent(flowId)}?v3=true`;
}
