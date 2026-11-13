/**
 * lantern-mcp: a stdio MCP server that forwards every message to the Lantern MCP
 * server running in VS Code. For assistants that start their MCP servers as
 * processes (Codex, and any client without HTTP support). Node built-ins only:
 * Lantern copies this file to ~/.lantern/lantern-mcp.js and it runs with
 * VS Code's own runtime (ELECTRON_RUN_AS_NODE=1), so nothing else is installed.
 *
 * The port and token come from ~/.lantern/mcp.json, written by Lantern, and are
 * read for every message so a new token or port is picked up without a restart.
 */
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

interface Discovery {
  port: number;
  token: string;
}

export const DISCOVERY_FILE = path.join(os.homedir(), ".lantern", "mcp.json");

function discovery(): Discovery | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(process.env.LANTERN_MCP_FILE || DISCOVERY_FILE, "utf8"));
    return typeof d.port === "number" && typeof d.token === "string" ? d : undefined;
  } catch {
    return undefined;
  }
}

function post(d: Discovery, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: d.port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${d.token}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

const NOT_RUNNING = "Lantern isn't running. Open VS Code with the Lantern extension (its AI Tools server turned on), then try again.";

async function forward(line: string, write: (s: string) => void): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }
  // A batch, or a line that isn't an object at all (null, 5): Lantern answers those itself.
  const id = message && typeof message === "object" && !Array.isArray(message) ? (message as { id?: unknown }).id : undefined;
  const fail = (text: string) => {
    if (id !== undefined && id !== null) write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: text } }));
  };
  const d = discovery();
  if (!d) return fail(NOT_RUNNING);
  try {
    const r = await post(d, line);
    if (r.status === 202 || !r.text) return;
    if (r.status === 401) return fail("Lantern refused the token. Run Set Up for Codex again in Lantern's AI Tools tab.");
    if (r.status >= 400) return fail(`Lantern answered ${r.status}.`);
    write(r.text.replace(/\r?\n/g, " "));
  } catch {
    fail(NOT_RUNNING);
  }
}

export function main(): void {
  const pending = new Set<Promise<void>>();
  const write = (s: string) => process.stdout.write(`${s}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    // One bad line must not end the bridge: the requests after it still need answers.
    const p = forward(line, write)
      .catch((err) => {
        process.stderr.write(`lantern-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  });
  rl.on("close", () => {
    void Promise.all(pending).then(() => process.exit(0));
  });
}

if (require.main === module) main();
