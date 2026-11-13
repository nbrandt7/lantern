import * as crypto from "crypto";
import * as http from "http";

/**
 * Lantern's MCP server: the Streamable HTTP transport of the Model Context
 * Protocol, plain JSON responses (no event streams), tools only. It runs in the
 * extension host so tools use Lantern's sign-in and selected tenant.
 *
 * It only listens on 127.0.0.1, answers only requests for its own host name
 * (so a web page can't reach it through DNS rebinding), refuses browser origins,
 * and needs the bearer token from Lantern's AI Tools setup.
 */

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  /** False for tools that change something; clients use it to decide what to ask before running. */
  readOnly?: boolean;
  invoke(input: Record<string, unknown>): Promise<string>;
}

export interface McpServerOptions {
  port: number;
  token: string;
  version: string;
  tools: () => McpTool[];
  log?: (line: string) => void;
}

export type StartResult = { state: "listening" } | { state: "taken"; byLantern: boolean } | { state: "failed"; message: string };

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1_000_000;

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const INSTRUCTIONS =
  "Lantern reads from the Dataverse / Dynamics 365 environment selected in Lantern in VS Code. " +
  "To find Power Automate flows by what they do, call lantern_search_flows with uses (email, teams, approval, http, sharepoint, childflow, dataverse-write, or any text); " +
  "then lantern_explain_flow with a flow ID to outline it before explaining it. " +
  "When someone asks why a field behaves a certain way (gets a value, changes, is required, hidden, locked), start with lantern_trace_column, " +
  "then outline what looks responsible with lantern_explain_flow, lantern_explain_plugin or lantern_explain_web_resource. " +
  "When someone pastes a user story or spec for a plug-in, extract every table and column it reads or writes and call lantern_generate_csharp_classes; " +
  "it queues them for review in VS Code unless they asked for the files to be written now (generate: true). " +
  "lantern_tenants shows which environment is selected.";

export class LanternMcpServer {
  private server?: http.Server;
  calls = 0;
  lastCall?: Date;

  constructor(private readonly options: McpServerOptions) {}

  get port(): number {
    return this.options.port;
  }

  /** What clients must send as "Authorization: Bearer <token>". */
  get token(): string {
    return this.options.token;
  }

  get listening(): boolean {
    return !!this.server?.listening;
  }

  start(): Promise<StartResult> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.options.log?.(`MCP request failed: ${err instanceof Error ? err.message : String(err)}\n`);
          if (!res.headersSent) res.writeHead(500).end();
        });
      });
      server.once("error", async (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") resolve({ state: "taken", byLantern: await isLantern(this.options.port) });
        else resolve({ state: "failed", message: err.message });
      });
      server.listen(this.options.port, "127.0.0.1", () => {
        this.server = server;
        resolve({ state: "listening" });
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = this.options.port;
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/health" && req.method === "GET") {
      json(res, 200, { lantern: true });
      return;
    }
    if (url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (!sameSecret(req.headers.authorization ?? "", `Bearer ${this.options.token}`)) {
      json(res, 401, { error: "Lantern's MCP token is missing or out of date. Run Set Up again from Lantern's AI Tools tab." });
      return;
    }
    if (req.method === "GET") {
      // No server-initiated messages, so no event stream.
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    const body = await readBody(req);
    if (body === undefined) {
      res.writeHead(413).end();
      return;
    }
    let parsed: RpcMessage | RpcMessage[];
    try {
      parsed = JSON.parse(body);
    } catch {
      json(res, 400, rpcError(null, -32700, "Parse error"));
      return;
    }
    if (Array.isArray(parsed) && !parsed.length) {
      json(res, 200, rpcError(null, -32600, "Invalid Request"));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const replies = (await Promise.all(messages.map((m) => this.dispatch(m)))).filter((r): r is Record<string, unknown> => !!r);
    if (!replies.length) {
      res.writeHead(202).end();
      return;
    }
    json(res, 200, Array.isArray(parsed) ? replies : replies[0]);
  }

  /** The reply to one message; undefined for notifications and responses. */
  async dispatch(m: RpcMessage): Promise<Record<string, unknown> | undefined> {
    if (!m || typeof m !== "object" || Array.isArray(m)) return rpcError(null, -32600, "Invalid Request");
    if (typeof m.method !== "string") {
      // A response (to a request this server never sends) needs no answer; anything else isn't JSON-RPC.
      if (m.id !== undefined && ("result" in m || "error" in m)) return undefined;
      return rpcError(typeof m.id === "string" || typeof m.id === "number" ? m.id : null, -32600, "Invalid Request");
    }
    if (m.id === undefined || m.id === null) return undefined;
    const id = m.id;
    switch (m.method) {
      case "initialize": {
        const asked = String(m.params?.protocolVersion ?? "");
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lantern", title: "Lantern (Dataverse)", version: this.options.version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, {
          tools: this.options.tools().map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: t.inputSchema,
            // The writing tools only add (never delete or overwrite what's there), so they aren't destructive.
            annotations: t.readOnly === false ? { readOnlyHint: false, destructiveHint: false, openWorldHint: true } : { readOnlyHint: true, openWorldHint: true },
          })),
        });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const tool = this.options.tools().find((t) => t.name === name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
        this.calls++;
        this.lastCall = new Date();
        this.options.log?.(`MCP tool call: ${name}\n`);
        const args = m.params?.arguments && typeof m.params.arguments === "object" ? (m.params.arguments as Record<string, unknown>) : {};
        try {
          return result(id, { content: [{ type: "text", text: await tool.invoke(args) }], isError: false });
        } catch (err) {
          return result(id, { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${m.method}`);
    }
  }
}

const result = (id: string | number, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Whether the server already on this port is another VS Code window's Lantern. */
export function isLantern(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1500 }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(text).lantern === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}
