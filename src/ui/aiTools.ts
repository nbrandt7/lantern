import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DISCOVERY_FILE } from "../mcp/bridge";
import { LanternMcpServer, McpTool } from "../mcp/server";
import { UserError } from "../core/errors";
import { run } from "../core/process";
import { reportError, write } from "./context";

/**
 * AI Tools: Lantern's tools for Claude Code, Codex and Copilot. Copilot gets them
 * straight from VS Code; Claude Code and Codex (CLI and VS Code extensions alike)
 * connect to a small MCP server Lantern runs on 127.0.0.1 while VS Code is open.
 * Claude Code talks to it over HTTP with a bearer token; Codex starts
 * ~/.lantern/lantern-mcp.js, which forwards to it.
 */

type AssistantId = "claude" | "codex" | "copilot";

type ServerState =
  | { kind: "off" }
  | { kind: "running"; port: number }
  | { kind: "elsewhere"; port: number }
  | { kind: "blocked"; port: number; message: string };

interface AssistantStatus {
  state: "ready" | "setup" | "update" | "missing";
  text: string;
  configured: boolean;
}

const TOKEN_KEY = "lantern.mcp.token";
const LANTERN_HOME = path.dirname(DISCOVERY_FILE);
const BRIDGE_COPY = path.join(LANTERN_HOME, "lantern-mcp.js");
const SERVER_NAME = "lantern";

const ASSISTANTS: Array<{ id: AssistantId; name: string; tagline: string; logo: string }> = [
  { id: "claude", name: "Claude Code", tagline: "CLI and VS Code extension", logo: "claude.svg" },
  { id: "codex", name: "Codex", tagline: "CLI and VS Code extension", logo: "codex.svg" },
  { id: "copilot", name: "GitHub Copilot", tagline: "Copilot Chat in VS Code", logo: "copilot.svg" },
];

const claudeConfigFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
const codexConfigFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");

/** A JSON object from a file (a BOM is fine); undefined when there's no file or it isn't one. */
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes to a temp file first, so a reader never sees half a file. The temp file
 * gets the old file's permissions (0600 for a new one): ~/.claude.json and
 * config.toml hold the token, and the rename would otherwise loosen them.
 */
function writeAtomic(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let keep = mode;
  if (keep === undefined) {
    try {
      keep = fs.statSync(file).mode & 0o777;
    } catch {
      keep = 0o600;
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: keep });
  // The mode above only applies when the file is created, and the umask still trims it.
  fs.chmodSync(tmp, keep);
  fs.renameSync(tmp, file);
}

/** A TOML string: literal ('...') when it can be, so Windows paths need no escaping. */
const tomlString = (s: string) => (!s.includes("'") && !/[\r\n]/.test(s) ? `'${s}'` : JSON.stringify(s));

