import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { Cell, cellText, ResultSet, toCsv, toJson } from "../core/query";

export interface QueryOutcome {
  sets: ResultSet[];
  /** Statements that failed, with the reason. */
  errors: Array<{ source: string; message: string }>;
  /** Display order, matching the statements: ["set", index] or ["error", index]. */
  order?: Array<["set" | "error", number]>;
}

/** What a right-click on a grid cell passes to the context menu commands (via data-vscode-context). */
export interface CellContext {
  set: number;
  row: number;
  col: number;
  stored: boolean;
}

/**
 * The Query Results tab in the bottom panel. It shows the latest run, like the
 * results pane in SQL Server tools, and keeps its state while you switch tabs.
 */
export class ResultsView implements vscode.WebviewViewProvider {
  static readonly id = "lantern.results";
  private view?: vscode.WebviewView;
  private outcome?: QueryOutcome;
  private client?: Client;
  private title = "";

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: Message) => this.handle(msg));
    view.onDidDispose(() => (this.view = undefined));
    this.render();
  }

  async show(title: string, client: Client, outcome: QueryOutcome): Promise<void> {
    this.title = title;
    this.client = client;
    this.outcome = outcome;
    if (this.view) {
      this.render();
      this.view.show(true);
    } else {
      // Opens the panel tab, which resolves the view and renders the stored outcome.
      await vscode.commands.executeCommand(`${ResultsView.id}.focus`);
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    }
  }

  private render(): void {
    if (!this.view) return;
    this.view.description = this.title;
    this.view.webview.html = renderHtml(this.view.webview, this.outcome);
  }

  // ---------- data for commands ----------

  get currentClient(): Client | undefined {
    return this.client;
  }

  set(index: number): ResultSet | undefined {
    return this.outcome?.sets[index];
  }

  cell(ctx: CellContext): { set: ResultSet; cell: Cell } | undefined {
    const set = this.outcome?.sets[ctx.set];
    const cell = set?.rows[ctx.row]?.[ctx.col];
    return set && cell ? { set, cell } : undefined;
  }

  async copyCell(ctx: CellContext): Promise<void> {
    const hit = this.cell(ctx);
    if (hit) await copy(cellText(hit.cell, !ctx.stored));
  }

  async copyRow(ctx: CellContext): Promise<void> {
    const set = this.outcome?.sets[ctx.set];
    const row = set?.rows[ctx.row];
    if (set && row) await copy(`${set.columns.join("\t")}\n${row.map((c) => cellText(c, !ctx.stored)).join("\t")}`);
  }

  async copyColumn(ctx: CellContext): Promise<void> {
    const set = this.outcome?.sets[ctx.set];
    if (set) await copy([set.columns[ctx.col], ...set.rows.map((r) => cellText(r[ctx.col], !ctx.stored))].join("\n"));
  }

  /** The cell's lookup record, or the row's own record. */
  async openRecord(ctx: CellContext): Promise<void> {
    const hit = this.cell(ctx);
    if (!hit || !this.client) return;
    const target = hit.cell.ref ?? (hit.set.rowIds[ctx.row] ? { table: hit.set.table, id: hit.set.rowIds[ctx.row]! } : undefined);
    if (target) await openRecord(this.client, target.table, target.id);
    else void vscode.window.showInformationMessage("This row has no record ID to open (aggregate or grouped results).");
  }

  private async handle(msg: Message): Promise<void> {
    const set = this.outcome?.sets[msg.set ?? 0];
    switch (msg.cmd) {
      case "copy":
        await copy(msg.text ?? "");
        return;
      case "open":
        if (msg.table && msg.id && this.client) await openRecord(this.client, msg.table, msg.id);
        return;
      case "fetchxml":
        if (set) {
          const doc = await vscode.workspace.openTextDocument({ language: "xml", content: set.fetchXml + "\n" });
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active });
        }
        return;
      case "save":
        if (set) await saveResults(set, msg.format === "json" ? "json" : "csv", !!msg.formatted);
        return;
      case "code":
        await vscode.commands.executeCommand("lantern.results.copyAs", msg.set ?? 0);
        return;
    }
  }
}

async function copy(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage("$(copy) Copied", 2000);
}

export async function openRecord(client: Client, table: string, id: string): Promise<void> {
  await vscode.env.openExternal(
    vscode.Uri.parse(`${client.config.org}/main.aspx?etn=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}&pagetype=entityrecord`)
  );
}

