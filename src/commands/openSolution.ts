import { Client } from "../core/clients";
import { makerEnvironmentId, openEnvironmentUrl } from "../ui/environmentBrowser";

/** Open a Dataverse solution in the Power Apps maker portal. */
export async function openSolution(client: Client, solutionId: string): Promise<void> {
  const environmentId = await makerEnvironmentId(client);
  const url = `https://make.powerapps.com/environments/${encodeURIComponent(environmentId)}/solutions/${encodeURIComponent(solutionId)}`;
  await openEnvironmentUrl(client, url);
}
