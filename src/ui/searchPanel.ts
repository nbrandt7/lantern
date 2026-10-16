import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { parseSearchCommand } from "../core/commandParser";
import { searchPowerAutomateFlows } from "../core/dataverseSearch";
import { Client } from "../core/clients";
import { openPowerAutomateFlow } from "../commands/openPowerAutomateFlow";
import { dataverseFor } from "./auth";
import { reportError, write } from "./context";
import { activeTenant } from "./tenantContext";
import { logEvent } from "../core/logger";

interface SearchPanelRow {
  index: number;
  flowId: string;
  name: string;
  client: string;
  environment: string;
  solutions: string[];
  state: number;
}

let panel: vscode.WebviewPanel | undefined;
let latestRows: SearchPanelRow[] = [];
let latestClient: Client | undefined;
let searchGeneration = 0;

export function showSearchPanel(): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const current = vscode.window.createWebviewPanel(
    "lantern.search",
    "Lantern Search",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel = current;
  latestRows = [];
  latestClient = undefined;
  current.webview.html = renderSearchHtml(current.webview);

  const messageSubscription = current.webview.onDidReceiveMessage(async (message: { type?: string; input?: unknown; index?: unknown }) => {
    if (message.type === "openHelp") {
      await vscode.env.openExternal(vscode.Uri.parse("https://github.com/nbrandt7/lantern"));
      return;
    }
    if (message.type === "select" && Number.isInteger(message.index)) {
      const selected = latestRows.find((row) => row.index === message.index);
      const client = latestClient;
      if (!selected || !client) return;
      try {
        await openPowerAutomateFlow(client, selected.flowId);
        current.dispose();
      }
      catch (error) { reportError(error); }
      return;
    }
    if (message.type !== "search" || typeof message.input !== "string") return;

    const generation = ++searchGeneration;
    latestRows = [];
    latestClient = undefined;
    const parsed = parseSearchCommand(message.input);
    if (!("command" in parsed)) {
      logEvent(`Search command rejected: ${parsed.error}`);
      await current.webview.postMessage({ type: "error", message: parsed.error });
      return;
    }

    const started = Date.now();
    logEvent(`Search started: scope=${parsed.command.scope}${parsed.command.scope === "solution" ? ` solution=${parsed.command.solutionUniqueName}` : ""} query=${JSON.stringify(parsed.command.query)}`);
    await current.webview.postMessage({ type: "loading" });
    try {
      const tenant = activeTenant();
      if (!tenant) throw new Error("Select a tenant in Lantern before searching.");
      const results = await searchPowerAutomateFlows(
        tenant,
        parsed.command.query,
        dataverseFor(tenant),
        parsed.command.scope === "solution" ? parsed.command.solutionUniqueName : undefined
      );
      if (panel !== current || generation !== searchGeneration) return;
      const rows: SearchPanelRow[] = results.map(({ client, flow, solutions }, index) => ({
        index: index + 1,
        flowId: flow.id,
        name: flow.name,
        client: client.name,
        environment: client.orgHost || client.config.org || "Unknown environment",
        solutions,
        state: flow.state,
      }));
      latestRows = rows;
      latestClient = tenant.envName ? tenant.withEnvironment(tenant.envName) : tenant;
      logEvent(`Search completed: ${rows.length} flow(s) in ${Date.now() - started} ms`);
      await current.webview.postMessage({
        type: "results",
        rows,
      });
    } catch (error) {
      if (panel !== current || generation !== searchGeneration) return;
      write(`Search failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      await current.webview.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });

  current.onDidDispose(() => {
    messageSubscription.dispose();
    if (panel === current) panel = undefined;
  });
}

function renderSearchHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lantern Search</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .scrim {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 28px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
    }
    .dialog {
      width: min(1060px, 100%);
      max-height: min(780px, calc(100vh - 56px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
      border-radius: 8px;
      box-shadow: 0 16px 48px var(--vscode-widget-shadow, rgba(0, 0, 0, .35));
    }
    .help {
      display: grid;
      place-items: center;
      flex: 0 0 36px;
      height: 36px;
      color: var(--vscode-icon-foreground);
      border-radius: 4px;
      text-decoration: none;
    }
    .help:hover { background: var(--vscode-toolbar-hoverBackground); }
    .help svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; }
    .search-form { display: flex; align-items: center; gap: 8px; padding: 24px; }
    .query {
      flex: 1;
      min-width: 0;
      height: 36px;
      padding: 0 11px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      font: inherit;
      outline: none;
    }
    .query:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
    .submit {
      padding: 0 14px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 4px;
      font: inherit;
      cursor: pointer;
    }
    .submit:hover { background: var(--vscode-button-hoverBackground); }
    .submit:focus-visible, .help:focus-visible, .result:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .results-wrap { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent)); }
    .grid { display: grid; grid-template-columns: 62px minmax(220px, 1fr) minmax(240px, 1.25fr); align-items: center; }
    .columns {
      position: sticky;
      top: 0;
      z-index: 1;
      min-height: 36px;
      padding: 0 18px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .rows { padding: 5px 8px; }
    .result {
      width: 100%;
      min-height: 54px;
      padding: 8px 10px;
      color: var(--vscode-foreground);
      background: transparent;
      border: 0;
      border-radius: 4px;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .result:hover { background: var(--vscode-list-hoverBackground); }
    .result.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
    .number { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .flow-name { min-width: 0; overflow-wrap: anywhere; font-weight: 500; }
    .flow-meta { display: block; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .solutions { display: flex; flex-wrap: wrap; gap: 5px; }
    .solution {
      max-width: 100%;
      overflow: hidden;
      padding: 2px 7px;
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      background: var(--vscode-badge-background, var(--vscode-input-background));
      border-radius: 10px;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state { display: inline-block; width: 7px; height: 7px; margin-right: 6px; background: var(--vscode-testing-iconPassed, #73c991); border-radius: 50%; vertical-align: 1px; }
    .state.off { background: var(--vscode-descriptionForeground); }
    .empty { padding: 28px 20px; color: var(--vscode-descriptionForeground); text-align: center; }
    @media (max-width: 680px) {
      .scrim { padding: 12px; }
      .dialog { max-height: calc(100vh - 24px); }
      .search-form { padding: 16px; }
      .grid { grid-template-columns: 38px minmax(140px, 1fr) minmax(120px, .9fr); }
      .columns { padding: 0 12px; }
      .result { padding: 8px 5px; }
    }
  </style>
</head>
<body>
  <main class="scrim">
    <section class="dialog" role="region" aria-label="Lantern Search">
      <form class="search-form" id="searchForm">
        <input class="query" id="query" type="search" spellcheck="false" autocomplete="off" autofocus aria-label="Search command">
        <button class="submit" type="submit">Search</button>
        <a class="help" id="help" href="https://github.com/nbrandt7/lantern" title="Search commands on GitHub" aria-label="Search commands on GitHub"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"></circle><path d="M10 9v5M10 6v1"></path></svg></a>
      </form>
      <section class="results-wrap" id="resultsWrap" aria-label="Search results" hidden>
        <div class="columns grid" aria-hidden="true"><span>#</span><span>Name</span><span>Solutions</span></div>
        <div class="rows" id="rows" role="listbox" aria-label="Power Automate flows"></div>
      </section>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('searchForm');
    const queryInput = document.getElementById('query');
    const resultsWrap = document.getElementById('resultsWrap');
    const rowsContainer = document.getElementById('rows');
    let resultIndexes = [];
    let numberBuffer = '';
    let numberTimer;

    document.getElementById('help').addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'openHelp' });
    });
    document.addEventListener('keydown', (event) => {
      if (!/^\\d$/.test(event.key) || resultsWrap.hidden || document.activeElement === queryInput || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      clearTimeout(numberTimer);
      numberBuffer += event.key;
      const matches = resultIndexes.filter((index) => String(index).startsWith(numberBuffer));
      if (!matches.length) { numberBuffer = ''; return; }
      const index = Number(numberBuffer);
      if (matches.length === 1 && matches[0] === index) {
        vscode.postMessage({ type: 'select', index });
        numberBuffer = '';
      } else {
        numberTimer = setTimeout(() => {
          if (resultIndexes.includes(index)) vscode.postMessage({ type: 'select', index });
          numberBuffer = '';
        }, 550);
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      resultIndexes = [];
      numberBuffer = '';
      clearTimeout(numberTimer);
      vscode.postMessage({ type: 'search', input: queryInput.value });
    });

    function textCell(className, text) {
      const element = document.createElement('span');
      element.className = className;
      element.textContent = text;
      return element;
    }

    function renderRows(data) {
      rowsContainer.replaceChildren();
      resultIndexes = data.rows.map((row) => row.index);
      for (const row of data.rows) {
        const button = document.createElement('button');
        button.className = 'result grid';
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('aria-label', row.index + '. ' + row.name + (row.solutions.length ? ', solutions: ' + row.solutions.join(', ') : ''));
        button.append(textCell('number', String(row.index)));

        const name = document.createElement('span');
        name.className = 'flow-name';
        const title = document.createElement('span');
        title.textContent = row.name;
        const meta = document.createElement('small');
        meta.className = 'flow-meta';
        const dot = document.createElement('span');
        dot.className = row.state === 1 ? 'state' : 'state off';
        meta.append(dot, document.createTextNode(row.client + ' · ' + row.environment));
        name.append(title, meta);
        button.append(name);

        const solutions = document.createElement('span');
        solutions.className = 'solutions';
        if (row.solutions.length) {
          for (const solution of row.solutions) solutions.append(textCell('solution', solution));
        }
        button.append(solutions);

        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'select', index: row.index });
        });
        rowsContainer.append(button);
      }

      resultsWrap.hidden = false;
      if (!data.rows.length) {
        rowsContainer.append(textCell('empty', 'No matching Power Automate flows.'));
      }
      if (data.rows.length) { rowsContainer.tabIndex = -1; rowsContainer.focus(); }
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'loading') {
        resultsWrap.hidden = false;
        rowsContainer.replaceChildren();
        rowsContainer.append(textCell('empty', 'Searching Power Automate flows…'));
      } else if (message.type === 'results') {
        renderRows(message);
      } else if (message.type === 'error') {
        resultsWrap.hidden = false;
        rowsContainer.replaceChildren();
        rowsContainer.append(textCell('empty', message.message));
      }
    });
    queryInput.focus();
  </script>
</body>
</html>`;
}
