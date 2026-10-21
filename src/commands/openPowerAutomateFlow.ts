import { Client } from "../core/clients";
import { makerEnvironmentId, openEnvironmentUrl } from "../ui/environmentBrowser";

/** Resolve the current Dataverse environment ID and open its cloud flow editor. */
export async function openPowerAutomateFlow(client: Client, flowId: string, solutionId?: string): Promise<void> {
  const environmentId = await makerEnvironmentId(client);
  const solution = solutionId ? `/solutions/${encodeURIComponent(solutionId)}` : "";
  const url = `https://make.powerautomate.com/environments/${encodeURIComponent(environmentId)}${solution}/flows/${encodeURIComponent(flowId)}?v3=true`;
  await openEnvironmentUrl(client, url);
}
