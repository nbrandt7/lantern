/**
 * The environments a person can open, from the Global Discovery Service, so
 * adding an environment is a pick from a list instead of typing an org URL. Also
 * suggests a name (DEV, TEST, ...) from what an org is called.
 */

export interface DiscoveredEnvironment {
  friendlyName: string;
  uniqueName: string;
  urlName: string;
  /** The org URL, https://contoso-test.crm.dynamics.com */
  url: string;
  region: string;
  version: string;
  /** 0 is enabled. */
  state: number;
}

/** The discovery service for the cloud an org is in (commercial, GCC, GCC High, DoD, China). */
export function discoveryHost(org: string): string {
  let host = "";
  try {
    host = new URL(org).host.toLowerCase();
  } catch {
    // not a URL: commercial
  }
  if (host.endsWith(".crm9.dynamics.com")) return "https://globaldisco.crm9.dynamics.com";
  if (host.endsWith(".microsoftdynamics.us")) return "https://globaldisco.crm.microsoftdynamics.us";
  if (host.endsWith(".appsplatform.us")) return "https://globaldisco.crm.appsplatform.us";
  if (host.endsWith(".dynamics.cn")) return "https://globaldisco.crm.dynamics.cn";
  return "https://globaldisco.crm.dynamics.com";
}

/** Every environment the token's account can open, enabled ones first, by name. */
export async function discoverEnvironments(host: string, token: string): Promise<DiscoveredEnvironment[]> {
  const response = await fetch(`${host}/api/discovery/v2.0/Instances`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) throw new Error(`The discovery service answered ${response.status}.`);
  const body = (await response.json()) as { value?: Array<Record<string, unknown>> };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return (body.value ?? [])
    .map((i) => ({
      friendlyName: str(i.FriendlyName) || str(i.UniqueName),
      uniqueName: str(i.UniqueName),
      urlName: str(i.UrlName),
      url: str(i.Url).replace(/\/+$/, ""),
      region: str(i.Region),
      version: str(i.Version),
      state: typeof i.State === "number" ? i.State : 0,
    }))
    .filter((e) => e.url)
    .sort((a, b) => Number(a.state !== 0) - Number(b.state !== 0) || a.friendlyName.localeCompare(b.friendlyName));
}

export const COMMON_ENVIRONMENT_NAMES = ["DEV", "TEST", "UAT", "QA", "STAGING", "TRAINING", "SANDBOX", "PROD"];

/**
 * DEV, TEST, ... when an org's names say so: "contosodev", "Contoso (UAT)",
 * "contoso-prd". Undefined when nothing does; a bare name could be anything.
 */
export function suggestEnvironmentName(...names: string[]): string | undefined {
  const text = names.join(" ").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    // PROD first, since the others match inside words ("Valuation (Production)", "Fabrikam Live" at fabrikamdevices):
    // a production org named DEV starts unprotected, while a wrong PROD only adds a confirmation.
    // "live" as the start or end of a word, so "Delivery" isn't production.
    [/prod|prd|(^|[^a-z])live|live([^a-z]|$)/, "PROD"],
    [/uat/, "UAT"],
    [/(^|[^a-z])qa([^a-z]|$)/, "QA"],
    [/stag(e|ing)/, "STAGING"],
    [/train/, "TRAINING"],
    [/sandbox|sbx/, "SANDBOX"],
    [/test|tst/, "TEST"],
    [/dev/, "DEV"],
  ];
  return rules.find(([re]) => re.test(text))?.[1];
}