/** config.toml without Lantern's [mcp_servers.lantern] table (and its subtables). */
export function withoutCodexServer(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    // [[array.of.tables]] starts a section too, which ends Lantern's.
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line)?.[1];
    if (header !== undefined) skipping = /^mcp_servers\.("?)lantern\1(\.|$)/.test(header);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

export function codexServerToml(command: string, bridge: string): string {
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(command)}`, `args = [${tomlString(bridge)}]`, `env = { ELECTRON_RUN_AS_NODE = "1" }`].join("\n");
}

export class AiTools implements vscode.Disposable {
  private server?: LanternMcpServer;
  private serverState: ServerState = { kind: "off" };
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly tools: () => McpTool[]) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("lantern.mcp")) this.applySettings().catch(reportError);
      })
    );
  }

  private cfg() {
    const c = vscode.workspace.getConfiguration("lantern");
    return { enabled: c.get<boolean>("mcp.enabled", false), port: c.get<number>("mcp.port", 39847) };
  }

  private get url(): string {
    return `http://127.0.0.1:${this.cfg().port}/mcp`;
  }

  /**
   * Starts or stops the server to match the lantern.mcp settings. Runs one at a
   * time: Set Up changes the setting (which calls this) and then calls it too, and
   * two starts at once would race for the port and the token.
   */
  applySettings(restart = false): Promise<void> {
    const next = this.applying.then(async () => {
      const { enabled, port } = this.cfg();
      if (this.server && (restart || !enabled || this.server.port !== port)) await this.stopServer();
      if (enabled && !this.server?.listening) await this.startServer();
      if (!enabled) this.serverState = { kind: "off" };
      await this.refresh();
    });
    this.applying = next.catch(() => undefined);
    return next;
  }
  private applying: Promise<void> = Promise.resolve();

  /** The stored token, made once; every caller shares the same pending lookup. */
  private token(): Promise<string> {
    this.tokenLookup ??= (async () => {
      let t = await this.context.secrets.get(TOKEN_KEY);
      if (!t) {
        t = crypto.randomBytes(32).toString("base64url");
        await this.context.secrets.store(TOKEN_KEY, t);
      }
      return t;
    })();
    return this.tokenLookup;
  }
  private tokenLookup?: Promise<string>;

  /**
   * The token clients must send: the one the server answering on the port checks.
   * That's this window's server, or (when another VS Code window holds the port)
   * the one that window wrote to ~/.lantern/mcp.json.
   */
  private async liveToken(): Promise<string> {
    if (this.server) return this.server.token;
    if (this.serverState.kind === "elsewhere") {
      const d = readJson(DISCOVERY_FILE);
      if (d?.port === this.cfg().port && typeof d.token === "string") return d.token;
    }
    return this.token();
  }

  private async startServer(): Promise<void> {
    const { port } = this.cfg();
    const token = await this.token();
    const server = new LanternMcpServer({ port, token, version: String(this.context.extension.packageJSON.version ?? "0"), tools: this.tools, log: write });
    const r = await server.start();
    if (r.state === "listening") {
      this.server = server;
      this.serverState = { kind: "running", port };
      this.installBridge();
      writeAtomic(DISCOVERY_FILE, JSON.stringify({ port, token, pid: process.pid }, null, 2), 0o600);
      write(`Lantern MCP server listening on http://127.0.0.1:${port}/mcp\n`);
    } else if (r.state === "taken") {
      this.serverState = r.byLantern
        ? { kind: "elsewhere", port }
        : { kind: "blocked", port, message: `Port ${port} is used by another program. Change lantern.mcp.port.` };
    } else {
      this.serverState = { kind: "blocked", port, message: r.message };
    }
  }

  private async stopServer(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
    this.serverState = { kind: "off" };
    try {
      if (readJson(DISCOVERY_FILE)?.pid === process.pid) fs.rmSync(DISCOVERY_FILE, { force: true });
    } catch {
      // another window's file, or already gone
    }
  }

  private async enable(): Promise<void> {
    if (!this.cfg().enabled) await vscode.workspace.getConfiguration("lantern").update("mcp.enabled", true, vscode.ConfigurationTarget.Global);
    await this.applySettings();
  }

  /** Keeps ~/.lantern/lantern-mcp.js (what Codex runs) the same as this version's bridge. */
  private installBridge(): void {
    try {
      const source = fs.readFileSync(path.join(this.context.extensionPath, "out", "mcp", "bridge.js"));
      if (fs.existsSync(BRIDGE_COPY) && fs.readFileSync(BRIDGE_COPY).equals(source)) return;
      writeAtomic(BRIDGE_COPY, source.toString("utf8"));
    } catch (err) {
      write(`Couldn't copy the MCP launcher to ${BRIDGE_COPY}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // ---------- assistants ----------

  private async status(id: AssistantId): Promise<AssistantStatus> {
    if (id === "copilot") {
      const installed = !!vscode.extensions.getExtension("GitHub.copilot-chat");
      return installed
        ? { state: "ready", configured: true, text: `Built in: agent mode in Copilot Chat has Lantern's ${this.tools().length} tools. No server needed.` }
        : { state: "missing", configured: false, text: "Copilot Chat isn't installed in this VS Code." };
    }
    const serverNote = this.serverState.kind === "off" ? " Turn the server on so it can connect." : "";
    if (id === "claude") {
      const entry = (readJson(claudeConfigFile())?.mcpServers as Record<string, { url?: string; headers?: Record<string, string> }> | undefined)?.[SERVER_NAME];
      if (!entry) return { state: "setup", configured: false, text: "Not set up yet." };
      const current = entry.url === this.url && entry.headers?.Authorization === `Bearer ${await this.liveToken()}`;
      return current
        ? { state: "ready", configured: true, text: `Set up for every project. New Claude Code sessions have Lantern's tools.${serverNote}` }
        : { state: "update", configured: true, text: "Set up with an old address or token. Set Up again to update it." };
    }
    let toml = "";
    try {
      toml = fs.readFileSync(codexConfigFile(), "utf8");
    } catch {
      // no config yet
    }
    if (!/^\s*\[\s*mcp_servers\.("?)lantern\1\s*\]/m.test(toml)) return { state: "setup", configured: false, text: "Not set up yet." };
    return toml.includes(codexServerToml(process.execPath, BRIDGE_COPY))
      ? { state: "ready", configured: true, text: `Set up in ${codexConfigFile()}. New Codex sessions have Lantern's tools.${serverNote}` }
      : { state: "update", configured: true, text: "Set up with an older launcher. Set Up again to update it." };
  }

  private async configText(id: AssistantId): Promise<string> {
    if (id === "claude") return `claude mcp add --transport http --scope user ${SERVER_NAME} ${this.url} --header "Authorization: Bearer ${await this.liveToken()}"`;
    if (id === "codex") return codexServerToml(process.execPath, BRIDGE_COPY);
    return "";
  }

  private async setup(id: AssistantId): Promise<string> {
    if (id === "copilot") {
      if (!vscode.extensions.getExtension("GitHub.copilot-chat")) {
        await vscode.commands.executeCommand("workbench.extensions.search", "@id:GitHub.copilot-chat");
        return "Install GitHub Copilot Chat, then Lantern's tools show up in agent mode.";
      }
      await vscode.commands.executeCommand("workbench.action.chat.open", { query: "Using #lanternFlows, which flows send email?", mode: "agent" });
      return "Opened Copilot Chat. In agent mode, Lantern's tools are in the tools list.";
    }
    await this.enable();
    const token = await this.liveToken();
    if (id === "claude") {
      const viaCli = await run("claude", ["--version"]);
      if (!viaCli.missing && viaCli.code === 0) {
        await run("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
        const r = await run("claude", ["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, this.url, "--header", `Authorization: Bearer ${token}`]);
        if (r.code === 0) return "Claude Code is set up. Start a new Claude Code session (or run /mcp) to use Lantern's tools.";
        write(`claude mcp add failed: ${r.stderr || r.stdout}\n`);
      }
      // No claude on PATH (the VS Code extension carries its own): add the server to ~/.claude.json directly.
      const file = claudeConfigFile();
      const data = readJson(file) ?? (fs.existsSync(file) ? undefined : {});
      // Claude Code keeps its sign-in, projects and other servers in this file: never replace one Lantern can't read.
      if (!data) throw new UserError(`Lantern couldn't read ${file} as JSON, so it left the file alone. Fix the file, or use Copy Config and run the command it copies.`);
      if (fs.existsSync(file) && !fs.existsSync(`${file}.lantern-backup`)) fs.copyFileSync(file, `${file}.lantern-backup`);
      const servers = (data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {}) as Record<string, unknown>;
      servers[SERVER_NAME] = { type: "http", url: this.url, headers: { Authorization: `Bearer ${token}` } };
      data.mcpServers = servers;
      writeAtomic(file, JSON.stringify(data, null, 2));
      return "Claude Code is set up. Start a new Claude Code session (or run /mcp) to use Lantern's tools.";
    }
    const file = codexConfigFile();
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current && !fs.existsSync(`${file}.lantern-backup`)) fs.copyFileSync(file, `${file}.lantern-backup`);
    const rest = withoutCodexServer(current);
    writeAtomic(file, `${rest ? `${rest}\n\n` : ""}${codexServerToml(process.execPath, BRIDGE_COPY)}\n`);
    return "Codex is set up. Start a new Codex session to use Lantern's tools.";
  }

  private async remove(id: AssistantId): Promise<string> {
    if (id === "claude") {
      const r = await run("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
      const file = claudeConfigFile();
      const data = readJson(file);
      const servers = data?.mcpServers as Record<string, unknown> | undefined;
      if (data && servers?.[SERVER_NAME]) {
        delete servers[SERVER_NAME];
        writeAtomic(file, JSON.stringify(data, null, 2));
      } else if (r.code !== 0 && !data) {
        return "Claude Code didn't have Lantern set up.";
      }
      return "Removed Lantern from Claude Code.";
    }
    if (id === "codex") {
      const file = codexConfigFile();
      if (!fs.existsSync(file)) return "Codex didn't have Lantern set up.";
      const rest = withoutCodexServer(fs.readFileSync(file, "utf8"));
      writeAtomic(file, rest ? `${rest}\n` : "");
      return "Removed Lantern from Codex.";
    }
    return "";
  }

  // ---------- the tab ----------

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      this.refresh().catch(reportError);
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel("lantern.aiTools", "AI Tools", vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
    panel.iconPath = vscode.Uri.joinPath(media, "lantern.svg");
    this.panel = panel;
    panel.onDidDispose(() => (this.panel = undefined), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((m: { type: string; id?: AssistantId }) => void this.onMessage(m), undefined, this.disposables);
    panel.webview.html = this.html(panel.webview);
    this.refresh().catch(reportError);
  }

  private async onMessage(m: { type: string; id?: AssistantId }): Promise<void> {
    try {
      let note: string | undefined;
      if (m.type === "setup" && m.id) note = await this.setup(m.id);
      else if (m.type === "remove" && m.id) {
        const name = ASSISTANTS.find((a) => a.id === m.id)?.name;
        const go = "Remove";
        if ((await vscode.window.showWarningMessage(`Remove Lantern's tools from ${name}?`, { modal: true }, go)) !== go) return;
        note = await this.remove(m.id);
      } else if (m.type === "copy" && m.id) {
        await vscode.env.clipboard.writeText(await this.configText(m.id));
        note = m.id === "claude" ? "Copied the claude mcp add command. It includes the token: keep it private." : "Copied the config.toml entry.";
      } else if (m.type === "server") {
        await vscode.workspace.getConfiguration("lantern").update("mcp.enabled", !this.cfg().enabled, vscode.ConfigurationTarget.Global);
        return;
      } else if (m.type === "token") {
        const go = "New Token";
        if ((await vscode.window.showWarningMessage("Make a new token? Claude Code needs Set Up again afterwards; Codex picks it up by itself.", { modal: true }, go)) !== go) return;
        const fresh = crypto.randomBytes(32).toString("base64url");
        await this.context.secrets.store(TOKEN_KEY, fresh);
        this.tokenLookup = Promise.resolve(fresh);
        // Restart inside the same queue as every other start, so the server and the files get the new token together.
        await this.applySettings(true);
        note = "Made a new token. Run Set Up again for Claude Code.";
      } else if (m.type === "settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "lantern.mcp");
        return;
      }
      await this.refresh(note);
    } catch (err) {
      reportError(err);
      // Logged, not shown: a refresh failing the same way would show the same error twice.
      await this.refresh().catch((e) => write(`Couldn't refresh the AI Tools tab: ${e instanceof Error ? e.message : String(e)}\n`));
    }
  }

  private async refresh(note?: string): Promise<void> {
    if (!this.panel) return;
    const s = this.serverState;
    const server =
      s.kind === "running" ? { on: true, tone: "ok", text: `Running on 127.0.0.1:${s.port}${this.server?.calls ? ` · ${this.server.calls} tool call${this.server.calls === 1 ? "" : "s"}` : ""}` } :
      s.kind === "elsewhere" ? { on: true, tone: "ok", text: `Another VS Code window is serving Lantern's tools on port ${s.port}.` } :
      s.kind === "blocked" ? { on: true, tone: "error", text: s.message } :
      { on: false, tone: "off", text: "Off. Setting up Claude Code or Codex turns it on." };
    const assistants = await Promise.all(ASSISTANTS.map(async (a) => ({ id: a.id, name: a.name, tagline: a.tagline, ...(await this.status(a.id)) })));
    await this.panel.webview.postMessage({ type: "state", server, assistants, tools: this.tools().map((t) => ({ name: t.name, title: t.title ?? t.name, description: t.description.split(/(?<=\.)\s/)[0] })), note });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const logo = (file: string) => {
      try {
        return fs.readFileSync(path.join(this.context.extensionPath, "media", "ai", file), "utf8").replace(/<title>[^<]*<\/title>/, "").replace("<svg ", '<svg aria-hidden="true" ');
      } catch {
        return "";
      }
    };
    const logos = Object.fromEntries(ASSISTANTS.map((a) => [a.id, logo(a.logo)]));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Tools</title>
<style nonce="${nonce}">
  :root {
    --claude: #D97757; --claude-button: #B4532F;
    --codex: var(--vscode-foreground); --codex-button: var(--vscode-foreground); --codex-button-fg: var(--vscode-editor-background);
    --copilot: #8957E5; --copilot-button: #8250DF;
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
    --card: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  body { margin: 0; padding: 28px 32px 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.6em; font-weight: 600; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 22px; max-width: 70ch; line-height: 1.5; }
  .server { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); margin-bottom: 22px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--muted); }
  .dot.ok { background: var(--vscode-testing-iconPassed, #3fb950); }
  .dot.error { background: var(--vscode-errorForeground, #f85149); }
  .server .label { font-weight: 600; }
  .server .text { color: var(--muted); flex: 1; min-width: 200px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 18px 18px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); overflow: hidden; }
  .card::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 4px; background: var(--brand); }
  .card.claude { --brand: var(--claude); --button: var(--claude-button); --button-fg: #fff; }
  .card.codex { --brand: var(--codex); --button: var(--codex-button); --button-fg: var(--codex-button-fg); }
  .card.copilot { --brand: var(--copilot); --button: var(--copilot-button); --button-fg: #fff; }
  .head { display: flex; align-items: center; gap: 12px; }
  .logo { width: 40px; height: 40px; border-radius: 9px; display: grid; place-items: center; flex: none; background: color-mix(in srgb, var(--brand) 14%, transparent); }
  .logo svg { width: 24px; height: 24px; fill: var(--brand); }
  .name { font-size: 1.15em; font-weight: 600; }
  .tagline { color: var(--muted); font-size: .92em; }
  .pill { margin-left: auto; align-self: flex-start; font-size: .8em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .pill.ready { color: var(--vscode-testing-iconPassed, #3fb950); border-color: currentColor; }
  .pill.update { color: var(--vscode-editorWarning-foreground, #d29922); border-color: currentColor; }
  .status { color: var(--muted); line-height: 1.45; flex: 1; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: inherit; border-radius: 6px; padding: 6px 12px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--vscode-foreground); }
  button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button.primary { background: var(--button); color: var(--button-fg); border-color: var(--button); font-weight: 600; }
  button.primary:hover { filter: brightness(1.08); background: var(--button); }
  .note { min-height: 1.4em; margin: 14px 0 0; color: var(--vscode-textLink-foreground); }
  h2 { font-size: 1.05em; font-weight: 600; margin: 30px 0 10px; }
  .tools { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .tools li { display: grid; grid-template-columns: minmax(150px, 220px) 1fr; gap: 12px; padding: 8px 0; border-top: 1px solid var(--border); }
  .tools code { font-family: var(--vscode-editor-font-family); font-size: .92em; }
  .tools span { color: var(--muted); }
  @media (max-width: 560px) { body { padding: 20px 16px; } .tools li { grid-template-columns: 1fr; gap: 2px; } }
</style>
</head>
<body>
<main>
  <h1>AI Tools</h1>
  <p class="lead">Let AI assistants search your flows, explain what they do, describe tables and run read-only queries in the tenant selected in Lantern. They sign in with your Lantern sign-in and never change data.</p>
  <section class="server" aria-label="MCP server">
    <span class="dot" id="dot"></span>
    <span class="label">MCP server</span>
    <span class="text" id="serverText">Loading…</span>
    <button id="serverToggle">Turn On</button>
    <button id="token" title="Make a new token for Claude Code and Codex">New Token</button>
    <button id="settings" title="Port and other settings">Settings</button>
  </section>
  <section class="cards" id="cards" aria-label="Assistants"></section>
  <p class="note" id="note" role="status"></p>
  <h2>Tools they get</h2>
  <ul class="tools" id="tools"></ul>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const logos = ${JSON.stringify(logos)};
  const send = (type, id) => vscode.postMessage({ type, id });
  document.getElementById("serverToggle").addEventListener("click", () => send("server"));
  document.getElementById("token").addEventListener("click", () => send("token"));
  document.getElementById("settings").addEventListener("click", () => send("settings"));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const PILL = { ready: "Ready", setup: "Not set up", update: "Needs update", missing: "Not installed" };
  window.addEventListener("message", ({ data }) => {
    if (data.type !== "state") return;
    document.getElementById("dot").className = "dot " + data.server.tone;
    document.getElementById("serverText").textContent = data.server.text;
    document.getElementById("serverToggle").textContent = data.server.on ? "Turn Off" : "Turn On";
    document.getElementById("note").textContent = data.note || "";
    const cards = document.getElementById("cards");
    cards.replaceChildren(...data.assistants.map((a) => {
      const card = el("article", "card " + a.id);
      const head = el("div", "head");
      const logo = el("div", "logo");
      logo.innerHTML = logos[a.id] || "";
      const names = el("div");
      names.append(el("div", "name", a.name), el("div", "tagline", a.tagline));
      head.append(logo, names, el("span", "pill " + a.state, PILL[a.state]));
      const actions = el("div", "actions");
      const primary = el("button", "primary", a.id === "copilot" ? (a.state === "missing" ? "Install Copilot Chat" : "Open Copilot Chat") : a.state === "ready" ? "Set Up Again" : a.state === "update" ? "Update" : "Set Up");
      primary.addEventListener("click", () => send("setup", a.id));
      actions.append(primary);
      if (a.id !== "copilot") {
        const copy = el("button", "", "Copy Config");
        copy.title = a.id === "claude" ? "Copy the claude mcp add command" : "Copy the config.toml entry";
        copy.addEventListener("click", () => send("copy", a.id));
        actions.append(copy);
      }
      if (a.configured && a.id !== "copilot") {
        const remove = el("button", "", "Remove");
        remove.addEventListener("click", () => send("remove", a.id));
        actions.append(remove);
      }
      card.append(head, el("div", "status", a.text), actions);
      return card;
    }));
    document.getElementById("tools").replaceChildren(...data.tools.map((t) => {
      const li = el("li");
      li.append(el("code", "", t.name), el("span", "", t.description));
      return li;
    }));
  });
</script>
</body>
</html>`;
  }

  dispose(): void {
    void this.stopServer();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
