import * as crypto from "crypto";
import * as vscode from "vscode";

/**
 * The editor-tab forms: one page shell (title and subtitle, an optional list on the
 * left and a form on the right, a footer with Cancel and the primary button), one
 * stylesheet in VS Code's theme colours, and one message protocol between the
 * extension and the webview. Each panel under src/ui/panels builds its form in the
 * webview from the state the extension sends it, posts the draft back on every
 * change (the extension validates, since Dataverse's rules live in core), and
 * submits once. Nothing is sent to Dataverse until the primary button.
 */

/** Webview → extension. */
export type PanelRequest =
  /** The page loaded (or reloaded after being hidden: retainContextWhenHidden is off) and wants its state. */
  | { type: "ready" }
  /** The draft changed; the extension answers with a "status". */
  | { type: "change"; draft: unknown }
  /** Something the webview can't know by itself (a table's columns, users matching a search). */
  | { type: "request"; id: number; name: string; args?: unknown }
  | { type: "submit"; draft: unknown }
  | { type: "cancel" };

/** A problem with a field, shown next to it; `field` "" is shown in the footer. */
export interface Problem {
  field: string;
  text: string;
}

export interface Status {
  problems: Problem[];
  /** What the footer says beside the primary button ("2 changes", "no changes yet"). */
  summary?: string;
  /** Disables the primary button even without problems (nothing changed yet). */
  blocked?: boolean;
}

/** Extension → webview. */
export type PanelReply =
  | { type: "init"; state: unknown }
  | { type: "status"; status: Status }
  | { type: "reply"; id: number; result?: unknown; error?: string }
  /** A line in the footer, after a submit that couldn't go through. */
  | { type: "note"; text: string };

export interface PanelOptions<State, Draft> {
  viewType: string;
  /** The tab's title and the page's heading. */
  title: string;
  /** The line at the top right. */
  subtitle: string;
  /** Sent to the webview; `draft` is what comes back edited. */
  state: State & { draft: Draft };
  /** The panel's own markup between the header and the footer: `<main class="split">` or `<main class="single">`. */
  body: string;
  /** The panel's own script. It defines `build()`, which fills the page from `state` and `draft` (both in scope once the state arrives). */
  script: string;
  /** Problems and the summary for a draft. Called on every change and before a submit. */
  validate: (draft: Draft) => Status;
  /** Something the webview asked for. */
  request?: (name: string, args: unknown) => Promise<unknown>;
  /**
   * The submit. Returns nothing to close the panel with the draft, or a line to
   * show in the footer when the draft can't go through after all.
   */
  submit?: (draft: Draft) => Promise<string | undefined>;
  /** The primary button's label; "" for a read-only page, which has only the Cancel button. */
  action: string;
  /** The Cancel button's label ("Close" on a read-only page). */
  cancel?: string;
  column?: vscode.ViewColumn;
  iconPath?: vscode.Uri;
}

/**
 * Opens the form as an editor tab and resolves with the submitted draft, or
 * undefined when it's cancelled (Cancel, Escape, or closing the tab). The panel
 * closes itself after a submit the validation accepts.
 */