async function saveResults(set: ResultSet, ext: "csv" | "json", formatted: boolean): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${set.table}.${ext}`),
    filters: ext === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
  });
  if (!target) return;
  fs.writeFileSync(target.fsPath, ext === "json" ? toJson(set, formatted) : toCsv(set, formatted));
  const choice = await vscode.window.showInformationMessage(
    `Saved ${set.rows.length} ${set.rows.length === 1 ? "row" : "rows"} to ${path.basename(target.fsPath)}.`,
    "Open File",
    "Show in Folder"
  );
  if (choice === "Open File") await vscode.window.showTextDocument(target);
  if (choice === "Show in Folder") await vscode.commands.executeCommand("revealFileInOS", target);
}

interface Message {
  cmd: "copy" | "open" | "fetchxml" | "save" | "code";
  set?: number;
  text?: string;
  table?: string;
  id?: string;
  format?: "csv" | "json";
  formatted?: boolean;
}

function nonce(): string {
  return [...Array(24)].map(() => Math.floor(Math.random() * 36).toString(36)).join("");
}

/** JSON safe to place inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// 16px line icons in the style of VS Code's codicons, drawn with currentColor.
const ICONS = {
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>',
  save: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11"/></svg>',
  code: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13"/></svg>',
  braces: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2.5c-1.5 0-2 .7-2 2v1.6c0 .9-.5 1.4-1.5 1.9 1 .5 1.5 1 1.5 1.9v1.6c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.6c0 .9.5 1.4 1.5 1.9-1 .5-1.5 1-1.5 1.9v1.6c0 1.3-.5 2-2 2"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>',
};

export function renderHtml(webview: vscode.Webview, outcome: QueryOutcome | undefined): string {
  const n = nonce();
  const data = outcome && {
    sets: outcome.sets.map((s) => ({
      source: s.source,
      table: s.table,
      columns: s.columns,
      rows: s.rows,
      rowIds: s.rowIds,
      truncated: s.truncated,
      elapsedMs: s.elapsedMs,
      kind: s.kind ?? "query",
      hasRecord: !!s.record,
    })),
    errors: outcome.errors,
    order: outcome.order ?? [
      ...outcome.sets.map((_, i): ["set", number] => ["set", i]),
      ...outcome.errors.map((_, i): ["error", number] => ["error", i]),
    ],
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; --radius: 4px; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background));
  }
  #root { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
  .set { display: flex; flex-direction: column; min-height: 0; padding: 6px 12px 8px; }
  .set:only-child { flex: 1; }
  .set + .set { border-top: 1px solid var(--vscode-panel-border); }

  /* Statement: one line, click to see all of it. */
  .source {
    display: flex; align-items: flex-start; gap: 4px; width: 100%; margin: 0 0 4px; padding: 2px 4px 2px 0;
    border: 0; border-radius: var(--radius); background: none; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family); font-size: 0.92em; text-align: left; cursor: pointer;
  }
  .source:hover { background: var(--vscode-toolbar-hoverBackground); }
  .source svg { flex: none; width: 14px; height: 14px; margin-top: 1px; fill: none; stroke: currentColor; stroke-width: 1.4; transition: transform 0.12s; }
  .source[aria-expanded="true"] svg { transform: rotate(90deg); }
  .source .text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .source[aria-expanded="true"] .text { white-space: pre-wrap; }

  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-bottom: 6px; }
  .summary { flex: 1 1 200px; color: var(--vscode-descriptionForeground); }
  .summary strong { color: var(--vscode-foreground); font-weight: 600; }
  .tools { display: flex; align-items: center; gap: 2px; }
  .divider { width: 1px; height: 16px; margin: 0 6px; background: var(--vscode-panel-border); }

  .tool {
    display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px;
    border: 0; border-radius: var(--radius); background: transparent; color: var(--vscode-foreground);
    font: inherit; cursor: pointer;
  }
  .tool:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tool:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
  .tool svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
  .tool:focus-visible, .source:focus-visible, .check input:focus-visible, td:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  .check { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 4px; cursor: pointer; user-select: none; }
  .check input {
    appearance: none; position: relative; margin: 0; width: 16px; height: 16px; flex: none; cursor: pointer;
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-panel-border)); border-radius: 3px;
    background: var(--vscode-checkbox-background, transparent);
  }
  .check input:checked::after {
    content: ""; position: absolute; left: 4.5px; top: 1.5px; width: 4px; height: 8px;
    border: solid var(--vscode-checkbox-foreground, var(--vscode-foreground)); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
  }

  .grid { flex: 1; min-height: 60px; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); }
  .set:not(:only-child) .grid { flex: none; max-height: 45vh; }
  table { border-collapse: separate; border-spacing: 0; min-width: 100%; }
  th, td {
    padding: 2px 10px; text-align: left; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border));
  }
  th {
    position: sticky; top: 0; z-index: 2; cursor: pointer; font-weight: 600; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  th .dir { color: var(--vscode-descriptionForeground); padding-left: 4px; font-size: 0.85em; }
  td { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); font-variant-numeric: tabular-nums; }
  td.num { text-align: right; }
  .rownum {
    position: sticky; left: 0; z-index: 1; text-align: right; color: var(--vscode-editorLineNumber-foreground);
    background: var(--vscode-panel-background, var(--vscode-editor-background)); cursor: pointer;
  }
  th.rownum { z-index: 3; cursor: default; }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.sel { background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }
  .null { color: var(--vscode-descriptionForeground); font-style: italic; }
  .ref { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .ref:hover { text-decoration: underline; }
  .note { margin: 6px 0 0; color: var(--vscode-descriptionForeground); }
  .error p { margin: 4px 0; color: var(--vscode-errorForeground); }
  .empty { padding: 8px 2px; color: var(--vscode-descriptionForeground); }
  .welcome { margin: auto; max-width: 46ch; padding: 16px; color: var(--vscode-descriptionForeground); text-align: center; line-height: 1.5; }
  @media (prefers-reduced-motion: reduce) { .source svg { transition: none; } }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${n}">
(() => {
  const vscode = acquireVsCodeApi();
  const data = ${scriptJson(data ?? null)};
  const root = document.getElementById("root");
  const ICONS = ${scriptJson(ICONS)};
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };
  const icon = (name) => { const s = el("span", { html: ICONS[name] }); return s.firstChild; };
  const tool = (label, title, iconName, onclick) => el("button", { class: "tool", title, onclick }, icon(iconName), label);

  if (!data) {
    root.append(el("div", { class: "welcome" }, "Run a query with F5 from a Dataverse query document. Results show up here."));
    return;
  }

  const fmt = new Intl.NumberFormat();
  const isNum = (v) => typeof v === "number";
  const plain = (cell, stored) => {
    if (!stored && cell.formatted !== undefined) return cell.formatted;
    if (cell.raw === null || cell.raw === undefined) return "";
    return typeof cell.raw === "object" ? JSON.stringify(cell.raw) : String(cell.raw);
  };
  let selected = null;

  const sourceLine = (text) => {
    const b = el("button", { class: "source", "aria-expanded": "false", title: "Show the whole statement" }, icon("chevron"), el("span", { class: "text" }, text));
    b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      b.title = open ? "Collapse" : "Show the whole statement";
    });
    return b;
  };

  const showError = (err) => {
    root.append(el("section", { class: "set error" }, sourceLine(err.source), el("p", {}, err.message)));
  };

  const showSet = (set, si) => {
    let stored = false;
    let sort = { col: -1, desc: false };
    const order = set.rows.map((_, i) => i);
    const count = set.rows.length;
    const noun = set.kind === "record" ? (count === 1 ? " column" : " columns") : set.kind === "audit" ? (count === 1 ? " change" : " changes") : (count === 1 ? " row" : " rows");
    const when = set.kind === "report" ? (set.truncated ? " (first " + fmt.format(count) + " shown)" : "")
      : (set.kind === "write" ? " processed in " : set.kind === "record" || set.kind === "audit" ? " loaded in " : " from " + set.table + " in ") + fmt.format(set.elapsedMs) + " ms";
    const summary = el("span", { class: "summary" }, el("strong", {}, fmt.format(count) + noun), when);

    // Redraws the grid; stays a no-op for an empty result, which has no grid.
    let rerender = () => {};
    const toggle = el("input", { type: "checkbox" });
    toggle.addEventListener("change", () => { stored = toggle.checked; rerender(); });
    const asTsv = () => [set.columns.join("\\t"), ...order.map((r) => set.rows[r].map((c) => plain(c, stored)).join("\\t"))].join("\\n");
    const bar = el("div", { class: "bar" }, summary,
      el("div", { class: "tools" },
        el("label", { class: "check", title: "Show what Dataverse stores: lookup IDs, choice numbers, UTC dates" }, toggle, "Stored values"),
        el("span", { class: "divider", "aria-hidden": "true" }),
        tool("Copy", "Copy all rows (paste into Excel)", "copy", () => vscode.postMessage({ cmd: "copy", text: asTsv() })),
        tool("CSV", "Save as CSV", "save", () => vscode.postMessage({ cmd: "save", set: si, format: "csv", formatted: !stored })),
        tool("JSON", "Save as JSON", "save", () => vscode.postMessage({ cmd: "save", set: si, format: "json", formatted: !stored })),
        set.kind === "query" ? tool("Code", "Copy this query as JavaScript, a Web API URL, or C#", "braces", () => vscode.postMessage({ cmd: "code", set: si })) : null,
        set.kind === "query" ? tool("FetchXML", "Open the FetchXML this query ran as", "code", () => vscode.postMessage({ cmd: "fetchxml", set: si })) : null));

    const section = el("section", { class: "set" }, sourceLine(set.source), bar);
    if (!count) {
      section.append(el("div", { class: "empty" }, "No rows matched."));
      root.append(section);
      return;
    }
    const thead = el("thead");
    const tbody = el("tbody");
    section.append(el("div", { class: "grid" }, el("table", {}, thead, tbody)));
    if (set.truncated) section.append(el("p", { class: "note" }, set.kind === "report"
      ? "Showing the first " + fmt.format(count) + " rows."
      : "Showing the first " + fmt.format(count) + " rows. More exist; add TOP or a WHERE clause, or raise lantern.query.maxRows."));
    root.append(section);

    const sortValue = (cell) => {
      const v = stored || cell.formatted === undefined ? cell.raw : cell.formatted;
      return v === null || v === undefined ? null : v;
    };
    const header = () => {
      thead.replaceChildren(el("tr", {}, el("th", { class: "rownum" }, ""),
        ...set.columns.map((name, ci) => el("th", {
          tabindex: "0",
          title: "Sort by " + name,
          onclick: () => {
            sort = { col: ci, desc: sort.col === ci ? !sort.desc : false };
            order.sort((a, b) => {
              const x = sortValue(set.rows[a][ci]);
              const y = sortValue(set.rows[b][ci]);
              if (x === y) return 0;
              if (x === null) return 1;
              if (y === null) return -1;
              const r = isNum(x) && isNum(y) ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
              return sort.desc ? -r : r;
            });
            render();
          },
        }, name, sort.col === ci ? el("span", { class: "dir" }, sort.desc ? "▼" : "▲") : null))));
    };
    const cellNode = (cell, r, ci) => {
      const td = el("td", {
        tabindex: "-1",
        // Right-click menu (Copy value / row / column, Open record) comes from VS Code via this context.
        "data-vscode-context": JSON.stringify({
          webviewSection: "cell", set: si, row: r, col: ci, stored, setKind: set.kind,
          hasRecord: !!(cell.ref || set.rowIds[r] || set.hasRecord), preventDefaultContextMenuItems: true,
        }),
      });
      if (cell.raw === null || cell.raw === undefined) {
        td.append(el("span", { class: "null" }, "NULL"));
      } else {
        // Numbers and money line up on the right; choice labels stay left like other text.
        if (isNum(cell.raw) && (stored || cell.formatted === undefined || /^[\\s\\d.,%()+\\-$€£¥]+$/.test(cell.formatted))) td.className = "num";
        const text = plain(cell, stored);
        if (cell.ref) {
          td.append(el("span", { class: "ref", title: "Double-click to open " + cell.ref.table + " " + cell.ref.id }, text));
          td.addEventListener("dblclick", () => vscode.postMessage({ cmd: "open", table: cell.ref.table, id: cell.ref.id }));
        } else td.append(text);
        if (!stored && cell.formatted !== undefined) td.title = "Stored value: " + plain(cell, true);
      }
      const select = () => {
        if (selected) selected.classList.remove("sel");
        selected = td;
        td.classList.add("sel");
      };
      td.addEventListener("click", () => { select(); td.focus(); });
      td.addEventListener("contextmenu", select);
      td.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "c") vscode.postMessage({ cmd: "copy", text: plain(cell, stored) });
      });
      return td;
    };
    const render = () => {
      header();
      tbody.replaceChildren(...order.map((r, i) => {
        const id = set.rowIds[r];
        const num = el("td", { class: "rownum", title: id ? "Double-click to open this record" : "" }, String(i + 1));
        if (id) num.addEventListener("dblclick", () => vscode.postMessage({ cmd: "open", table: set.table, id }));
        return el("tr", {}, num, ...set.rows[r].map((cell, ci) => cellNode(cell, r, ci)));
      }));
    };
    rerender = render;
    render();
  };

  data.order.forEach(([kind, i]) => (kind === "set" ? showSet(data.sets[i], i) : showError(data.errors[i])));
})();
</script>
</body>
</html>`;
}
