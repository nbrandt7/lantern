import { randomUUID } from "crypto";
import { UserError } from "./errors";
import { logEvent } from "./logger";

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
  text(): Promise<string>;
}

/** The most requests Dataverse accepts in one $batch. */
export const BATCH_LIMIT = 1000;

/** One request inside a $batch. */
export interface BatchItem {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  /** Relative to the Web API root ("accounts(…)") or absolute. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The answer to one request inside a $batch, in the order the items were sent. */
export interface BatchResult {
  status: number;
  ok: boolean;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
  /** Dataverse's message for a failed request, or its HTTP status when there's none. */
  error?: string;
}

const CRLF = "\r\n";

/**
 * The multipart/mixed body of a $batch request: one application/http part per item, with CRLF
 * line endings throughout (Dataverse rejects anything else). No change sets, so one failure
 * doesn't roll back the others and every item gets its own answer.
 */
export function buildBatchBody(items: BatchItem[], boundary: string, base: string): string {
  const parts = items.map((item) => {
    const url = /^https?:\/\//i.test(item.path) ? item.path : base + item.path;
    const lines = [`--${boundary}`, "Content-Type: application/http", "Content-Transfer-Encoding: binary", "", `${item.method} ${url} HTTP/1.1`];
    for (const [name, value] of Object.entries(item.headers ?? {})) lines.push(`${name}: ${value}`);
    if (item.body !== undefined) lines.push("Content-Type: application/json; type=entry", "", JSON.stringify(item.body));
    else lines.push("");
    return lines.join(CRLF);
  });
  return [...parts, `--${boundary}--`, ""].join(CRLF);
}

/** Splits a $batch response into one result per request, change sets flattened in order. */
export function parseBatchResponse(text: string, contentType: string | null): BatchResult[] {
  const body = text.replace(/\r?\n/g, CRLF);
  const boundary = /boundary=("?)([^";\r\n]+)\1/i.exec(contentType ?? "")?.[2] ?? /^--([^\r\n-][^\r\n]*)/m.exec(body)?.[1];
  if (!boundary) throw new UserError("Dataverse answered the batch with something that isn't a batch response.");
  const results: BatchResult[] = [];
  for (const raw of body.split(`--${boundary}`).slice(1)) {
    const part = raw.replace(/^--/, "");
    if (!part.trim()) continue;
    const split = part.indexOf(CRLF + CRLF);
    const partHeaders = split >= 0 ? part.slice(0, split) : part;
    const content = split >= 0 ? part.slice(split + 4) : "";
    const inner = /boundary=("?)([^";\r\n]+)\1/i.exec(partHeaders);
    if (inner) {
      results.push(...parseBatchResponse(content, `multipart/mixed; boundary=${inner[2]}`));
      continue;
    }
    const status = /^\s*HTTP\/1\.1 (\d{3})[ \t]*([^\r\n]*)/.exec(content);
    if (!status) continue;
    const rest = content.slice(status[0].length).replace(/^\r\n/, "");
    const blank = rest.indexOf(CRLF + CRLF);
    const headers: Record<string, string> = {};
    for (const line of (blank >= 0 ? rest.slice(0, blank) : rest).split(CRLF)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const payload = blank >= 0 ? rest.slice(blank + 4).trim() : "";
    const code = Number(status[1]);
    let error: string | undefined;
    if (code >= 300) {
      try {
        error = (JSON.parse(payload) as { error?: { message?: string } }).error?.message;
      } catch {
        // not a JSON error body
      }
      if (!error) error = `HTTP ${code}${status[2].trim() ? ` ${status[2].trim()}` : ""}`;
    }
    results.push({ status: code, ok: code < 300, headers, body: payload, error });
  }
  return results;
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
  /**
   * How many requests Dataverse suggests this environment handles at once, from the x-ms-dop-hint
   * header of the last response. Unknown until a request has been answered.
   */
  recommendedParallelism?: number;
  /** When Dataverse last answered 429, the time (ms since epoch) its Retry-After ends. Callers sending in parallel hold off until then. */
  throttledUntil = 0;

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
  private async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, rawBody = false): Promise<HttpResponse> {
    const url = /^https?:\/\//i.test(path) ? path : this.base + path;
    const endpoint = url.split("?")[0];
    let freshToken = false;
    let throttled = 0;
    for (;;) {
      const started = Date.now();
      let token: string;
      try {
        token = await this.getToken(this.org, freshToken);
      } catch (error) {
        logEvent(`Dataverse ${method} ${endpoint}: authentication failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      let response: HttpResponse;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            ...(body !== undefined && !rawBody ? { "Content-Type": "application/json; charset=utf-8" } : {}),
            ...this.defaultHeaders,
            ...headers,
          },
          body: body === undefined ? undefined : rawBody ? String(body) : JSON.stringify(body),
        });
      } catch (err) {
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        logEvent(`Dataverse ${method} ${endpoint}: network error${cause?.code ? ` (${cause.code})` : ""}`);
        throw new UserError(`Couldn't reach ${new URL(url).host}${cause?.code ? ` (${cause.code})` : ""}. Check the org URL and your network connection.`);
      }
      logEvent(`Dataverse ${method} ${endpoint}: HTTP ${response.status} (${Date.now() - started} ms)`);
      const hint = Number(response.headers.get("x-ms-dop-hint"));
      if (Number.isInteger(hint) && hint > 0) this.recommendedParallelism = hint;
      if (response.ok) return response;
      if (response.status === 401 && !freshToken) {
        freshToken = true;
        continue;
      }
      let askedMs = 0;
      if (response.status === 429 && throttled < 3) {
        const header = response.headers.get("Retry-After") ?? "";
        const seconds = Number(header);
        // Retry-After is seconds, or an HTTP date.
        const untilDate = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : NaN;
        askedMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : untilDate > 0 ? untilDate : 5000 * (throttled + 1);
        // The whole wait counts, so batches starting meanwhile hold off too.
        this.throttledUntil = Math.max(this.throttledUntil, Date.now() + askedMs);
        // Retrying before the wait is over only earns another 429, so a wait past the cap fails now.
        if (askedMs <= timing.maxThrottleWaitMs) {
          throttled++;
          logEvent(`Dataverse 429 for ${method} ${endpoint}: Retry-After ${header || "?"}, waiting ${Math.round(askedMs / 1000)} s`);
          await timing.sleep(askedMs);
          continue;
        }
        logEvent(`Dataverse 429 for ${method} ${endpoint}: Retry-After ${header}, longer than the ${Math.round(timing.maxThrottleWaitMs / 1000)} s Lantern waits`);
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
      if (response.status === 429) {
        const why = askedMs > timing.maxThrottleWaitMs
          ? `asked to wait ${Math.ceil(askedMs / 60_000)} minute${askedMs > 60_000 ? "s" : ""}`
          : "kept throttling after three waits";
        throw new UserError(`Dataverse is throttling requests (429) and ${why}. Try again in a few minutes. ${detail}`.trim());
      }
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

  /**
   * Several requests in one round trip (up to BATCH_LIMIT). Each item gets its own answer, in
   * order, and a failure doesn't stop the others (odata.continue-on-error, no change set).
   * Throttling and a rejected token are handled for the batch as for any request.
   */
  async batch(items: BatchItem[]): Promise<BatchResult[]> {
    if (!items.length) return [];
    if (items.length > BATCH_LIMIT) throw new UserError(`A batch can hold ${BATCH_LIMIT} requests at most, not ${items.length}.`);
    const boundary = `batch_${randomUUID()}`;
    const response = await this.request(
      "POST",
      "$batch",
      buildBatchBody(items, boundary, this.base),
      { "Content-Type": `multipart/mixed; boundary="${boundary}"`, Prefer: "odata.continue-on-error" },
      true
    );
    const results = parseBatchResponse(await response.text(), response.headers.get("Content-Type"));
    // A server that stopped at a failure answers fewer parts; the rest never ran.
    while (results.length < items.length) results.push({ status: 0, ok: false, headers: {}, body: "", error: "Not attempted: an earlier request in the batch failed" });
    return results.slice(0, items.length);
  }

  /** POST to an action (PublishAllXml, ...). */
  async action(name: string, body: Record<string, unknown> = {}): Promise<void> {
    await this.request("POST", name, body);
  }

  /** POST to an action and parse its response (ExportSolution, ImportSolutionAsync, ...). */
  async actionJson<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
    return (await (await this.request("POST", name, body)).json()) as T;
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