export function openPanel<State, Draft>(opts: PanelOptions<State, Draft>): Promise<Draft | undefined> {
  return new Promise<Draft | undefined>((resolve) => {
    const panel = vscode.window.createWebviewPanel(opts.viewType, opts.title, opts.column ?? vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    if (opts.iconPath) panel.iconPath = opts.iconPath;
    let done = false;
    let submitting = false;
    const finish = (value: Draft | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
      panel.dispose();
    };
    const post = (m: PanelReply) => panel.webview.postMessage(m);
    panel.onDidDispose(() => finish(undefined));
    panel.webview.onDidReceiveMessage(async (m: PanelRequest) => {
      if (done) return;
      if (m.type === "ready") {
        await post({ type: "init", state: opts.state });
      } else if (m.type === "change") {
        await post({ type: "status", status: opts.validate(m.draft as Draft) });
      } else if (m.type === "request") {
        try {
          await post({ type: "reply", id: m.id, result: opts.request ? await opts.request(m.name, m.args) : undefined });
        } catch (err) {
          await post({ type: "reply", id: m.id, error: err instanceof Error ? err.message : String(err) });
        }
      } else if (m.type === "submit") {
        // One save at a time: a double-click or Ctrl+Enter during a save would run it twice.
        if (submitting) return;
        const draft = m.draft as Draft;
        const status = opts.validate(draft);
        if (status.problems.length || status.blocked) {
          await post({ type: "status", status });
          return;
        }
        submitting = true;
        let note: string | undefined;
        try {
          note = opts.submit ? await opts.submit(draft) : undefined;
        } catch (err) {
          // Shown in the footer; without this the rejection is dropped and the page sits there.
          note = err instanceof Error ? err.message : String(err);
        } finally {
          submitting = false;
        }
        if (note) await post({ type: "note", text: note });
        else finish(draft);
      } else if (m.type === "cancel") {
        finish(undefined);
      }
    });
    panel.webview.html = renderPage(panel.webview, { title: opts.title, subtitle: opts.subtitle, body: opts.body, script: opts.script, action: opts.action, cancel: opts.cancel });
  });
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Inline SVG icons (currentColor), so no icon font is needed. */
export const ICONS: Record<string, string> = {
  info: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm.5 5v5h-1V7h1zm0-2.5v1h-1v-1h1z"/></svg>',
  search: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.5 2a4.5 4.5 0 0 1 3.6 7.2l1.9 1.9-.7.7-1.9-1.9A4.5 4.5 0 1 1 10.5 2zm0 1a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/></svg>',
  package: '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M12 3 4 7v10l8 4 8-4V7l-8-4zm0 0v18M4 7l8 4 8-4"/></svg>',
  cls: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 2h6l1 1h3v10H3V2zm1 1v9h8V4H9.6l-1-1H4z"/></svg>',
  event: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 1 3 9h4l-1 6 7-9H9l1-5z"/></svg>',
  image: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 2h12v12H2V2zm1 1v7.3l2.5-2.5 2 2 3.5-3.5 2 2V3H3zm10 6.7-2-2-3.5 3.5-2-2L3 11.7V13h10V9.7zM5.5 4.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
  server: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 2h12v5H2V2zm1 1v3h10V3H3zm-1 6h12v5H2V9zm1 1v3h10v-3H3zm1-6h1v1H4V4zm0 7h1v1H4v-1z"/></svg>',
  add: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5V2z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 1h4l1 2h3v1h-1l-1 10H4L3 4H2V3h3l1-2zm.6 1-.5 1h3.8l-.5-1H6.6zM4 4l.9 9h6.2L12 4H4zm2 2h1v6H6V6zm3 0h1v6H9V6z"/></svg>',
  warning: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1.5 15 14H1L8 1.5zm0 2L2.7 13h10.6L8 3.5zM7.5 6h1v4h-1V6zm0 5h1v1h-1v-1z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 0c-3 3-3 15 0 18m0-18c3 3 3 15 0 18M3 12h18M4.5 7.5h15M4.5 16.5h15"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" d="M4 6h2m3 0h11M4 12h2m3 0h11M4 18h2m3 0h11"/></svg>',
};

const CSS = `
  :root {
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground, var(--vscode-foreground));
    --input-border: var(--vscode-input-border, transparent);
    --focus: var(--vscode-focusBorder);
    --error: var(--vscode-errorForeground, var(--vscode-inputValidation-errorForeground, #f14c4c));
    --hover: var(--vscode-list-hoverBackground);
    --selected: var(--vscode-list-activeSelectionBackground);
    --selected-fg: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    --accent: var(--vscode-textLink-foreground);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); display: flex; flex-direction: column; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; padding: 14px 24px 12px; border-bottom: 1px solid var(--border); flex: none; }
  header h1 { font-size: 1.45em; font-weight: 600; margin: 0; }
  header .subtitle { color: var(--muted); font-size: .92em; text-align: right; }
  main { flex: 1; min-height: 0; display: flex; }
  main.split > .list { width: 320px; flex: none; border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  main > .form { flex: 1; min-width: 0; overflow: auto; padding: 22px 24px 28px; }
  .list .search { padding: 14px 14px 10px; flex: none; position: relative; }
  .list .search svg { position: absolute; left: 22px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
  .list .search input { padding-left: 28px; }
  .list .items { overflow: auto; flex: 1; }
  .list .item { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-top: 1px solid var(--border); cursor: pointer; }
  .list .item:last-child { border-bottom: 1px solid var(--border); }
  .list .item:hover { background: var(--hover); }
  .list .item.selected { background: var(--selected); color: var(--selected-fg); }
  .list .item.selected .meta, .list .item.selected .count { color: inherit; opacity: .8; }
  .list .item .icon { display: flex; color: var(--accent); flex: none; }
  .list .item.selected .icon { color: inherit; }
  .list .item .text { flex: 1; min-width: 0; }
  .list .item .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list .item .meta { color: var(--muted); font-size: .9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list .item .count { color: var(--muted); font-size: .9em; white-space: nowrap; }
  .list .item .flag { color: var(--error); display: flex; }
  .list .actions { padding: 10px 14px; display: flex; gap: 8px; flex: none; }
  .list .nothing { padding: 16px 14px; color: var(--muted); font-size: .92em; line-height: 1.4; }
  .list .group { padding: 14px 14px 6px; color: var(--muted); font-size: .85em; text-transform: uppercase; letter-spacing: .04em; }
  .list .item.depth1 { padding-left: 28px; }
  .list .item.depth2 { padding-left: 42px; }
  .list .item.depth3 { padding-left: 56px; }
  .list .item.depth4 { padding-left: 70px; }
  .list .item.dim .name { font-weight: 400; }
  .list .item.dim .icon { color: var(--muted); }
  .list .options { padding: 0 14px 10px; display: flex; gap: 14px; flex-wrap: wrap; font-size: .92em; }
  .tag { font-size: .8em; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .tag.mine { border-color: var(--accent); color: var(--accent); }
  .tag.off { border-style: dashed; }
  .block { border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; margin-bottom: 10px; max-width: 960px; }
  .block .head { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; flex-wrap: wrap; }
  .block .head .id, .mono { font-weight: 400; font-family: var(--vscode-editor-font-family); font-size: .92em; }
  .block .head .id { color: var(--muted); }
  .block .grid { gap: 6px 14px; }
  ul.plain { margin: 4px 0 0; padding-left: 18px; }
  ul.plain li { margin: 3px 0; }
  .problem.warning { color: var(--vscode-editorWarning-foreground, var(--vscode-list-warningForeground, #cca700)); }
  .previewwrap { border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px 10px; margin-bottom: 18px; max-width: 960px; overflow-x: auto; }
  .previewtitle { color: var(--muted); font-size: .85em; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 8px; }
  .preview { display: flex; align-items: flex-start; gap: 0; }
  .preview .pgroup { display: flex; align-items: center; gap: 2px; padding: 4px 8px 4px 0; border-right: 1px solid var(--border); margin-right: 8px; min-height: 34px; }
  .preview .pgrouplabel { display: none; }
  .pbtn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: .95em; padding: 5px 9px; border-radius: 3px; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); cursor: pointer; white-space: nowrap; }
  .pbtn:hover { background: var(--hover); }
  .pbtn.mine { border-color: var(--accent); }
  .pbtn.local { border-style: dashed; }
  .pbtn.off { opacity: .45; text-decoration: line-through; }
  .pbtn.selected { background: var(--selected); color: var(--selected-fg); }
  .pbtn .picon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; font-size: .7em; border-radius: 2px; background: rgba(128,128,128,.25); }
  .pbtn .picon.dim { background: transparent; color: var(--muted); }
  .pbtn .chev { font-size: .8em; color: var(--muted); }
  .iconimg { width: 16px; height: 16px; vertical-align: middle; }
  .grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 12px 18px; align-items: center; max-width: 960px; }
  .grid > label { font-weight: 600; white-space: nowrap; }
  .grid > label.top { align-self: start; padding-top: 6px; }
  .grid .cell { min-width: 0; }
  .grid .cell.row { display: flex; align-items: center; gap: 8px; }
  .grid .cell.row > :first-child { flex: 1; min-width: 0; }
  .grid .cell.row > .hint { flex: none; }
  .grid .static { padding: 5px 0; }
  .grid .full { grid-column: 1 / -1; }
  input[type=text], input[type=search], input[type=number], input[type=password], input[type=url], textarea, select {
    font: inherit; color: var(--input-fg); background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 2px; padding: 5px 8px; width: 100%; outline: none;
  }
  select { appearance: auto; }
  textarea { resize: vertical; min-height: 64px; font-family: var(--vscode-editor-font-family); font-size: .95em; }
  input:focus-visible, textarea:focus-visible, select:focus-visible { border-color: var(--focus); outline: 1px solid var(--focus); outline-offset: -1px; }
  input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--muted)); }
  input.invalid, textarea.invalid, select.invalid { border-color: var(--error); outline: 1px solid var(--error); outline-offset: -1px; }
  input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: var(--vscode-checkbox-background, var(--accent)); cursor: pointer; flex: none; }
  input[readonly] { color: var(--muted); }
  .check { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .check.off { color: var(--muted); }
  .hint { display: inline-flex; color: var(--muted); cursor: help; vertical-align: middle; }
  .hint svg { display: block; }
  .problem { color: var(--error); font-size: .92em; margin-top: 4px; display: flex; align-items: center; gap: 6px; }
  .problem:empty { display: none; }
  .problem svg { flex: none; }
  .note { color: var(--muted); font-size: .92em; margin-top: 4px; }
  h2 { font-size: 1em; font-weight: 600; margin: 26px 0 12px; padding-top: 18px; border-top: 1px solid var(--border); }
  h2:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
  .empty { border: 1px solid var(--border); border-radius: 4px; padding: 56px 24px; text-align: center; color: var(--muted); }
  .empty svg { color: var(--muted); opacity: .8; margin-bottom: 10px; }
  .empty .title { font-size: 1.15em; color: var(--vscode-foreground); margin-bottom: 4px; }
  .checklist { border: 1px solid var(--border); border-radius: 2px; }
  .checklist .tools { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .checklist .tools .search { flex: 1; position: relative; display: block; }
  .checklist .tools .search svg { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
  .checklist .tools input[type=search] { padding-left: 28px; }
  .checklist .tools .count { color: var(--muted); font-size: .9em; white-space: nowrap; }
  .checklist .rows { max-height: 360px; overflow: auto; }
  .checklist.tall .rows { max-height: none; }
  .checklist .group { padding: 10px 10px 4px; color: var(--muted); font-size: .85em; text-transform: uppercase; letter-spacing: .04em; }
  .checklist .row { display: flex; align-items: center; gap: 10px; padding: 5px 10px; cursor: pointer; }
  .checklist .row:hover { background: var(--hover); }
  .checklist .row .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .checklist .row .meta { color: var(--muted); font-size: .9em; white-space: nowrap; }
  .checklist .row .tag { font-size: .8em; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .checklist .none { padding: 14px 10px; color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .chip { font: inherit; font-size: .9em; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
  .chip:hover { background: var(--hover); }
  .chip.suggested { border-color: var(--accent); color: var(--accent); }
  .pick { position: relative; width: 100%; }
  .pick .menu { position: absolute; z-index: 2; left: 0; right: 0; top: 100%; max-height: 240px; overflow: auto; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,.25); }
  .pick .menu .row { padding: 6px 10px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  .pick .menu .row:hover { background: var(--hover); }
  .pick .menu .row .meta { color: var(--muted); font-size: .9em; }
  .pick .menu .none { padding: 8px 10px; color: var(--muted); }
  footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 24px; border-top: 1px solid var(--border); }
  footer .left { color: var(--muted); font-size: .92em; min-width: 0; }
  footer .left.error { color: var(--error); }
  footer .buttons { display: flex; gap: 8px; flex: none; }
  button { font: inherit; border-radius: 2px; padding: 6px 14px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.25)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.35)); }
  button:focus-visible { outline: 1px solid var(--focus); outline-offset: 2px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled, button.primary:disabled { opacity: .5; cursor: default; }
  button.icon { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; }
  button.icon svg { display: block; }
  button.link { background: none; border: 0; color: var(--accent); padding: 0; }
  button.link:hover { text-decoration: underline; background: none; }
  .loading { color: var(--muted); padding: 6px 0; }
`;

/**
 * Helpers every panel's script uses; plain functions on the page, no framework.
 * `h` builds elements, `field` a labelled row in the grid, `checklist` a searchable
 * list of checkboxes, `pick` a text box with a dropdown of matches. `changed()`
 * posts the draft for validation, `ask()` requests something from the extension.
 * The webview keeps its state in VS Code's webview state, so a hidden tab comes
 * back as it was (retainContextWhenHidden is off).
 */
const SHARED_SCRIPT = `
  const vscode = acquireVsCodeApi();
  let state, draft;
  const pending = new Map();
  let nextId = 1;
  const send = (m) => vscode.postMessage(m);
  const ask = (name, args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ type: "request", id, name, args }); });
  const remember = () => vscode.setState({ state, draft });
  const changed = () => { remember(); send({ type: "change", draft }); };
  const cancel = () => send({ type: "cancel" });
  // The button stays off until the extension answers (a status or a note), so a save can't be sent twice.
  const submit = () => { remember(); document.getElementById("primary").disabled = true; send({ type: "submit", draft }); };
  const h = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "readOnly" || k === "hidden") e[k] = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };
  const icon = (name, cls) => h("span", { class: cls || "icon", html: ICONS[name] || "" });
  const hintEl = (text) => (text ? h("span", { class: "hint", title: text, "aria-label": text, html: ICONS.info }) : null);
  const problemEl = (key) => h("div", { class: "problem", "data-problem": key });
  /** A row in the .grid: the label, the control with its hint, a note, and where its problem shows. */
  const field = (label, control, opts = {}) => [
    h("label", { class: opts.top ? "top" : "", for: control.id || (control.input && control.input.id) || undefined }, label),
    h("div", { class: "cell" }, h("div", { class: "row cell" }, control, hintEl(opts.hint)), opts.note ? h("div", { class: "note" }, opts.note) : null, problemEl(opts.key || control.id || label)),
  ];
  const text = (id, value, opts = {}) => h("input", { type: opts.type || "text", id, value: value ?? "", placeholder: opts.placeholder, maxlength: opts.max, min: opts.min, readOnly: opts.readOnly, spellcheck: "false", autocomplete: "off", oninput: (e) => opts.set && opts.set(e.target.value) });
  const area = (id, value, opts = {}) => h("textarea", { id, placeholder: opts.placeholder, rows: opts.rows || 3, spellcheck: "false", oninput: (e) => opts.set(e.target.value) }, value ?? "");
  const select = (id, value, options, set) => h("select", { id, onchange: (e) => set(e.target.value) }, options.map((o) => h("option", { value: String(o.value), selected: String(o.value) === String(value), disabled: o.disabled }, o.label + (o.description ? " — " + o.description : ""))));
  const checkbox = (id, label, checked, set, opts = {}) => {
    const box = h("input", { type: "checkbox", id, checked, disabled: opts.disabled, onchange: (e) => set(e.target.checked) });
    return h("label", { class: "check" + (opts.disabled ? " off" : ""), for: id }, box, h("span", {}, label), hintEl(opts.hint));
  };
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const empty = (iconName, title, text) => h("div", { class: "empty" }, h("div", { html: ICONS[iconName] || "" }), h("div", { class: "title" }, title), h("div", {}, text));
  /**
   * A searchable checklist. items: { id, label, meta, tags, group, title }; picked is a
   * Set the list keeps current, calling opts.onChange after every tick.
   */
  const checklist = (items, picked, opts = {}) => {
    const root = h("div", { class: "checklist" + (opts.tall ? " tall" : "") });
    const rows = h("div", { class: "rows" });
    const count = h("span", { class: "count" });
    const matches = (i, q) => !q || (i.label + " " + (i.meta || "") + " " + (i.tags || []).join(" ")).toLowerCase().includes(q);
    const search = h("input", { type: "search", placeholder: opts.placeholder || "Search", "aria-label": "Search", oninput: () => render() });
    const update = () => { count.textContent = picked.size ? plural(picked.size, "picked", "picked") : (opts.noneText || "none picked"); if (opts.onChange) opts.onChange(); };
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const shown = items.filter((i) => matches(i, q));
      rows.replaceChildren();
      if (!shown.length) { rows.append(h("div", { class: "none" }, items.length ? "Nothing matches." : opts.emptyText || "Nothing to pick.")); return; }
      let group;
      for (const i of shown) {
        if (i.group && i.group !== group) { group = i.group; rows.append(h("div", { class: "group" }, group)); }
        const box = h("input", { type: "checkbox", checked: picked.has(i.id), onchange: (e) => { if (e.target.checked) picked.add(i.id); else picked.delete(i.id); update(); } });
        rows.append(h("label", { class: "row", title: i.title || "" }, box, h("span", { class: "label" }, i.label), ...(i.tags || []).map((t) => h("span", { class: "tag" }, t)), i.meta ? h("span", { class: "meta" }, i.meta) : null));
      }
    };
    const all = h("button", { class: "link", type: "button", onclick: () => { const q = search.value.trim().toLowerCase(); for (const i of items) if (matches(i, q)) picked.add(i.id); render(); update(); } }, "Pick shown");
    const none = h("button", { class: "link", type: "button", onclick: () => { picked.clear(); render(); update(); } }, "Clear");
    root.append(h("div", { class: "tools" }, h("span", { class: "search" }, h("span", { html: ICONS.search }), search), count, all, none), rows);
    render();
    count.textContent = picked.size ? plural(picked.size, "picked", "picked") : (opts.noneText || "none picked");
    root.refresh = render;
    return root;
  };
  /**
   * A text box with a dropdown of matches. opts.options: { id, label, meta } to filter on
   * the page, or opts.onSearch(text) for a lookup; opts.set(option) on a pick,
   * opts.typed(text) as the person types.
   */
  const pick = (id, current, opts) => {
    const root = h("div", { class: "pick" });
    const input = h("input", { type: "text", id, value: current || "", placeholder: opts.placeholder, autocomplete: "off", spellcheck: "false" });
    const menu = h("div", { class: "menu", hidden: true });
    let options = opts.options || [];
    let timer;
    const show = (list) => {
      menu.replaceChildren();
      if (!list.length) menu.append(h("div", { class: "none" }, opts.noneText || "No matches."));
      for (const o of list.slice(0, 200)) menu.append(h("div", { class: "row", onmousedown: (e) => { e.preventDefault(); input.value = o.label; menu.hidden = true; opts.set(o); } }, h("span", {}, o.label), o.meta ? h("span", { class: "meta" }, o.meta) : null));
      menu.hidden = false;
    };
    const filter = () => { const q = input.value.trim().toLowerCase(); show(options.filter((o) => !q || (o.label + " " + (o.meta || "")).toLowerCase().includes(q))); };
    input.addEventListener("focus", () => { if (!opts.onSearch) filter(); });
    input.addEventListener("input", () => {
      if (opts.onSearch) { clearTimeout(timer); timer = setTimeout(async () => { try { options = await opts.onSearch(input.value.trim()); show(options); } catch (err) { show([]); } }, 300); }
      else filter();
      if (opts.typed) opts.typed(input.value);
    });
    input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 150));
    input.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { e.stopPropagation(); menu.hidden = true; } });
    root.append(input, menu);
    root.input = input;
    return root;
  };
  /** Problems next to their fields (or in the footer), the footer's text, and the primary button. */
  const showStatus = (status) => {
    document.querySelectorAll("[data-problem]").forEach((e) => { e.textContent = ""; });
    document.querySelectorAll(".invalid").forEach((e) => e.classList.remove("invalid"));
    const rest = [];
    for (const p of status.problems) {
      const slot = p.field && document.querySelector('[data-problem="' + CSS.escape(p.field) + '"]');
      if (slot) {
        slot.replaceChildren(h("span", { html: ICONS.warning }), p.text);
        const control = slot.parentElement && slot.parentElement.querySelector("input, select, textarea");
        if (control) control.classList.add("invalid");
      } else rest.push(p.text);
    }
    const left = document.getElementById("footerText");
    left.textContent = rest.length ? rest.join(" ") : status.summary || "";
    left.className = "left" + (rest.length ? " error" : "");
    document.getElementById("primary").disabled = !!status.problems.length || !!status.blocked;
    if (typeof onStatus === "function") onStatus(status);
  };
  document.getElementById("cancel").addEventListener("click", cancel);
  document.getElementById("primary").addEventListener("click", submit);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !document.getElementById("primary").disabled) submit();
  });
  const start = () => { document.getElementById("subtitle").textContent = state.subtitle || ""; build(); changed(); };
  window.addEventListener("message", ({ data }) => {
    if (data.type === "init") { if (!state) { state = data.state; draft = data.state.draft; start(); } }
    else if (data.type === "status") showStatus(data.status);
    else if (data.type === "reply") { const p = pending.get(data.id); pending.delete(data.id); if (p) { if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result); } }
    else if (data.type === "note") { const left = document.getElementById("footerText"); left.textContent = data.text; left.className = "left error"; document.getElementById("primary").disabled = false; }
  });
  const saved = vscode.getState();
  if (saved && saved.state) { state = saved.state; draft = saved.draft; start(); }
  else send({ type: "ready" });
`;

export function renderPage(webview: vscode.Webview, page: { title: string; subtitle: string; body: string; script: string; action: string; cancel?: string }): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header><h1>${escapeHtml(page.title)}</h1><span class="subtitle" id="subtitle">${escapeHtml(page.subtitle)}</span></header>
${page.body}
<footer>
  <span class="left" id="footerText"></span>
  <span class="buttons"><button id="cancel" type="button">${escapeHtml(page.cancel ?? "Cancel")}</button><button id="primary" class="primary" type="button" disabled${page.action ? "" : " hidden"}>${escapeHtml(page.action)}</button></span>
</footer>
<script nonce="${nonce}">
  const ICONS = ${JSON.stringify(ICONS)};
  ${page.script}
  ${SHARED_SCRIPT}
</script>
</body>
</html>`;
}
