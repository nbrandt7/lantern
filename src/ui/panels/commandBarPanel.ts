import { EditProblem, ModernCommand, RibbonModel, RibbonProblem, RibbonRuleStep, ribbonChanges, ribbonEditProblems } from "../../core/ribbonModel";
import { openPanel, Problem, Status } from "./panel";

/**
 * The command bar (ribbon) of a table as an editor tab: on the left every location
 * (form, main grid, subgrid, and each app's modern command bar) with its tabs,
 * groups and controls, on the right the selected control with its command, the
 * command's actions and its enable and display rules in words, and a preview of the
 * bar it sits in. The client's own parts (what its RibbonDiffXml adds, and the modern
 * commands) can be edited, Microsoft's can be hidden; Save writes the RibbonDiffXml
 * to the solution folder, the modern commands to the environment, and can publish
 * the classic bar through a solution import. JavaScript references that don't resolve
 * in the workspace are warned about next to the action; what Dataverse would reject
 * blocks Save.
 */

export interface CommandBarDraft {
  model: RibbonModel;
  /** Publish the classic command bar to the environment after saving (export, patch, import, publish). */
  publish: boolean;
  /** The solution to publish through. */
  solution: string;
  /** Write the RibbonDiffXml to the local solution folder. */
  writeLocal: boolean;
}

export interface CommandBarState {
  subtitle: string;
  table: string;
  tableLabel: string;
  env: string;
  /** The client's local solutions whose RibbonDiffXml for the table was found, and those files. */
  localSolutions: string[];
  localFiles: string[];
  /** Where a new RibbonDiff.xml would be written when there's none. */
  localTarget?: string;
  /** The publisher prefix new Ids start with, when known. */
  prefix: string;
  /** Solutions the classic bar can be published through. */
  solutions: string[];
  /** Model-driven apps, for new modern commands. */
  apps: Array<{ id: string; name: string; uniqueName: string }>;
  /** Web resource names in the workspace: scripts for libraries, images for icons. */
  scripts: string[];
  images: string[];
  /** Rule kinds and their attributes, for the rule editor. */
  ruleKinds: Record<string, Array<{ name: string; options?: string[]; hint?: string }>>;
  parameterKinds: string[];
  crmParameters: string[];
  draft: CommandBarDraft;
}

