// Minimal stand-in for the vscode API so the extension can be exercised headlessly.
// Scripted answers for input boxes / quick picks / messages are queued per test.
const path = require("path");

const state = {
  commands: new Map(),
  executed: [],
  messages: [],
  inputAnswers: [],
  quickPickAnswers: [],
  messageAnswers: [],
  config: {},
  workspaceFolders: [],
  activeTextEditor: undefined,
  treeViews: {},
  contentProviders: {},
  codeLensProviders: [],
  watchers: [],
  context: {},
  terminals: [],
  statusBarItems: [],
  opened: [],
};

class Uri {
  constructor(scheme, p, query = "", fragment = "") {
    this.scheme = scheme;
    this.path = p;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = scheme === "file" ? p : p;
  }
  with(c) { return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment); }
  static file(p) { return new Uri("file", p); }
  static parse(s) {
    // scheme:[//authority]path[?query][#fragment], like the real Uri.parse.
    const m = /^([a-zA-Z][\w+.-]*):(\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
    if (!m) return new Uri("file", s);
    const u = new Uri(m[1], m[3] || "", m[4] || "", m[5] || "");
    u.authority = m[2] ? m[2].slice(2) : "";
    return u;
  }
  static from(o) { return new Uri(o.scheme, o.path, o.query || ""); }
  toString() { return `${this.scheme}:${this.authority ? "//" + this.authority : ""}${this.path}${this.query ? "?" + this.query : ""}${this.fragment ? "#" + this.fragment : ""}`; }
}

class EventEmitter {
  constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return { dispose() {} }; }; }
  fire(v) { this.listeners.forEach((l) => l(v)); }
  dispose() {}
}

class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
class Range {
  constructor(...a) {
    this.args = a;
    if (a.length === 2) [this.start, this.end] = a;
    else { this.start = { line: a[0], character: a[1] }; this.end = { line: a[2], character: a[3] }; }
  }
}
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
class MarkdownString { constructor(v = "") { this.value = v; } appendMarkdown(v) { this.value += v; return this; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
}

class SnippetString {
  constructor(value = "") { this.value = value; }
  // Same escaping as VS Code: $, } and \ are special in snippets.
  appendText(text) { this.value += text.replace(/[$}\\]/g, "\\$&"); return this; }
}

const answer = (queue, fallback) => Promise.resolve(queue.length ? queue.shift() : fallback);
const ev = () => () => ({ dispose() {} });

/** A document with the position helpers real VS Code documents have. */
function textDocument(uri, text, languageId, isUntitled) {
  const offsetAt = (pos) => {
    if (!pos || pos.line === undefined) return 0;
    const lines = text.split("\n");
    let o = 0;
    for (let i = 0; i < Math.min(pos.line, lines.length); i++) o += lines[i].length + 1;
    return o + (pos.character || 0);
  };
  const positionAt = (offset) => {
    const before = text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return { line, character: offset - (before.lastIndexOf("\n") + 1) };
  };
  return { uri, languageId, isUntitled, getText: (range) => text, offsetAt, positionAt, lineCount: text.split("\n").length };
}

