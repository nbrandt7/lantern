import { UserError } from "./errors";

/** A token for the org; fresh=true when the last one was rejected and must not be reused. */
export type TokenProvider = (org: string, fresh?: boolean) => Promise<string>;

/** How long to wait between attempts. Replaced in tests. */
export const timing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), maxThrottleWaitMs: 60_000 };

/** The parts of a fetch Response used here (kept minimal so it type-checks against any @types/node). */
interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface WebResource {
  id: string;
  name: string;
  type: number;
  /** Base64 content. */
  content: string;
}

/** Dataverse Web API client used by every Lantern feature that talks to the org directly. */
export class DataverseClient {
  constructor(
    private readonly org: string,
    private readonly getToken: TokenProvider,
    /** Sent with every request, e.g. MSCRMCallerID to act as another user. */
    private readonly defaultHeaders: Record<string, string> = {}
  ) {}

  /** A client that sends extra headers on every request (the original is unchanged). */
  withHeaders(headers: Record<string, string>): DataverseClient {
    return new DataverseClient(this.org, this.getToken, { ...this.defaultHeaders, ...headers });
  }

  get orgUrl(): string {
    return this.org.replace(/\/+$/, "");
  }

  private get base(): string {
    return `${this.org.replace(/\/+$/, "")}/api/data/v9.2/`;
  }

  /**
   * One Web API call. A rejected token (401) is replaced once with a fresh one; throttling
   * (429, Dataverse's service protection limits) waits as long as Retry-After says, up to
   * three times.
   */
  private async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
    const url = /^https?:\/\//i.test(path) ? path : this.base + path;
    let freshToken = false;
    let throttled = 0;
    for (;;) {
      const token = await this.getToken(this.org, freshToken);
      let response: HttpResponse;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            ...(body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}),
            ...this.defaultHeaders,
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        throw new UserError(`Couldn't reach ${new URL(url).host}${cause?.code ? ` (${cause.code})` : ""}. Check the org URL and your network connection.`);
      }
      if (response.ok) return response;
      if (response.status === 401 && !freshToken) {
        freshToken = true;
        continue;
      }
      if (response.status === 429 && throttled < 3) {
        throttled++;
        const seconds = Number(response.headers.get("Retry-After"));
        await timing.sleep(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000 * throttled, timing.maxThrottleWaitMs));
        continue;
      }
      let detail = "";
      try {
        const json = (await response.json()) as { error?: { message?: string } };
        detail = json.error?.message ?? "";
      } catch {
        // no JSON body
      }
      if (response.status === 401) {
        throw new UserError(`Dataverse rejected the sign-in (401). ${detail || 'Try the other "lantern.authMethod" setting.'}`);
      }
      if (response.status === 429) throw new UserError(`Dataverse is throttling requests (429) and asked to wait too long. Try again in a few minutes. ${detail}`.trim());
      throw new UserError(`Dataverse returned ${response.status} for ${method} ${path.split("?")[0]}. ${detail}`.trim());
    }
  }

  /** GET a Web API path and parse the JSON body. */
  async getJson<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
    return (await (await this.request("GET", path, undefined, headers)).json()) as T;
  }

  /** PATCH an existing row (If-Match: * so it never creates one). */
  async update(path: string, body: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", path, body, { "If-Match": "*" });
  }

  /** POST a new row and return its ID. */
  async create(entitySet: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<string> {
    const r = await this.request("POST", entitySet, body, headers);
    const match = (r.headers.get("OData-EntityId") ?? "").match(/\(([0-9a-f-]{36})\)/i);
    if (!match) throw new UserError(`Created a row in ${entitySet}, but Dataverse didn't return its ID.`);
    return match[1];
  }

  /** DELETE a row. */
  async remove(path: string): Promise<void> {
    await this.request("DELETE", path);
  }

  /** POST to an action (PublishAllXml, ...). */
  async action(name: string, body: Record<string, unknown> = {}): Promise<void> {
    await this.request("POST", name, body);
  }

  /** GET a collection, following @odata.nextLink until every page is read. */
  async getAll<T>(path: string, headers: Record<string, string> = {}): Promise<T[]> {
    const rows: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: { value: T[]; "@odata.nextLink"?: string } = await this.getJson(next, headers);
      rows.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return rows;
  }

  async whoAmI(): Promise<{ UserId: string; OrganizationId: string }> {
    return (await (await this.request("GET", "WhoAmI")).json()) as { UserId: string; OrganizationId: string };
  }

  async findWebResource(name: string): Promise<WebResource | undefined> {
    const filter = encodeURIComponent(`name eq '${name.replace(/'/g, "''")}'`);
    const r = await this.request("GET", `webresourceset?$select=webresourceid,name,webresourcetype,content&$filter=${filter}`);
    const json = (await r.json()) as { value: Array<{ webresourceid: string; name: string; webresourcetype: number; content: string | null }> };
    const row = json.value[0];
    return row ? { id: row.webresourceid, name: row.name, type: row.webresourcetype, content: row.content ?? "" } : undefined;
  }

  async updateWebResource(id: string, contentBase64: string): Promise<void> {
    // If-Match: * makes this an update only, never an accidental create.
    await this.request("PATCH", `webresourceset(${id})`, { content: contentBase64 }, { "If-Match": "*" });
  }

  /** Creates a web resource, adding it to the solution when one is given. Returns its ID. */
  async createWebResource(input: { name: string; displayName: string; type: number; content: string; solution?: string }): Promise<string> {
    const headers: Record<string, string> = {};
    if (input.solution) headers["MSCRM.SolutionUniqueName"] = input.solution;
    const r = await this.request(
      "POST",
      "webresourceset",
      { name: input.name, displayname: input.displayName, webresourcetype: input.type, content: input.content },
      headers
    );
    const entityId = r.headers.get("OData-EntityId") ?? "";
    const match = entityId.match(/\(([0-9a-f-]{36})\)/i);
    if (!match) throw new UserError("Created the web resource, but Dataverse didn't return its ID.");
    return match[1];
  }

  async publishWebResources(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const xml = `<importexportxml><webresources>${ids.map((id) => `<webresource>{${id}}</webresource>`).join("")}</webresources></importexportxml>`;
    await this.request("POST", "PublishXml", { ParameterXml: xml });
  }
}
