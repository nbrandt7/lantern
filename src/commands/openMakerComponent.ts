import { Client } from "../core/clients";
import { dataverseFor } from "../ui/auth";
import { makerEnvironmentId, openEnvironmentUrl } from "../ui/environmentBrowser";
import type { ComponentSearchResult } from "../core/dataverseSearch";
import type { AppAction } from "../core/commandParser";
import { UserError } from "../core/errors";

/** Open the selected maker component, retaining an explicit solution when provided. */
export async function openMakerComponent(client: Client, component: ComponentSearchResult, appAction?: AppAction): Promise<void> {
  const dv = dataverseFor(client);
  const environmentId = await makerEnvironmentId(client);
  const environment = `https://make.powerapps.com/environments/${encodeURIComponent(environmentId)}`;
  let solutionId = component.solutionId;
  const needsSolution = component.kind !== "app" || (component.appType === "model-driven" && appAction === "edit");
  if (!solutionId && needsSolution) {
    const defaultSolution = await dv.getAll<{ solutionid: string }>(
      "solutions?$select=solutionid&$filter=uniquename eq 'Default'"
    );
    if (!defaultSolution.length) throw new Error("The environment's Default Solution could not be found.");
    solutionId = defaultSolution[0].solutionid;
  }

  let url: string;
  if (component.kind === "table") {
    url = `${environment}/solutions/${encodeURIComponent(solutionId!)}/entities/${encodeURIComponent(component.id)}`;
  } else if (component.kind === "businessRule") {
    const name = component.tableName;
    if (!name) throw new Error(`Business rule "${component.name}" has no table to open.`);
    const table = await dv.getJson<{ MetadataId: string }>(
      `EntityDefinitions(LogicalName='${name.replace(/'/g, "''")}')?$select=MetadataId`
    );
    url = `${environment}/solutions/${encodeURIComponent(solutionId!)}/entities/${encodeURIComponent(table.MetadataId)}/business rules/${encodeURIComponent(component.id)}`;
  } else {
    if (!appAction) throw new UserError("Choose e (edit) or r (run) in the app search command.");
    if (appAction === "run") {
      if (component.appType === "model-driven") {
        if (!client.config.org) throw new UserError("The selected environment has no Dataverse URL.");
        url = `${client.config.org.replace(/\/$/, "")}/main.aspx?appid=${encodeURIComponent(component.id)}`;
      } else {
        const appPath = component.appType === "code" ? "app" : "a";
        url = `https://apps.powerapps.com/play/e/${encodeURIComponent(environmentId)}/${appPath}/${encodeURIComponent(component.id)}`;
      }
    } else if (component.appType === "canvas") {
      const appId = encodeURIComponent(`/providers/Microsoft.PowerApps/apps/${component.id}`);
      const scope = solutionId ? `&solution-id=${encodeURIComponent(solutionId)}` : "";
      url = `https://make.powerapps.com/e/${encodeURIComponent(environmentId)}/canvas/?action=edit&app-id=${appId}${scope}`;
    } else if (component.appType === "model-driven") {
      url = `https://make.powerapps.com/e/${encodeURIComponent(environmentId)}/s/${encodeURIComponent(solutionId!)}/app/edit/${encodeURIComponent(component.id)}`;
    } else {
      throw new UserError("Code apps are edited from their local source. Lantern cannot locate that source from Dataverse.");
    }
  }
  await openEnvironmentUrl(client, url);
}