export interface CommandBarHooks {
  /** Opens the library at the function (the client folder's copy, or a read-only copy from Dataverse). */
  open: (webResource: string, functionName: string) => Promise<void>;
  /** Opens a local file. */
  openFile: (file: string) => Promise<void>;
  /** An icon web resource as a data: URI, or undefined when it can't be found. */
  icon: (webResource: string) => Promise<string | undefined>;
  /** The JavaScript references of the model that don't resolve in the workspace. */
  check: (model: RibbonModel) => RibbonProblem[];
  /** A rule step in words. */
  explain: (step: RibbonRuleStep) => string;
  /** Saves. Returns a line to show in the footer when it couldn't go through. */
  submit: (draft: CommandBarDraft) => Promise<string | undefined>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The warning key the page puts each JavaScript reference problem under. */
export const problemKey = (p: RibbonProblem): string =>
  p.kind === "command" ? `action:${p.id}:${p.index}` : p.kind === "modern command" ? `modern:${p.id}` : `rule:${p.kind === "enable rule" ? "enable" : "display"}:${p.id}:${p.index}`;

/**
 * The footer's status: what blocks Save (keyed to its field), and the summary with the changes and the warnings.
 * `localSolution` is the solution whose RibbonDiffXml the page edits, when there's one.
 */
export function commandBarStatus(draft: CommandBarDraft, original: RibbonModel, prefix: string, references: RibbonProblem[], localSolution?: string): Status {
  const edit: EditProblem[] = ribbonEditProblems(draft.model, { prefix });
  const problems: Problem[] = edit.map((p) => ({ field: p.field, text: p.text }));
  const changes = ribbonChanges(original, draft.model);
  if (draft.publish && !draft.solution) problems.push({ field: "solution", text: "Pick the solution to publish through." });
  // The classic layer is that solution's RibbonDiffXml: published through another, it would end up in that one.
  else if (draft.publish && localSolution && draft.solution.toLowerCase() !== localSolution.toLowerCase() && ribbonChanges({ ...original, modern: [] }, { ...draft.model, modern: [] }).length) {
    problems.push({ field: "solution", text: `The RibbonDiffXml here is ${localSolution}'s: publish it through ${localSolution}.` });
  }
  const parts = [
    changes.length ? plural(changes.length, "change") : "No changes yet",
    references.length ? plural(references.length, "JavaScript warning") : "JavaScript references resolve",
  ];
  return { problems, summary: parts.join(" · "), blocked: !changes.length };
}

const BODY = `
<main class="split" id="main">
  <nav class="list" id="list" aria-label="Command bar">
    <div class="search"><span id="searchIcon"></span><input type="search" id="search" placeholder="Search buttons, commands, functions" aria-label="Search" /></div>
    <div class="options" id="options"></div>
    <div class="items" id="items"></div>
    <div class="actions" id="listActions"></div>
  </nav>
  <section class="form" id="form"></section>
</main>`;

const SCRIPT = `
  const LOCATION_LABELS = { Form: "Form", HomepageGrid: "Main grid", SubGrid: "Subgrid", Other: "Other" };
  const MODERN_LOCATIONS = { 0: "Form", 1: "Main grid", 2: "Subgrid", 3: "Associated grid", 4: "Quick form", 5: "Global header", 6: "Dashboard" };
  const MODERN_TYPES = { 0: "Button", 1: "Dropdown", 2: "Split button", 3: "Group" };
  const KIND_LABELS = { button: "Button", splitButton: "Split button", flyout: "Flyout", menuSection: "Menu section", toggleButton: "Toggle button", label: "Label", other: "Control" };
  const KIND_ICONS = { button: "event", splitButton: "list", flyout: "list", menuSection: "cls", toggleButton: "event", label: "info", other: "event" };
  // state and draft are declared by the shared script, which runs after this one, so they're only read inside build().
  let selected = "";
  let onlyMine = false;
  let lastStatus;
  let warnings = [];
  let rows = [];
  const iconCache = new Map();
  let checkTimer;

  const model = () => draft.model;
  const originText = (o) => (o === "client" ? (state.localSolutions.length ? "Your solution (" + state.localSolutions.join(", ") + ")" : "Your solution") : o === "microsoft" ? "Microsoft" : "Another solution, or the environment");
  const originTag = (o, extra) => h("span", { class: "tag" + (o === "client" ? " mine" : "") + (extra || "") }, o === "client" ? "yours" : o === "microsoft" ? "Microsoft" : "other");
  const isMine = (x) => x && x.origin === "client";
  const edited = () => { changed(); scheduleCheck(); };

  /** Problems (blocking) and warnings behind a control: its own fields, its command's actions and that command's rules. */
  const problemsOfControl = (c) => {
    const list = [];
    const all = (lastStatus ? lastStatus.problems : []).map((p) => ({ field: p.field, text: p.text })).concat(warnings.map((w) => ({ field: "w:" + w.key, text: w.text })));
    const cmd = c.command && model().commands[c.command];
    for (const p of all) {
      const f = p.field;
      if (f.startsWith("control:" + c.id + ":")) list.push(p);
      else if (cmd && (f.startsWith("command:" + cmd.id + ":") || f.startsWith("w:action:" + cmd.id + ":"))) list.push(p);
      else if (cmd) for (const kind of ["enable", "display"]) for (const id of cmd[kind + "Rules"]) if (f.startsWith("rule:" + kind + ":" + id + ":") || f.startsWith("w:rule:" + kind + ":" + id + ":")) list.push(p);
    }
    return list;
  };
  const problemsOfKey = (prefix) => (lastStatus ? lastStatus.problems : []).filter((p) => p.field.startsWith(prefix)).concat(warnings.filter((w) => ("w:" + w.key).startsWith(prefix)).map((w) => ({ field: "w:" + w.key, text: w.text })));
  const functionsOf = (c) => {
    const cmd = c.command && model().commands[c.command];
    if (!cmd) return [];
    const names = cmd.actions.map((a) => (a.functionName || "") + " " + (a.webResource || a.library || ""));
    for (const id of [...cmd.enableRules, ...cmd.displayRules]) { const r = model().enableRules[id] || model().displayRules[id]; if (r) for (const s of r.steps) if (s.functionName) names.push(s.functionName + " " + (s.webResource || "")); }
    return names;
  };

  function build() {
    document.getElementById("list").style.width = "380px";
    document.getElementById("searchIcon").innerHTML = ICONS.search;
    document.getElementById("search").addEventListener("input", renderList);
    document.getElementById("options").replaceChildren(
      checkbox("onlyMine", "Only my solution's", onlyMine, (v) => { onlyMine = v; renderList(); }, { hint: "Buttons, groups and tabs that your RibbonDiffXml adds, the controls it hides, and the modern commands." })
    );
    refreshList();
    selected = rows.some((r) => r.key === selected) ? selected : (rows.find((r) => r.kind === "control") || rows[0] || {}).key || "";
    show(selected);
    scheduleCheck();
  }
  function refreshList() { rows = flatten(); renderList(); renderListActions(); }
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => ask("check", { model: model() }).then((list) => { warnings = list || []; renderList(); showWarnings(); }).catch(() => undefined), 250);
  }

  /** Every row of the list in order, with the path above it. */
  function flatten() {
    const out = [];
    const m = model();
    const locations = [];
    for (const t of m.tabs) if (!locations.includes(t.location)) locations.push(t.location);
    for (const loc of locations) {
      out.push({ kind: "location", key: "loc:" + loc, label: LOCATION_LABELS[loc] || loc, location: loc });
      for (const t of m.tabs.filter((t) => t.location === loc)) {
        out.push({ kind: "tab", key: "tab:" + t.id, label: t.label, meta: t.id, ref: t, origin: t.origin, depth: 0, location: loc, mine: isMine(t) });
        for (const g of t.groups) {
          out.push({ kind: "group", key: "group:" + g.id, label: g.label, meta: g.id, ref: g, origin: g.origin, depth: 1, location: loc, tab: t, mine: isMine(g) });
          const walk = (c, depth) => {
            out.push({ kind: "control", key: "control:" + c.id, label: c.label || c.id, meta: c.command || (c.kind === "menuSection" ? "menu section" : "no command"), ref: c, origin: c.origin, depth, location: loc, tab: t, group: g, mine: isMine(c), functions: functionsOf(c) });
            for (const k of c.children) walk(k, depth + 1);
          };
          for (const c of g.controls) walk(c, 2);
        }
      }
      const hidden = m.hidden.filter((x) => (x.location || "").indexOf("." + loc + ".") >= 0 || (x.id || "").indexOf("." + loc + ".") >= 0 || (loc === "Other" && !/\\.(Form|HomepageGrid|SubGrid)\\./.test(x.location + x.id)));
      if (hidden.length) {
        out.push({ kind: "hiddenHead", key: "hiddenhead:" + loc, label: "Hidden by your solution", location: loc });
        for (const x of hidden) out.push({ kind: "hidden", key: "hidden:" + x.id, label: x.id.split(".").pop() || x.id, meta: x.id, ref: x, origin: x.origin, depth: 1, location: loc, mine: isMine(x) });
      }
    }
    const modern = m.modern.filter((x) => !x.removed);
    const groups = [];
    for (const x of modern) { const k = (x.app ? x.app.name : "All apps") + " · " + (MODERN_LOCATIONS[x.location] || x.location); if (!groups.includes(k)) groups.push(k); }
    for (const g of groups) {
      out.push({ kind: "location", key: "modernloc:" + g, label: "Modern · " + g });
      const inGroup = modern.filter((x) => (x.app ? x.app.name : "All apps") + " · " + (MODERN_LOCATIONS[x.location] || x.location) === g);
      const byParent = (parent, depth) => {
        for (const x of inGroup.filter((y) => (y.parentId || "") === (parent || "")).sort((a, b) => (a.sequence || 0) - (b.sequence || 0))) {
          out.push({ kind: "modern", key: "modern:" + (x.id || x.uniqueName), label: x.label || x.groupTitle || x.uniqueName, meta: (MODERN_TYPES[x.type] || "Button") + (x.hidden ? " · hidden" : "") + (x.onClick.type === 2 ? " · " + (x.onClick.functionName || "") : x.onClick.type === 1 ? " · Power Fx" : ""), ref: x, origin: "client", depth, mine: true, functions: x.onClick.functionName ? [x.onClick.functionName + " " + (x.onClick.library || "")] : [] });
          if (x.id) byParent(x.id, depth + 1);
        }
      };
      byParent("", 0);
    }
    const mineCommands = Object.values(m.commands).filter(isMine);
    const mineRules = [...Object.values(m.enableRules), ...Object.values(m.displayRules)].filter(isMine);
    if (mineCommands.length || mineRules.length) {
      out.push({ kind: "location", key: "defs", label: "Your commands and rules" });
      for (const c of mineCommands) out.push({ kind: "command", key: "command:" + c.id, label: c.id, meta: plural(c.actions.length, "action"), ref: c, origin: "client", depth: 0, mine: true, functions: c.actions.map((a) => (a.functionName || "") + " " + (a.webResource || "")) });
      for (const r of mineRules) out.push({ kind: "rule", key: "rule:" + r.kind + ":" + r.id, label: r.id, meta: r.kind + " rule · " + plural(r.steps.length, "step"), ref: r, origin: "client", depth: 0, mine: true, functions: r.steps.map((s) => (s.functionName || "") + " " + (s.webResource || "")) });
    }
    out.push({ kind: "location", key: "saveloc", label: "Saving" });
    out.push({ kind: "save", key: "save", label: "Save options", meta: draft.publish ? "publish to " + state.env : "local only", depth: 0, mine: false });
    return out;
  }

  function rowProblems(r) {
    if (r.kind === "control") return problemsOfControl(r.ref);
    if (r.kind === "command") return problemsOfKey("command:" + r.ref.id + ":").concat(problemsOfKey("w:action:" + r.ref.id + ":"));
    if (r.kind === "rule") return problemsOfKey("rule:" + r.ref.kind + ":" + r.ref.id + ":").concat(problemsOfKey("w:rule:" + r.ref.kind + ":" + r.ref.id + ":"));
    if (r.kind === "modern") return problemsOfKey("modern:" + (r.ref.id || r.ref.uniqueName) + ":").concat(problemsOfKey("w:modern:" + r.ref.uniqueName));
    if (r.kind === "save") return problemsOfKey("solution");
    return [];
  }

  function renderList() {
    const q = document.getElementById("search").value.trim().toLowerCase();
    const items = document.getElementById("items");
    const matches = (r) => {
      if (r.kind === "location" || r.kind === "hiddenHead") return false;
      if (onlyMine && !r.mine && r.kind !== "save") return false;
      if (!q) return true;
      return [r.label, r.meta, r.ref && r.ref.id, ...(r.functions || [])].filter(Boolean).join(" ").toLowerCase().includes(q);
    };
    const shown = new Set();
    rows.forEach((r, i) => {
      if (!matches(r)) return;
      shown.add(i);
      // The path above a match stays visible: its location, tab and group rows.
      for (let k = i - 1; k >= 0; k--) {
        const above = rows[k];
        if (above.kind === "location") { shown.add(k); break; }
        if (above.kind === "hiddenHead" && r.kind === "hidden") shown.add(k);
        if ((above.kind === "tab" || above.kind === "group") && (above.depth < (r.depth === undefined ? 9 : r.depth) || r.kind === "hidden")) shown.add(k);
      }
    });
    items.replaceChildren();
    if (!shown.size) { items.append(h("div", { class: "nothing" }, rows.length ? "Nothing matches." : "This table's command bar has no tabs at the form, main grid or subgrid locations.")); return; }
    rows.forEach((r, i) => {
      if (!shown.has(i)) return;
      if (r.kind === "location" || r.kind === "hiddenHead") { items.append(h("div", { class: "group" }, r.label)); return; }
      const problems = rowProblems(r);
      const bad = problems.length;
      const dim = r.kind === "control" && r.ref.kind === "menuSection";
      const iconName = r.kind === "tab" ? "package" : r.kind === "group" ? "cls" : r.kind === "hidden" ? "trash" : r.kind === "command" ? "event" : r.kind === "rule" ? "info" : r.kind === "save" ? "server" : r.kind === "modern" ? "event" : KIND_ICONS[r.ref.kind] || "event";
      items.append(h("div", { class: "item depth" + Math.min(r.depth || 0, 4) + (r.key === selected ? " selected" : "") + (dim ? " dim" : ""), "data-key": r.key, role: "button", tabindex: "0", title: r.meta || "", onclick: () => show(r.key), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(r.key); } } },
        icon(iconName),
        h("div", { class: "text" }, h("div", { class: "name" }, r.label + (r.ref && r.ref.localOnly ? " (local only)" : "") + (r.ref && r.ref.fresh ? " (new)" : "")), h("div", { class: "meta" }, r.meta || "")),
        r.mine ? originTag("client") : null,
        bad ? h("span", { class: "count" }, plural(problems.length, "problem")) : null,
        h("span", { class: "flag" }, bad ? h("span", { html: ICONS.warning, title: problems.map((p) => p.text).join("\\n") }) : "")));
    });
  }

  function renderListActions() {
    const row = rows.find((r) => r.key === selected);
    const group = row && (row.kind === "group" ? row.ref : row.kind === "control" ? row.group : undefined);
    const actions = document.getElementById("listActions");
    actions.replaceChildren(
      h("button", { class: "icon", type: "button", disabled: !group, title: group ? "Add a button to " + group.label : "Pick a group or a button first", onclick: () => addButton(group) }, h("span", { html: ICONS.add }), "Button"),
      h("button", { class: "icon", type: "button", title: "Add a modern command (an app's command bar)", onclick: addModern }, h("span", { html: ICONS.add }), "Modern command"),
      h("button", { class: "icon", type: "button", title: "Add a command definition", onclick: () => addCommand() }, h("span", { html: ICONS.add }), "Command"),
      h("button", { class: "icon", type: "button", title: "Add an enable or display rule", onclick: () => addRule("enable") }, h("span", { html: ICONS.add }), "Rule")
    );
  }

  const freshId = (base, taken) => { let id = base; for (let n = 2; taken.has(id); n++) id = base + n; return id; };
  const prefix = () => state.prefix || "new";
  const allControlIds = () => { const ids = new Set(); const walk = (c) => { ids.add(c.id); c.children.forEach(walk); }; for (const t of model().tabs) for (const g of t.groups) g.controls.forEach(walk); return ids; };

  function addButton(group) {
    const base = prefix() + "." + state.table + ".NewButton";
    const id = freshId(base, new Set([...allControlIds()].map((x) => x.replace(/\\.Button$/, "")))) + ".Button";
    const last = Math.max(0, ...group.controls.map((c) => c.sequence || 0));
    const c = { id, kind: "button", tag: "Button", attrs: { TemplateAlias: "o1" }, label: "New button", labelKey: "$LocLabels:" + id + ".LabelText", sequence: last + 10, children: [], origin: "client", localOnly: true, fresh: true };
    model().labels[id + ".LabelText"] = c.label;
    model().locLabels[id + ".LabelText"] = [{ languagecode: "1033", description: c.label }];
    group.controls.push(c);
    edited();
    refreshList();
    show("control:" + id);
    const label = document.getElementById("control:" + id + ":label");
    if (label) { label.focus(); label.select(); }
  }
  function addCommand(forControl) {
    const id = freshId(prefix() + "." + state.table + ".NewCommand", new Set(Object.keys(model().commands)));
    model().commands[id] = { id, enableRules: [], displayRules: [], actions: [{ kind: "JavaScriptFunction", functionName: "", library: "", webResource: "", parameters: [{ kind: "CrmParameter", value: "PrimaryControl" }], attrs: {} }], origin: "client", fresh: true };
    if (forControl) forControl.command = id;
    edited();
    refreshList();
    show("command:" + id);
  }
  function addRule(kind, forCommand) {
    const defs = kind === "enable" ? model().enableRules : model().displayRules;
    const id = freshId(prefix() + "." + state.table + (kind === "enable" ? ".CanRun" : ".Show"), new Set(Object.keys(defs)));
    defs[id] = { id, kind, steps: [], origin: "client", fresh: true };
    if (forCommand) forCommand[kind + "Rules"].push(id);
    edited();
    refreshList();
    show("rule:" + kind + ":" + id);
  }
  function addModern() {
    const taken = new Set(model().modern.map((x) => x.uniqueName));
    const uniqueName = freshId((state.prefix || "new") + "_" + state.table + "_NewCommand", taken);
    const m = { uniqueName, name: uniqueName, label: "New command", location: 0, type: 0, sequence: 10, app: state.apps[0] ? { id: state.apps[0].id, name: state.apps[0].name, uniqueName: state.apps[0].uniqueName } : undefined, hidden: false, disabled: false, onClick: { type: 2, functionName: "", library: "", parameters: "" }, visibility: { type: 0 }, icon: {}, fresh: true };
    model().modern.push(m);
    edited();
    refreshList();
    show("modern:" + uniqueName);
  }

  function show(key) {
    selected = key;
    remember();
    document.querySelectorAll("#items .item").forEach((e) => e.classList.toggle("selected", e.dataset.key === key));
    renderListActions();
    const row = rows.find((r) => r.key === key);
    const form = document.getElementById("form");
    if (!row) { form.replaceChildren(empty("list", "Nothing selected", "Pick a button on the left to see its command, actions and rules.")); return; }
    if (row.kind === "control") renderControl(row);
    else if (row.kind === "tab" || row.kind === "group") renderContainer(row);
    else if (row.kind === "hidden") renderHidden(row);
    else if (row.kind === "command") renderCommandPage(row.ref);
    else if (row.kind === "rule") renderRulePage(row.ref);
    else if (row.kind === "modern") renderModern(row.ref);
    else if (row.kind === "save") renderSave();
    if (lastStatus) showStatus(lastStatus);
    showWarnings();
  }
  function onStatus(status) {
    lastStatus = status;
    // Problems belong to fields; the ones not on the page right now are counted in the list, not spelled out in the footer.
    const left = document.getElementById("footerText");
    left.textContent = status.summary || "";
    left.className = "left" + (status.problems.length ? " error" : "");
    renderList();
  }
  /** JavaScript reference warnings next to their action or rule step. */
  function showWarnings() {
    document.querySelectorAll("[data-warning]").forEach((e) => { e.textContent = ""; });
    for (const w of warnings) {
      const slot = document.querySelector('[data-warning="' + CSS.escape(w.key) + '"]');
      if (slot) slot.replaceChildren(h("span", { html: ICONS.warning }), w.text, " ", w.file ? "" : "");
    }
  }
  const warningEl = (key) => h("div", { class: "problem warning", "data-warning": key });

  const staticRow = (label, value, opts = {}) => [h("label", { class: opts.top ? "top" : "" }, label), h("div", { class: "cell static" + (opts.mono ? " mono" : "") }, value === undefined || value === null || value === "" ? h("span", { class: "note" }, opts.none || "—") : value)];
  const openLink = (webResource, functionName) => h("button", { class: "link", type: "button", title: "Open " + webResource + " at " + functionName, onclick: () => ask("open", { webResource, functionName }).catch(() => undefined) }, "Open");
  const where = (row) => [LOCATION_LABELS[row.location] || row.location, row.tab && row.tab.label, row.group && row.group.label].filter(Boolean).join(" › ");
  const localFiles = () => (state.localFiles.length ? h("div", { class: "note" }, "Your RibbonDiffXml: ", ...state.localFiles.flatMap((f, i) => [i ? ", " : "", h("button", { class: "link", type: "button", onclick: () => ask("openFile", { file: f }).catch(() => undefined) }, f.split(/[\\\\/]/).slice(-3).join("/"))])) : null);
  const iconImg = (name) => {
    const img = h("img", { class: "iconimg", alt: "", width: "16", height: "16", hidden: true });
    if (!name) return img;
    const load = (uri) => { if (uri) { img.src = uri; img.hidden = false; } };
    if (iconCache.has(name)) load(iconCache.get(name));
    else ask("icon", { name }).then((uri) => { iconCache.set(name, uri || null); load(uri); }).catch(() => undefined);
    return img;
  };

  /** The bar a control sits in: every group of its tab with its buttons, the selected one highlighted. */
  function previewTab(tab, selectedId) {
    const bar = h("div", { class: "preview" });
    const hiddenIds = new Set(model().hidden.map((x) => x.id));
    for (const g of tab.groups) {
      const seg = h("div", { class: "pgroup" });
      const items = g.controls.filter((c) => !hiddenIds.has(c.id) && c.kind !== "label");
      for (const c of items) seg.append(previewButton(c, c.id === selectedId, () => show("control:" + c.id)));
      if (!items.length) seg.append(h("span", { class: "note" }, "empty"));
      bar.append(seg, h("div", { class: "pgrouplabel" }, g.label));
    }
    return h("div", { class: "previewwrap" }, h("div", { class: "previewtitle" }, "Preview · " + (LOCATION_LABELS[tab.location] || tab.location) + " · " + tab.label), bar);
  }
  function previewButton(c, isSelected, onClick) {
    const iconName = c.image16 && /^\\$webresource:/i.test(c.image16) ? c.image16.replace(/^\\$webresource:/i, "") : "";
    const b = h("button", { type: "button", class: "pbtn" + (isSelected ? " selected" : "") + (c.origin === "client" ? " mine" : "") + (c.localOnly ? " local" : ""), title: c.id, onclick: onClick },
      iconName ? iconImg(iconName) : c.modernImage ? h("span", { class: "picon", title: "ModernImage " + c.modernImage }, c.modernImage.slice(0, 2)) : h("span", { class: "picon dim" }, "•"),
      h("span", {}, c.label || c.id.split(".").pop()),
      c.kind === "splitButton" || c.kind === "flyout" ? h("span", { class: "chev" }, "▾") : null);
    return b;
  }
  function previewModern(cmd) {
    const bar = h("div", { class: "preview" });
    const same = model().modern.filter((x) => !x.removed && !x.parentId && x.location === cmd.location && ((x.app && x.app.id) || "") === ((cmd.app && cmd.app.id) || "")).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    const seg = h("div", { class: "pgroup" });
    for (const x of same) {
      const b = h("button", { type: "button", class: "pbtn mine" + (x === cmd ? " selected" : "") + (x.hidden ? " off" : ""), title: x.uniqueName, onclick: () => show("modern:" + (x.id || x.uniqueName)) },
        x.icon.webResource ? iconImg(x.icon.webResource) : h("span", { class: "picon", title: x.icon.fontIcon || "" }, (x.icon.fontIcon || "•").slice(0, 2)), h("span", {}, x.label || x.groupTitle || x.uniqueName), x.type === 1 || x.type === 2 ? h("span", { class: "chev" }, "▾") : null);
      seg.append(b);
    }
    bar.append(seg, h("div", { class: "pgrouplabel" }, "modern commands of this app at this location (classic buttons still show beside them)"));
    return h("div", { class: "previewwrap" }, h("div", { class: "previewtitle" }, "Preview · " + (cmd.app ? cmd.app.name : "All apps") + " · " + (MODERN_LOCATIONS[cmd.location] || cmd.location)), bar);
  }

  /** Setting a client control's text keeps its LocLabel in step (the key is created when the control had none). */
  function setLabel(c, what, value) {
    const prop = what === "LabelText" ? "label" : what === "ToolTipTitle" ? "tooltipTitle" : "tooltipDescription";
    const keyProp = what === "LabelText" ? "labelKey" : what === "ToolTipTitle" ? "tooltipTitleKey" : "tooltipDescriptionKey";
    c[prop] = value;
    if (!value && what !== "LabelText") { c[keyProp] = undefined; return; }
    let key = c[keyProp] && /^\\$LocLabels:(.+)$/i.exec(c[keyProp]);
    let id = key ? key[1] : c.id + "." + what;
    c[keyProp] = "$LocLabels:" + id;
    model().labels[id] = value;
    const titles = model().locLabels[id] || [];
    const en = titles.find((t) => t.languagecode === "1033") || titles[0];
    if (en) en.description = value; else titles.push({ languagecode: "1033", description: value });
    model().locLabels[id] = titles;
  }
  function renameControl(c, id) {
    c.id = id;
    // Its labels follow the Id (only a new control is renamed, and its label keys are the page's own), but never onto a
    // key that's taken: typing passes through other controls' Ids, whose labels stay theirs. A clashing Id is a problem on the field.
    for (const [prop, what] of [["labelKey", "LabelText"], ["tooltipTitleKey", "ToolTipTitle"], ["tooltipDescriptionKey", "ToolTipDescription"]]) {
      const key = c[prop] && /^\\$LocLabels:(.+)$/i.exec(c[prop]);
      const from = key && key[1];
      const to = id + "." + what;
      if (!from || from === to || !from.endsWith("." + what) || to in model().labels || to in model().locLabels) continue;
      c[prop] = "$LocLabels:" + to;
      model().labels[to] = model().labels[from];
      model().locLabels[to] = model().locLabels[from];
      delete model().labels[from];
      delete model().locLabels[from];
    }
    selected = "control:" + id;
  }
  function removeControl(c) {
    const walk = (list) => { const i = list.indexOf(c); if (i >= 0) { list.splice(i, 1); return true; } return list.some((k) => walk(k.children)); };
    for (const t of model().tabs) for (const g of t.groups) if (walk(g.controls)) break;
    edited();
    refreshList();
    show(rows[0] ? rows.find((r) => r.kind === "control") ? rows.find((r) => r.kind === "control").key : rows[0].key : "");
  }
  const hideLocation = (row) => (row.group ? row.group.id : row.ref.id) + ".Controls._children";
  const commandOptions = (current) => [{ value: "", label: "(none)" }, ...Object.values(model().commands).map((c) => ({ value: c.id, label: c.id, description: c.origin === "client" ? "yours" : c.origin })).sort((a, b) => a.label.localeCompare(b.label)), { value: "*new", label: "New command…" }];

  function renderControl(row) {
    const c = row.ref;
    const form = document.getElementById("form");
    const mine = isMine(c);
    const key = (f) => "control:" + c.id + ":" + f;
    const sections = [previewTab(row.tab, c.id), h("h2", {}, KIND_LABELS[c.kind] || "Control")];
    if (mine && c.kind !== "menuSection") {
      const grid = h("div", { class: "grid" },
        ...field("Label", text(key("label"), c.label, { set: (v) => { setLabel(c, "LabelText", v); edited(); renderList(); } }), { key: key("label") }),
        ...field("Tooltip title", text(key("tooltipTitle"), c.tooltipTitle || "", { set: (v) => { setLabel(c, "ToolTipTitle", v); edited(); } })),
        ...field("Tooltip text", text(key("tooltipDescription"), c.tooltipDescription || "", { set: (v) => { setLabel(c, "ToolTipDescription", v); edited(); } })),
        ...(c.fresh ? field("Id", text(key("id"), c.id, { set: (v) => { renameControl(c, v.trim()); edited(); refreshList(); } }), { key: key("id"), hint: "Unique in the ribbon; start it with your publisher prefix. Fixed once saved." }) : staticRow("Id", c.id, { mono: true })),
        ...staticRow("Where", where(row)),
        ...field("Sequence", text(key("sequence"), c.sequence === undefined ? "" : String(c.sequence), { type: "number", min: 0, set: (v) => { c.sequence = v.trim() === "" ? undefined : Number(v); edited(); renderList(); } }), { key: key("sequence"), hint: "Buttons in a group show lowest first. Microsoft's go 10, 20, 30…" }),
        ...field("Command", select(key("command"), c.command || "", commandOptions(c.command), (v) => { if (v === "*new") { addCommand(c); return; } c.command = v || undefined; edited(); refreshList(); renderControl(row); }), { key: key("command"), hint: "What the button runs and when it's enabled or shown." })
      );
      const icons = h("div", { class: "grid" },
        ...field("Modern icon", text(key("modernImage"), c.modernImage || "", { placeholder: "A Fluent icon name, like Save or Approve", set: (v) => { c.modernImage = v.trim() || undefined; edited(); renderControl(row); } }), { hint: "The icon name the Unified Interface uses; it isn't previewed here (the icon font isn't in the file)." }),
        ...field("Icon 16×16", pick(key("image16"), c.image16 ? c.image16.replace(/^\\$webresource:/i, "") : "", { options: state.images.map((n) => ({ id: n, label: n })), placeholder: "An image web resource (svg or png)", noneText: "No image web resource by that name in the workspace", set: (o) => { c.image16 = "$webresource:" + o.id; edited(); renderControl(row); }, typed: (v) => { c.image16 = v.trim() ? (/^\\$webresource:|^\\//i.test(v) ? v.trim() : "$webresource:" + v.trim()) : undefined; edited(); } }), { hint: "The classic ribbon's small icon; the Unified Interface uses the modern icon or this one as an SVG." }),
        ...field("Icon 32×32", pick(key("image32"), c.image32 ? c.image32.replace(/^\\$webresource:/i, "") : "", { options: state.images.map((n) => ({ id: n, label: n })), placeholder: "Optional", noneText: "No image web resource by that name in the workspace", set: (o) => { c.image32 = "$webresource:" + o.id; edited(); renderControl(row); }, typed: (v) => { c.image32 = v.trim() ? (/^\\$webresource:|^\\//i.test(v) ? v.trim() : "$webresource:" + v.trim()) : undefined; edited(); } }))
      );
      sections.push(grid, h("h2", {}, "Icon"), icons);
      if (c.localOnly && !c.fresh) sections.push(h("p", { class: "problem" }, h("span", { html: ICONS.warning }), "In your RibbonDiffXml but not in the environment's command bar yet: save with Publish, or import the solution."));
      const lf = localFiles();
      if (lf) sections.push(lf);
      sections.push(h("p", {}, h("button", { class: "icon", type: "button", onclick: () => { if (c.children.length && !confirm("Remove the button and its menu?")) return; removeControl(c); } }, h("span", { html: ICONS.trash }), "Remove button")));
    } else {
      const grid = h("div", { class: "grid" },
        ...staticRow("Label", c.label, { none: "(no label)" }),
        ...(c.labelKey && c.labelKey !== c.label ? staticRow("Label key", c.labelKey, { mono: true }) : []),
        ...(c.tooltipTitle || c.tooltipDescription ? staticRow("Tooltip", [c.tooltipTitle, c.tooltipDescription].filter(Boolean).join(" — ")) : []),
        ...staticRow("Id", c.id, { mono: true }),
        ...staticRow("Where", where(row)),
        ...staticRow("Sequence", c.sequence === undefined ? "" : String(c.sequence)),
        ...(c.kind !== "menuSection" ? staticRow("Icon", h("span", { class: "row cell" }, c.image16 && /^\\$webresource:/i.test(c.image16) ? iconImg(c.image16.replace(/^\\$webresource:/i, "")) : null, h("span", {}, [c.modernImage && "modern: " + c.modernImage, c.image16 && "16×16: " + c.image16, c.image32 && "32×32: " + c.image32].filter(Boolean).join(" · ") || "none")), {}) : []),
        ...staticRow("From", h("span", {}, originText(c.origin), " ", originTag(c.origin)))
      );
      sections.push(grid);
      if (c.kind !== "menuSection" && row.depth === 2) {
        const hiddenAt = model().hidden.find((x) => x.id === c.id);
        sections.push(h("p", { class: "note" }, mine ? "" : "Microsoft's and other solutions' buttons can't be changed here: hide this one and add your own, or customise it in the Ribbon Workbench."),
          h("p", {}, hiddenAt
            ? h("button", { class: "icon", type: "button", onclick: () => { model().hidden = model().hidden.filter((x) => x !== hiddenAt); edited(); refreshList(); renderControl(row); } }, "Unhide")
            : h("button", { class: "icon", type: "button", onclick: () => { model().hidden.push({ id: c.id, location: hideLocation(row), origin: "client" }); edited(); refreshList(); renderControl(row); } }, h("span", { html: ICONS.trash }), "Hide this button")));
      }
    }
    if (c.populateQueryCommand) sections.push(h("p", { class: "note" }, "The menu is filled at runtime by the command " + c.populateQueryCommand + "."));
    if (c.children.length) sections.push(h("p", { class: "note" }, plural(c.children.reduce((n, k) => n + (k.kind === "menuSection" ? k.children.length : 1), 0), "menu item") + " below it in the list."));
    if (c.command) sections.push(...renderCommand(c.command, mine));
    else if (c.kind !== "menuSection" && !mine) sections.push(h("h2", {}, "Command"), h("p", { class: "note" }, "No command: the control does nothing when clicked."));
    form.replaceChildren(...sections);
  }

  const libraryPick = (id, a, set) => pick(id, a.webResource || a.library || "", { options: state.scripts.map((n) => ({ id: n, label: n })), placeholder: "A JavaScript web resource", noneText: "No script by that name in the workspace; type the web resource's name", set: (o) => set(o.id), typed: (v) => set(v.trim()) });
  const parametersEditor = (list, keyPrefix) => {
    const root = h("div", {});
    const render = () => {
      root.replaceChildren(
        ...list.map((p, i) => h("div", { class: "row cell" },
          select(keyPrefix + ":p" + i + ":kind", p.kind, state.parameterKinds.map((k) => ({ value: k, label: k.replace(/Parameter$/, "") })), (v) => { p.kind = v; edited(); }),
          p.kind === "CrmParameter"
            ? select(keyPrefix + ":p" + i + ":value", p.value, (state.crmParameters.includes(p.value) ? state.crmParameters : [p.value, ...state.crmParameters]).map((v) => ({ value: v, label: v })), (v) => { p.value = v; edited(); })
            : text(keyPrefix + ":p" + i + ":value", p.value, { placeholder: "Value", set: (v) => { p.value = v; edited(); } }),
          h("button", { class: "icon", type: "button", title: "Remove parameter", onclick: () => { list.splice(i, 1); edited(); render(); } }, h("span", { html: ICONS.trash })))),
        h("button", { class: "link", type: "button", onclick: () => { list.push({ kind: "CrmParameter", value: "PrimaryControl" }); edited(); render(); } }, "Add parameter"));
    };
    render();
    return root;
  };
  function removeCommand(cmd) {
    delete model().commands[cmd.id];
    const walk = (c) => { if (c.command === cmd.id) c.command = undefined; c.children.forEach(walk); };
    for (const t of model().tabs) for (const g of t.groups) g.controls.forEach(walk);
    edited();
    refreshList();
    show(rows.find((r) => r.kind === "control") ? rows.find((r) => r.kind === "control").key : "");
  }
  function renameRecord(records, item, id, refs) {
    // Typing passes through other records' Ids: one that's taken isn't overwritten. The record keeps its own Id, and the
    // clash is a problem on the field until the Id changes.
    if (records[id] && records[id] !== item) { item.takenId = id; return; }
    delete item.takenId;
    if (id === item.id) return;
    delete records[item.id];
    const old = item.id;
    item.id = id;
    records[id] = item;
    refs(old, id);
  }

  /** The command's block: editable when it's the client's. */
  function renderCommand(id, editable) {
    const m = model();
    const cmd = m.commands[id];
    const out = [h("h2", {}, "Command")];
    if (!cmd) {
      out.push(h("div", { class: "block" }, h("div", { class: "head" }, h("span", { class: "id" }, id)), h("div", { class: "note" }, "Not defined in this table's ribbon: it comes from the application ribbon, which this page doesn't load.")));
      return out;
    }
    const mine = isMine(cmd);
    const key = (f) => "command:" + cmd.id + ":" + f;
    const block = h("div", { class: "block" }, h("div", { class: "head" }, h("span", { class: "id" }, cmd.id), originTag(cmd.origin), mine && editable !== false ? h("button", { class: "link", type: "button", onclick: () => show("command:" + cmd.id) }, "Edit") : null, problemEl(key("actions"))));
    if (!cmd.actions.length) block.append(h("div", { class: "note" }, "No actions."));
    cmd.actions.forEach((a, i) => {
      const g = h("div", { class: "grid" });
      g.append(...staticRow("Action", a.kind === "JavaScriptFunction" ? "JavaScript function" : a.kind === "Url" ? "Open a URL" : a.kind === "OpenDialog" ? "Open a dialog" : a.kind));
      if (a.kind === "JavaScriptFunction") {
        g.append(...staticRow("Function", a.functionName, { mono: true }));
        const lib = h("span", { class: "row cell" }, h("span", { class: "mono" }, a.webResource || a.library || ""), a.webResource ? openLink(a.webResource, a.functionName || "") : h("span", { class: "tag" }, a.library === "isNaN" || !a.library ? "built-in no-op" : "platform script"));
        g.append(h("label", {}, "Library"), h("div", { class: "cell" }, lib, warningEl("action:" + cmd.id + ":" + i)));
      } else if (a.kind === "Url") g.append(...staticRow("Address", a.url, { mono: true }));
      else if (a.kind === "OpenDialog") g.append(...staticRow("Dialog", a.attrs.DialogId || a.attrs.Address || "", { mono: true }));
      else g.append(...staticRow("Details", Object.entries(a.attrs).map(([k, v]) => k + "=" + v).join(", "), { mono: true }));
      if (a.parameters.length) g.append(h("label", { class: "top" }, "Parameters"), h("div", { class: "cell" }, h("ul", { class: "plain" }, a.parameters.map((p) => h("li", {}, h("span", { class: "mono" }, p.value), " ", h("span", { class: "note" }, "(" + p.kind.replace(/Parameter$/, "") + (p.name ? ", " + p.name : "") + ")"))))));
      block.append(g);
    });
    out.push(block);
    out.push(h("h2", {}, "Enable rules"), ...renderRules(cmd.enableRules, m.enableRules, "enable", "No enable rules: always enabled."));
    out.push(h("h2", {}, "Display rules"), ...renderRules(cmd.displayRules, m.displayRules, "display", "No display rules: always shown."));
    return out;
  }

  function renderRules(ids, defs, kind, none) {
    if (!ids.length) return [h("p", { class: "note" }, none)];
    return ids.map((id) => {
      const r = defs[id];
      const block = h("div", { class: "block" }, h("div", { class: "head" }, h("span", { class: "id" }, id), r ? originTag(r.origin) : h("span", { class: "tag off" }, "not in this ribbon"), r && isMine(r) ? h("button", { class: "link", type: "button", onclick: () => show("rule:" + kind + ":" + id) }, "Edit") : null));
      if (!r) { block.append(h("div", { class: "note" }, "Defined in the application ribbon or missing; the button falls back to the platform's default.")); return block; }
      if (!r.steps.length) block.append(h("div", { class: "note" }, "An empty rule: always " + (kind === "enable" ? "enabled" : "shown") + "."));
      block.append(h("ul", { class: "plain" }, r.steps.map((s, i) => h("li", {},
        h("span", {}, s.text), " ", h("span", { class: "note" }, "(" + s.kind + ")"),
        s.webResource ? h("span", {}, " ", openLink(s.webResource, s.functionName || "")) : null,
        s.parameters && s.parameters.length ? h("div", { class: "note" }, "Parameters: " + s.parameters.map((p) => p.value).join(", ")) : null,
        s.kind === "CustomRule" ? warningEl("rule:" + kind + ":" + id + ":" + i) : null))));
      if (r.steps.length > 1) block.append(h("div", { class: "note" }, "All of these have to hold."));
      return block;
    });
  }

  /** A client command's own page: actions and rules, editable. */
  function renderCommandPage(cmd) {
    const form = document.getElementById("form");
    const key = (f) => "command:" + cmd.id + ":" + f;
    const users = [];
    const walk = (c) => { if (c.command === cmd.id) users.push(c.label || c.id); c.children.forEach(walk); };
    for (const t of model().tabs) for (const g of t.groups) g.controls.forEach(walk);
    const head = h("div", { class: "grid" },
      ...(cmd.fresh ? field("Id", text(key("id"), cmd.takenId || cmd.id, { set: (v) => { renameRecord(model().commands, cmd, v.trim(), (o, n) => { const w = (c) => { if (c.command === o) c.command = n; c.children.forEach(w); }; for (const t of model().tabs) for (const g of t.groups) g.controls.forEach(w); }); selected = "command:" + cmd.id; edited(); refreshList(); } }), { key: key("id"), hint: "Start it with your publisher prefix. Fixed once saved." }) : staticRow("Id", cmd.id, { mono: true })),
      ...staticRow("Used by", users.length ? users.join(", ") : "", { none: "no button yet" })
    );
    const actions = h("div", {});
    const renderActions = () => {
      actions.replaceChildren(...cmd.actions.map((a, i) => {
        const g = h("div", { class: "grid" },
          ...field("Action", select(key("action:" + i + ":kind"), a.kind, [{ value: "JavaScriptFunction", label: "JavaScript function" }, { value: "Url", label: "Open a URL" }], (v) => { a.kind = v; if (v === "Url" && !a.url) a.url = ""; edited(); renderActions(); }))
        );
        if (a.kind === "JavaScriptFunction") {
          g.append(
            ...field("Function", text(key("action:" + i + ":function"), a.functionName || "", { placeholder: "Acme.Account.approve", set: (v) => { a.functionName = v.trim(); edited(); } }), { key: key("action:" + i + ":function") }),
            h("label", {}, "Library"), h("div", { class: "cell" }, h("div", { class: "row cell" }, libraryPick(key("action:" + i + ":library"), a, (name) => { a.webResource = name; a.library = name ? "$webresource:" + name : ""; edited(); }), a.webResource ? openLink(a.webResource, a.functionName || "") : null), problemEl(key("action:" + i + ":library")), warningEl("action:" + cmd.id + ":" + i)),
            ...field("Parameters", parametersEditor(a.parameters, key("action:" + i)), { top: true, hint: "Passed to the function in this order. PrimaryControl is the form or grid context." })
          );
        } else {
          g.append(...field("Address", text(key("action:" + i + ":url"), a.url || "", { placeholder: "https://…", set: (v) => { a.url = v.trim(); edited(); } }), { key: key("action:" + i + ":url") }),
            h("label", {}, ""), h("div", { class: "cell" }, checkbox(key("action:" + i + ":pass"), "Pass record parameters in the URL", a.attrs.PassParams === "true", (v) => { a.attrs.PassParams = v ? "true" : "false"; edited(); })));
        }
        return h("div", { class: "block" }, h("div", { class: "head" }, "Action " + (i + 1), h("button", { class: "link", type: "button", onclick: () => { cmd.actions.splice(i, 1); edited(); renderActions(); } }, "Remove")), g);
      }), h("button", { class: "link", type: "button", onclick: () => { cmd.actions.push({ kind: "JavaScriptFunction", functionName: "", library: "", webResource: "", parameters: [{ kind: "CrmParameter", value: "PrimaryControl" }], attrs: {} }); edited(); renderActions(); } }, "Add action"), problemEl(key("actions")));
    };
    renderActions();
    const rulesPicker = (kind) => {
      const defs = kind === "enable" ? model().enableRules : model().displayRules;
      const picked = new Set(cmd[kind + "Rules"]);
      const items = Object.values(defs).map((r) => ({ id: r.id, label: r.id, meta: r.steps.map((s) => s.text).join(" ") || "(empty)", tags: r.origin === "client" ? ["yours"] : [], group: r.origin === "client" ? "Yours" : r.origin === "microsoft" ? "Microsoft" : "Other" })).sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
      const list = checklist(items, picked, { placeholder: "Search rules", noneText: kind === "enable" ? "none: always enabled" : "none: always shown", onChange: () => { cmd[kind + "Rules"] = items.map((i) => i.id).filter((i) => picked.has(i)); edited(); } });
      return h("div", {}, list, h("div", { class: "note" }, h("button", { class: "link", type: "button", onclick: () => addRule(kind, cmd) }, "New " + kind + " rule")), problemEl(key(kind + "Rules")));
    };
    form.replaceChildren(
      h("h2", {}, "Command"), head,
      h("h2", {}, "Actions"), actions,
      h("h2", {}, "Enable rules"), rulesPicker("enable"),
      h("h2", {}, "Display rules"), rulesPicker("display"),
      h("p", {}, h("button", { class: "icon", type: "button", onclick: () => { if (users.length && !confirm("Remove the command? " + users.join(", ") + " would be left without one.")) return; removeCommand(cmd); } }, h("span", { html: ICONS.trash }), "Remove command"))
    );
  }

  /** A client rule's own page: its steps, each with the attributes its kind takes. */
  function renderRulePage(r) {
    const form = document.getElementById("form");
    const defs = r.kind === "enable" ? model().enableRules : model().displayRules;
    const key = (f) => "rule:" + r.kind + ":" + r.id + ":" + f;
    const users = Object.values(model().commands).filter((c) => c[r.kind + "Rules"].includes(r.id)).map((c) => c.id);
    const head = h("div", { class: "grid" },
      ...(r.fresh ? field("Id", text(key("id"), r.takenId || r.id, { set: (v) => { renameRecord(defs, r, v.trim(), (o, n) => { for (const c of Object.values(model().commands)) c[r.kind + "Rules"] = c[r.kind + "Rules"].map((x) => (x === o ? n : x)); }); selected = "rule:" + r.kind + ":" + r.id; edited(); refreshList(); } }), { key: key("id"), hint: "Start it with your publisher prefix. Fixed once saved." }) : staticRow("Id", r.id, { mono: true })),
      ...field("Kind", select(key("kind"), r.kind, [{ value: "enable", label: "Enable rule", description: "the button is enabled when it holds" }, { value: "display", label: "Display rule", description: "the button is shown when it holds" }], (v) => {
        if (v === r.kind) return;
        delete defs[r.id];
        for (const c of Object.values(model().commands)) c[r.kind + "Rules"] = c[r.kind + "Rules"].filter((x) => x !== r.id);
        r.kind = v;
        (v === "enable" ? model().enableRules : model().displayRules)[r.id] = r;
        selected = "rule:" + v + ":" + r.id;
        edited(); refreshList(); renderRulePage(r);
      }), { hint: r.fresh ? "" : "Changing it removes the rule from the commands that use it." }),
      ...staticRow("Used by", users.join(", "), { none: "no command yet" })
    );
    const steps = h("div", {});
    const explain = (s, out) => ask("explain", { step: s }).then((t) => { s.text = t; out.textContent = t; }).catch(() => undefined);
    const renderSteps = () => {
      steps.replaceChildren(...r.steps.map((s, i) => {
        const words = h("div", { class: "note" }, s.text || "");
        const g = h("div", { class: "grid" });
        const kinds = Object.keys(state.ruleKinds);
        g.append(...field("Rule", select(key("step:" + i + ":kind"), s.kind, (kinds.includes(s.kind) ? kinds : [s.kind, ...kinds]).map((k) => ({ value: k, label: k })), (v) => { s.kind = v; s.attrs = {}; s.parameters = v === "CustomRule" ? [{ kind: "CrmParameter", value: "PrimaryControl" }] : []; if (v !== "CustomRule") { s.functionName = undefined; s.library = undefined; s.webResource = undefined; } edited(); renderSteps(); })));
        if (s.kind === "CustomRule") {
          g.append(
            ...field("Function", text(key("step:" + i + ":function"), s.functionName || "", { placeholder: "Acme.Account.canApprove", set: (v) => { s.functionName = v.trim(); edited(); explain(s, words); } }), { key: key("step:" + i + ":function"), hint: "Returns true or false; the command bar waits for it." }),
            h("label", {}, "Library"), h("div", { class: "cell" }, h("div", { class: "row cell" }, libraryPick(key("step:" + i + ":library"), s, (name) => { s.webResource = name; s.library = name ? "$webresource:" + name : ""; edited(); explain(s, words); }), s.webResource ? openLink(s.webResource, s.functionName || "") : null), problemEl(key("step:" + i + ":library")), warningEl("rule:" + r.kind + ":" + r.id + ":" + i)),
            ...field("Parameters", parametersEditor(s.parameters, key("step:" + i)), { top: true })
          );
        }
        for (const a of state.ruleKinds[s.kind] || []) {
          const control = a.options
            ? select(key("step:" + i + ":" + a.name), s.attrs[a.name] || "", a.options.map((o) => ({ value: o, label: o || "(not set)" })), (v) => { if (v) s.attrs[a.name] = v; else delete s.attrs[a.name]; edited(); explain(s, words); })
            : text(key("step:" + i + ":" + a.name), s.attrs[a.name] || "", { set: (v) => { if (v.trim()) s.attrs[a.name] = v.trim(); else delete s.attrs[a.name]; edited(); explain(s, words); } });
          g.append(...field(a.name === "InvertResult" ? "Invert" : a.name, control, { key: key("step:" + i + ":" + a.name), hint: a.hint }));
        }
        if (!(s.kind in state.ruleKinds)) for (const [k, v] of Object.entries(s.attrs)) g.append(...field(k, text(key("step:" + i + ":" + k), v, { set: (val) => { s.attrs[k] = val; edited(); explain(s, words); } })));
        return h("div", { class: "block" }, h("div", { class: "head" }, "Step " + (i + 1), h("button", { class: "link", type: "button", onclick: () => { r.steps.splice(i, 1); edited(); renderSteps(); } }, "Remove")), g, words);
      }), h("button", { class: "link", type: "button", onclick: () => { const s = { kind: "CustomRule", attrs: {}, functionName: "", library: "", webResource: "", parameters: [{ kind: "CrmParameter", value: "PrimaryControl" }], text: "" }; r.steps.push(s); edited(); renderSteps(); } }, "Add step"), problemEl(key("steps")), r.steps.length > 1 ? h("div", { class: "note" }, "All steps have to hold.") : null);
    };
    renderSteps();
    form.replaceChildren(h("h2", {}, (r.kind === "enable" ? "Enable" : "Display") + " rule"), head, h("h2", {}, "Steps"), steps,
      h("p", {}, h("button", { class: "icon", type: "button", onclick: () => { delete defs[r.id]; for (const c of Object.values(model().commands)) c[r.kind + "Rules"] = c[r.kind + "Rules"].filter((x) => x !== r.id); edited(); refreshList(); show(rows.find((x) => x.kind === "control") ? rows.find((x) => x.kind === "control").key : ""); } }, h("span", { html: ICONS.trash }), "Remove rule")));
  }

  function renderContainer(row) {
    const x = row.ref;
    const form = document.getElementById("form");
    const kids = row.kind === "tab" ? plural(x.groups.length, "group") : plural(x.controls.length, "control");
    const sections = [previewTab(row.kind === "tab" ? x : row.tab, ""), h("h2", {}, row.kind === "tab" ? "Tab" : "Group"), h("div", { class: "grid" },
      ...staticRow("Label", x.label),
      ...(x.labelKey && x.labelKey !== x.label ? staticRow("Label key", x.labelKey, { mono: true }) : []),
      ...staticRow("Id", x.id, { mono: true }),
      ...staticRow("Where", row.kind === "tab" ? LOCATION_LABELS[row.location] || row.location : where(row)),
      ...staticRow("Sequence", x.sequence === undefined ? "" : String(x.sequence)),
      ...staticRow("Contains", kids),
      ...staticRow("From", h("span", {}, originText(x.origin), " ", originTag(x.origin))))];
    if (row.kind === "group") sections.push(h("p", {}, h("button", { class: "icon", type: "button", onclick: () => addButton(x) }, h("span", { html: ICONS.add }), "Add button to this group")));
    if (x.command) sections.push(...renderCommand(x.command, false));
    form.replaceChildren(...sections);
  }

  function renderHidden(row) {
    const x = row.ref;
    const form = document.getElementById("form");
    form.replaceChildren(h("h2", {}, "Hidden control"), h("div", { class: "grid" },
      ...staticRow("Id", x.id, { mono: true }),
      ...staticRow("Location", x.location, { mono: true }),
      ...staticRow("From", h("span", {}, originText(x.origin), " ", originTag(x.origin)))),
      h("p", { class: "note" }, "A HideCustomAction in " + (isMine(x) ? "your" : "another solution's") + " RibbonDiffXml removes this control, so the environment's command bar no longer has it."), localFiles() || "",
      // Another solution's hide is in its own file, which saving here doesn't write.
      isMine(x) ? h("p", {}, h("button", { class: "icon", type: "button", onclick: () => { model().hidden = model().hidden.filter((y) => y !== x); edited(); refreshList(); show(rows[0] ? rows[0].key : ""); } }, "Unhide")) : "");
  }

  function renderModern(m) {
    const form = document.getElementById("form");
    const key = (f) => "modern:" + (m.id || m.uniqueName) + ":" + f;
    const grid = h("div", { class: "grid" },
      ...field("Label", text(key("label"), m.label, { set: (v) => { m.label = v; if (!m.name || m.fresh) m.name = v || m.uniqueName; edited(); renderList(); } }), { key: key("label") }),
      ...field("Tooltip title", text(key("tooltipTitle"), m.tooltipTitle || "", { set: (v) => { m.tooltipTitle = v || undefined; edited(); } })),
      ...field("Tooltip text", text(key("tooltipDescription"), m.tooltipDescription || "", { set: (v) => { m.tooltipDescription = v || undefined; edited(); } })),
      ...(m.fresh ? field("Unique name", text(key("uniqueName"), m.uniqueName, { set: (v) => { m.uniqueName = v.trim(); selected = "modern:" + m.uniqueName; edited(); refreshList(); } }), { key: key("uniqueName"), hint: "Start it with your publisher prefix. Fixed once saved." }) : staticRow("Unique name", m.uniqueName, { mono: true })),
      ...(m.fresh ? field("App", select(key("app"), m.app ? m.app.id : "", [{ value: "", label: "Pick an app…", disabled: true }, ...state.apps.map((a) => ({ value: a.id, label: a.name, description: a.uniqueName }))], (v) => { const a = state.apps.find((x) => x.id === v); m.app = a ? { id: a.id, name: a.name, uniqueName: a.uniqueName } : undefined; edited(); refreshList(); }), { key: key("app"), hint: "Modern commands belong to one app." }) : staticRow("App", m.app ? m.app.name : "", { none: "all apps" })),
      ...field("Location", select(key("location"), m.location, Object.entries(MODERN_LOCATIONS).map(([v, l]) => ({ value: v, label: l })), (v) => { m.location = Number(v); edited(); refreshList(); renderModern(m); })),
      ...field("Type", select(key("type"), m.type, Object.entries(MODERN_TYPES).map(([v, l]) => ({ value: v, label: l })), (v) => { m.type = Number(v); edited(); renderList(); })),
      ...field("Sequence", text(key("sequence"), m.sequence === undefined ? "" : String(m.sequence), { type: "number", min: 0, set: (v) => { m.sequence = v.trim() === "" ? undefined : Number(v); edited(); renderList(); } }), { key: key("sequence") }),
      h("label", {}, ""), h("div", { class: "cell" }, checkbox(key("hidden"), "Hidden", m.hidden, (v) => { m.hidden = v; edited(); renderList(); }, { hint: "Kept but not shown: the way the command designer hides a button." }))
    );
    const click = h("div", { class: "grid" });
    const renderClick = () => {
      click.replaceChildren(...field("On click", select(key("onclick"), m.onClick.type, [{ value: 0, label: "Nothing" }, { value: 2, label: "Run JavaScript" }, { value: 1, label: "Run a Power Fx formula", description: "in a component library" }], (v) => { m.onClick.type = Number(v); edited(); renderClick(); })));
      if (m.onClick.type === 2) {
        click.append(
          ...field("Function", text(key("function"), m.onClick.functionName || "", { placeholder: "Acme.Account.approve", set: (v) => { m.onClick.functionName = v.trim(); edited(); } }), { key: key("function") }),
          h("label", {}, "Library"), h("div", { class: "cell" }, h("div", { class: "row cell" }, pick(key("library"), m.onClick.library || "", { options: state.scripts.map((n) => ({ id: n, label: n })), placeholder: "A JavaScript web resource", noneText: "No script by that name in the workspace; type the web resource's name", set: (o) => { m.onClick.library = o.id; edited(); }, typed: (v) => { m.onClick.library = v.trim(); edited(); } }), m.onClick.library ? openLink(m.onClick.library, m.onClick.functionName || "") : null), problemEl(key("library")), warningEl("modern:" + m.uniqueName)),
          ...field("Parameters", text(key("parameters"), m.onClick.parameters || "", { placeholder: "PrimaryControl, SelectedControlSelectedItemReferences", set: (v) => { m.onClick.parameters = v; edited(); } }), { hint: "Comma-separated, as the command designer writes them." })
        );
      } else if (m.onClick.type === 1) {
        click.append(
          ...field("Formula function", text(key("formulaFunction"), m.onClick.formulaFunction || "", { set: (v) => { m.onClick.formulaFunction = v.trim(); edited(); } })),
          ...field("Component", text(key("formulaComponent"), m.onClick.formulaComponent || "", { set: (v) => { m.onClick.formulaComponent = v.trim(); edited(); } })),
          ...field("Component library", text(key("formulaLibrary"), m.onClick.formulaLibrary || "", { set: (v) => { m.onClick.formulaLibrary = v.trim(); edited(); } }), { hint: "The formula itself lives in the component library; edit it in the command designer." })
        );
      }
    };
    renderClick();
    const visibility = h("div", { class: "grid" },
      ...staticRow("Visibility", m.visibility.type === 1 ? "Power Fx: " + [m.visibility.formulaFunction, m.visibility.formulaComponent, m.visibility.formulaLibrary].filter(Boolean).join(" in ") : m.visibility.type === 2 ? "Classic rules (from the migrated ribbon)" : "Always shown", { none: "Always shown" })
    );
    const iconGrid = h("div", { class: "grid" },
      ...field("Font icon", text(key("fontIcon"), m.icon.fontIcon || "", { placeholder: "A Fluent icon name", set: (v) => { m.icon.fontIcon = v.trim() || undefined; edited(); } })),
      h("label", {}, "Icon web resource"), h("div", { class: "cell" }, h("div", { class: "row cell" }, pick(key("iconWebResource"), m.icon.webResource || "", { options: state.images.map((n) => ({ id: n, label: n })), placeholder: "An svg web resource", noneText: "No image web resource by that name in the workspace", set: (o) => { m.icon.webResource = o.id; edited(); renderModern(m); }, typed: (v) => { m.icon.webResource = v.trim() || undefined; edited(); } }), m.icon.webResource ? iconImg(m.icon.webResource) : null))
    );
    form.replaceChildren(previewModern(m), h("h2", {}, "Modern command " + (MODERN_TYPES[m.type] || "")), grid, h("h2", {}, "Action"), click, h("h2", {}, "Visibility"), visibility, h("h2", {}, "Icon"), iconGrid,
      h("p", { class: "note" }, m.fresh ? "Created in the environment when you save" + (draft.solution ? " and added to " + draft.solution : "") + "; the app is published afterwards." : "Changes are written to the environment when you save; the app is published afterwards."),
      h("p", {}, h("button", { class: "icon", type: "button", onclick: () => { if (m.fresh) model().modern.splice(model().modern.indexOf(m), 1); else m.removed = true; edited(); refreshList(); show(rows.find((x) => x.kind === "control") ? rows.find((x) => x.kind === "control").key : ""); } }, h("span", { html: ICONS.trash }), m.fresh ? "Discard" : "Delete modern command")));
  }

  function renderSave() {
    const form = document.getElementById("form");
    const solutionOptions = [{ value: "", label: "Pick a solution…", disabled: true }, ...state.solutions.map((s) => ({ value: s, label: s }))];
    form.replaceChildren(
      h("h2", {}, "Classic command bar (RibbonDiffXml)"),
      h("div", { class: "grid" },
        h("label", {}, ""), h("div", { class: "cell" }, checkbox("writeLocal", "Write RibbonDiffXml to the solution folder", draft.writeLocal, (v) => { draft.writeLocal = v; changed(); }, { disabled: !state.localFiles.length && !state.localTarget, hint: state.localFiles[0] || state.localTarget || "No unpacked solution with this table in the workspace." }), state.localFiles[0] || state.localTarget ? h("div", { class: "note" }, state.localFiles[0] || state.localTarget) : h("div", { class: "note" }, "No unpacked solution folder for this table in the workspace (Entities/" + state.table + "/).")),
        h("label", {}, ""), h("div", { class: "cell" }, checkbox("publish", "Publish to " + state.env + " now", draft.publish, (v) => { draft.publish = v; changed(); refreshList(); renderSave(); }, { hint: "Exports the solution, puts the RibbonDiffXml in, imports it and publishes the table. A solution with just this table is fastest." })),
        ...(draft.publish ? field("Solution", select("solution", draft.solution, solutionOptions, (v) => { draft.solution = v; changed(); }), { key: "solution", hint: "An unmanaged solution that contains the table." }) : [])
      ),
      h("h2", {}, "Modern commands"),
      h("p", { class: "note" }, "Modern commands are rows in the environment: they're created, changed and deleted when you save, and their apps are published. New ones are added to the solution picked above."),
      h("h2", {}, "Not here"),
      h("p", { class: "note" }, "Power Fx formulas (edit them in the command designer), the application ribbon, and Microsoft's own buttons beyond hiding them.")
    );
  }
`;

/** Opens the page. Resolves with the saved draft, or undefined on Close. */
export async function openCommandBarPanel(state: CommandBarState, original: RibbonModel, hooks: CommandBarHooks): Promise<CommandBarDraft | undefined> {
  return openPanel<CommandBarState, CommandBarDraft>({
    viewType: "lantern.commandBar",
    title: `${state.tableLabel} command bar`,
    subtitle: state.subtitle,
    state,
    body: BODY,
    script: SCRIPT,
    validate: (d) => commandBarStatus(d, original, state.prefix, hooks.check(d.model), state.localSolutions[0]),
    request: async (name, args) => {
      const a = (args ?? {}) as { webResource?: string; functionName?: string; file?: string; name?: string; model?: RibbonModel; step?: RibbonRuleStep };
      if (name === "open") await hooks.open(a.webResource ?? "", a.functionName ?? "");
      else if (name === "openFile") await hooks.openFile(a.file ?? "");
      else if (name === "icon") return hooks.icon(a.name ?? "");
      else if (name === "check") return a.model ? hooks.check(a.model).map((p) => ({ key: problemKey(p), text: p.text, file: p.file })) : [];
      else if (name === "explain") return a.step ? hooks.explain(a.step) : "";
      return undefined;
    },
    submit: hooks.submit,
    action: "Save",
    cancel: "Close",
  });
}