const window = {
  createTreeView(id, opts) {
    const v = {
      id, ...opts, message: undefined, badge: undefined, selection: [], dispose() {},
      // Like VS Code: the parent chain has to reach the root, and each node has to be the same object its parent's
      // children include, or the reveal fails.
      async reveal(el, options) {
        const p = this.treeDataProvider;
        const chain = [];
        for (let node = el; node; ) {
          const parent = p.getParent ? await p.getParent(node) : undefined;
          const siblings = await p.getChildren(parent);
          if (!siblings.includes(node)) throw new Error("reveal: element isn't among its parent's children");
          chain.unshift(node);
          node = parent;
        }
        state.revealed = { el, options, chain };
      },
    };
    state.treeViews[id] = v;
    return v;
  },
  createStatusBarItem() { const i = { text: "", show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }; state.statusBarItems.push(i); return i; },
  createOutputChannel() {
    // Everything written to any output channel, so tests can check what people would see there.
    state.output = state.output || [];
    return { text: "", append(t) { this.text += t; state.output.push(t); }, appendLine(t) { this.text += t + "\n"; state.output.push(t + "\n"); }, show() {} };
  },
  showInformationMessage(msg, ...items) { state.messages.push(["info", msg]); return answer(state.messageAnswers, undefined); },
  showWarningMessage(msg, ...items) {
    const options = items[0] && typeof items[0] === "object" && !Array.isArray(items[0]) && !("title" in items[0]) ? items[0] : undefined;
    state.messages.push(options ? ["warn", msg, options] : ["warn", msg]);
    return answer(state.messageAnswers, undefined);
  },
  showErrorMessage(msg, ...items) { state.messages.push(["error", msg]); return Promise.resolve(undefined); },
  showInputBox(opts) {
    let v = state.inputAnswers.length ? state.inputAnswers.shift() : undefined;
    // An answer can be a function of the box, to check what was offered.
    if (typeof v === "function") v = v(opts || {});
    if (v !== undefined && opts && opts.validateInput) {
      const err = opts.validateInput(v);
      if (err) throw new Error(`validateInput rejected "${v}": ${err}`);
    }
    return Promise.resolve(v);
  },
  showQuickPick(items, opts) {
    return Promise.resolve(items).then((list) => {
      const a = state.quickPickAnswers.length ? state.quickPickAnswers.shift() : undefined;
      if (a === undefined) return undefined;
      if (typeof a === "function") return a(list);
      return list.find((i) => (typeof i === "string" ? i === a : i.label === a)) ?? a;
    });
  },
  withProgress(opts, task) { return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} }); },
  setStatusBarMessage(msg) { state.messages.push(["status", msg]); return { dispose() {} }; },
  showTextDocument(uri, options) {
    state.opened.push(uri.fsPath || uri);
    state.lastShow = { target: uri, options };
    if (uri && uri.getText) state.activeTextEditor = { document: uri, selection: { isEmpty: true } };
    return Promise.resolve();
  },
  showOpenDialog() { return Promise.resolve(state.openAnswers && state.openAnswers.length ? state.openAnswers.shift() : undefined); },
  showSaveDialog() { return Promise.resolve(state.saveAnswers && state.saveAnswers.length ? state.saveAnswers.shift() : undefined); },
  registerWebviewViewProvider(id, provider) {
    state.viewProviders = state.viewProviders || {};
    state.viewProviders[id] = provider;
    return { dispose() {} };
  },
  createWebviewPanel(viewType, title) {
    const panel = {
      viewType, title, revealed: 0,
      webview: {
        html: "", cspSource: "vscode-webview:",
        listeners: [],
        onDidReceiveMessage(l) { this.listeners.push(l); return { dispose() {} }; },
        postMessage() { return Promise.resolve(true); },
        send(msg) { return Promise.all(this.listeners.map((l) => l(msg))); },
      },
      reveal() { this.revealed++; },
      onDidDispose() { return { dispose() {} }; },
    };
    state.panels = (state.panels || []).concat(panel);
    return panel;
  },
  createTerminal(name) { const t = { name, sent: [], sendText(x) { this.sent.push(x); }, show() {} }; state.terminals.push(t); return t; },
  get activeTextEditor() { return state.activeTextEditor; },
  onDidChangeActiveTextEditor: ev(),
};

const commands = {
  registerCommand(id, fn) { state.commands.set(id, fn); return { dispose() { state.commands.delete(id); } }; },
  executeCommand(id, ...args) {
    state.executed.push([id, ...args]);
    if (id === "setContext") { state.context[args[0]] = args[1]; return Promise.resolve(); }
    const viewId = id.endsWith(".focus") ? id.slice(0, -".focus".length) : undefined;
    if (viewId && state.viewProviders && state.viewProviders[viewId] && !(state.webviewViews || {})[viewId]) {
      const view = {
        description: "", shown: 0,
        webview: {
          html: "", options: {}, cspSource: "vscode-webview:", listeners: [],
          onDidReceiveMessage(l) { this.listeners.push(l); return { dispose() {} }; },
          send(msg) { return Promise.all(this.listeners.map((l) => l(msg))); },
        },
        show() { this.shown++; },
        onDidDispose() { return { dispose() {} }; },
      };
      state.webviewViews = Object.assign(state.webviewViews || {}, { [viewId]: view });
      state.viewProviders[viewId].resolveWebviewView(view);
      return Promise.resolve();
    }
    const fn = state.commands.get(id);
    return Promise.resolve(fn ? fn(...args) : undefined);
  },
};

const workspace = {
  applyEdit(edit) {
    // Applies replacements to files on disk, last first so offsets stay valid.
    const fs = require("fs");
    const byFile = new Map();
    for (const e of edit.edits) byFile.set(e.uri.fsPath, [...(byFile.get(e.uri.fsPath) || []), e]);
    for (const [file, edits] of byFile) {
      let text = fs.readFileSync(file, "utf8");
      const offset = (pos) => text.split("\n").slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.character;
      for (const e of edits.sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
        text = text.slice(0, offset(e.range.start)) + e.text + text.slice(offset(e.range.end));
      }
      fs.writeFileSync(file, text);
    }
    state.appliedEdits = (state.appliedEdits || []).concat(edit.edits);
    return Promise.resolve(true);
  },
  getConfiguration(section) {
    return {
      get: (key, def) => (`${section}.${key}` in state.config ? state.config[`${section}.${key}`] : key in state.config ? state.config[key] : def),
      inspect: (key) => ({ globalValue: (state.configGlobal || {})[`${section}.${key}`], workspaceValue: (state.configWorkspace || {})[`${section}.${key}`] }),
      update: (key, value, target) => {
        const store = target === 2 ? (state.configWorkspace = state.configWorkspace || {}) : (state.configGlobal = state.configGlobal || {});
        store[`${section}.${key}`] = value;
        return Promise.resolve();
      },
    };
  },
  get workspaceFolders() { return state.workspaceFolders.map((p) => ({ uri: Uri.file(p), name: path.basename(p) })); },
  registerTextDocumentContentProvider(scheme, p) { state.contentProviders[scheme] = p; return { dispose() {} }; },
  createFileSystemWatcher(pattern) {
    const w = { pattern, create: [], del: [], onDidCreate(l) { this.create.push(l); }, onDidDelete(l) { this.del.push(l); }, dispose() {} };
    state.watchers.push(w);
    return w;
  },
  onDidSaveTextDocument(l) { state.saveListeners = (state.saveListeners || []).concat(l); return { dispose() {} }; },
  onDidChangeTextDocument: ev(),
  onDidCloseTextDocument: ev(),
  onDidOpenTextDocument(l) { state.openListeners = (state.openListeners || []).concat(l); return { dispose() {} }; },
  onDidChangeWorkspaceFolders: ev(),
  onDidChangeConfiguration: ev(),
  textDocuments: [],
  openTextDocument(arg) {
    if (arg && arg.content !== undefined) {
      const doc = textDocument(new Uri("untitled", `Untitled-${(state.untitled = (state.untitled || 0) + 1)}`), arg.content, arg.language, true);
      state.createdDocs = (state.createdDocs || []).concat(doc);
      return Promise.resolve(doc);
    }
    // Like VS Code: an untitled document that's already open is returned as it is.
    const open = (state.createdDocs || []).find((d) => d.uri.toString() === arg.toString());
    if (open) return Promise.resolve(open);
    const provider = state.contentProviders[arg.scheme];
    const text = arg.scheme === "file" ? require("fs").readFileSync(arg.fsPath, "utf8") : provider ? provider.provideTextDocumentContent(arg) : "";
    const ext = (arg.path || "").split(".").pop();
    return Promise.resolve(textDocument(arg, text, { js: "javascript", ts: "typescript", sql: "sql", xml: "xml", cs: "csharp", md: "markdown" }[ext] || "plaintext", false));
  },
};

class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelToolResult { constructor(content) { this.content = content; } }

module.exports = {
  __state: state,
  LanguageModelTextPart, LanguageModelToolResult,
  lm: { registerTool(name, tool) { state.tools = state.tools || {}; state.tools[name] = tool; return { dispose() {} }; } },
  WorkspaceEdit, Uri, EventEmitter, TreeItem, ThemeIcon, ThemeColor, CodeLens, Range, RelativePattern, MarkdownString,
  CompletionItem, Hover, SnippetString,
  CompletionItemKind: { Field: 4, Property: 9, Module: 8, Event: 22, Struct: 21, Keyword: 13 },
  ViewColumn: { Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  extensions: { getExtension(id) { return (state.installedExtensions || []).includes(id) ? { id } : undefined; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window, commands, workspace,
  Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  languages: {
    createDiagnosticCollection(name) {
      const store = new Map();
      state.diagnostics = state.diagnostics || {};
      state.diagnostics[name] = store;
      return {
        set(uri, list) { store.set(uri.fsPath || String(uri), list); },
        delete(uri) { store.delete(uri.fsPath || String(uri)); },
        clear() { store.clear(); },
        get(uri) { return store.get(uri.fsPath || String(uri)); },
        dispose() {},
      };
    },
    registerCodeLensProvider(sel, p) { state.codeLensSelector = sel; state.codeLensProviders.push(p); return { dispose() {} }; },
    registerCompletionItemProvider(sel, p, ...triggers) {
      state.completionProviders = (state.completionProviders || []).concat({ sel, p, triggers });
      if (!state.completionProvider) { state.completionProvider = p; state.completionTriggers = triggers; }
      return { dispose() {} };
    },
    registerHoverProvider(sel, p) { state.hoverProvider = p; return { dispose() {} }; },
    setTextDocumentLanguage(doc, lang) { state.languageSet = (state.languageSet || []).concat([[doc.uri.fsPath, lang]]); return Promise.resolve(doc); },
  },
  env: {
    openExternal(u) { state.opened.push(u.toString()); return Promise.resolve(true); },
    clipboard: { writeText(t) { state.clipboard = t; return Promise.resolve(); }, readText() { return Promise.resolve(state.clipboard || ""); } },
  },
  authentication: {
    getAccounts() { return Promise.resolve((state.accounts || []).map((label) => ({ id: label, label }))); },
    getSession(provider, scopes, options) {
      state.lastScopes = scopes;
      state.sessionOptions = (state.sessionOptions || []).concat([options]);
      const label = (options && options.account && options.account.label) || state.newSignInAccount || "nathan@acme.com";
      if (options && options.clearSessionPreference && !(state.accounts || []).includes(label)) state.accounts = (state.accounts || []).concat(label);
      return Promise.resolve({ accessToken: "header.eyJleHAiOjQxMDI0NDQ4MDB9.sig", account: { id: label, label } });
    },
  },
};
