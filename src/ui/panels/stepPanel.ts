import { changeCount, LoadedStep, stepChanges, StepDraft, stepProblems } from "../../core/stepEditing";
import { openPanel, Problem, Status } from "./panel";

/**
 * Edit Step and Register Step as an editor tab: the step and its images on the
 * left, the selected one's properties on the right. Dataverse's rules
 * (stepProblems) are checked on every change and shown next to the field they're
 * about; Save stays off while any remain.
 */

export interface StepTarget {
  pluginTypeId: string;
  typeName: string;
  message: string;
  table: string;
  solution: string;
  /** The name follows the class, message and table until it's typed over. */
  nameAuto: boolean;
}

export interface StepPanelDraft {
  step: StepDraft;
  /** Register Step only: what the step is for. */
  target?: StepTarget;
}

export interface ColumnChoice {
  id: string;
  label: string;
  meta?: string;
}

export interface StepPanelState {
  subtitle: string;
  mode: "edit" | "register";
  /** Edit Step: fixed. */
  message: string;
  table: string;
  typeName: string;
  /** Register Step: what can be picked. */
  classes?: Array<{ id: string; typeName: string; assembly: string }>;
  messages?: string[];
  tables?: Array<{ id: string; label: string; meta?: string }>;
  solutions?: string[];
  draft: StepPanelDraft;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The message a Register Step draft is for; "*" is the Other… choice with nothing typed yet. */
export const targetMessage = (t: StepTarget) => (t.message === "*" ? "" : t.message.trim());

function fieldOf(text: string): string {
  if (/needs a name/.test(text)) return "name";
  if (/^Asynchronous steps/.test(text)) return "mode";
  if (/execution order/.test(text)) return "rank";
  if (/^Filtering columns/.test(text)) return "filtering";
  if (/^Type the secure configuration/.test(text)) return "secureConfigValue";
  return "";
}

/** stepProblems, each with the field it's about: the step's own, or an image's alias or type. */
export function stepProblemList(step: Pick<LoadedStep, "message">, d: StepDraft): Problem[] {
  const out: Problem[] = [];
  const general = stepProblems(step, { ...d, images: [] });
  for (const text of general) out.push({ field: fieldOf(text), text });
  const live = d.images.map((img, i) => ({ img, i })).filter((x) => !x.img.removed);
  for (const { img, i } of live) {
    for (const text of stepProblems(step, { ...d, images: [img] }).filter((t) => !general.includes(t))) {
      out.push({ field: `image:${i}:${/needs an alias/.test(text) ? "alias" : "type"}`, text: text.replace(/^Every image needs an alias\.$/, "The image needs an alias.") });
    }
  }
  const seen = new Set<string>();
  for (const { img, i } of live) {
    const a = img.alias.trim().toLowerCase();
    if (a && seen.has(a)) out.push({ field: `image:${i}:alias`, text: `Another image is called "${img.alias.trim()}" too.` });
    seen.add(a);
  }
  return out;
}

const BODY = `
<main class="split" id="main">
  <nav class="list" id="list" aria-label="Step and images"><div class="items" id="items"></div><div class="actions" id="listActions"></div></nav>
  <section class="form" id="form"></section>
</main>`;

const SCRIPT = `
  const STAGES = [
    { value: 10, label: "Pre-validation", description: "before security checks, outside the transaction" },
    { value: 20, label: "Pre-operation", description: "inside the transaction, before the change is saved; change Target here" },
    { value: 40, label: "Post-operation", description: "after the change is saved" },
  ];
  const IMAGE_LABELS = { 0: "Pre-image", 1: "Post-image", 2: "Pre- and post-image" };
  const shortName = (typeName) => (typeName || "").split(/[.+]/).pop() || typeName || "";
  const message = () => (state.mode === "register" ? (draft.target.message === "*" ? "" : draft.target.message) : state.message);
  const table = () => (state.mode === "register" ? draft.target.table : state.table);
  const typeName = () => (state.mode === "register" ? draft.target.typeName : state.typeName);
  // The message property an image is taken from (core/stepEditing's imageMessageProperty).
  const messagePropertyFor = (m) => { m = (m || "").toLowerCase(); return m === "create" ? "Id" : m === "setstate" || m === "setstatedynamicentity" ? "EntityMoniker" : "Target"; };
  const columnCache = new Map();
  const columnsFor = (t) => { if (!columnCache.has(t)) columnCache.set(t, ask("columns", { table: t })); return columnCache.get(t); };
  let selected = "step";
  let lastStatus;

  function build() { renderList(); show("step"); }

  function listItem(key, iconName, name, meta) {
    return h("div", { class: "item" + (key === selected ? " selected" : ""), "data-key": key, role: "button", tabindex: "0", onclick: () => show(key), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(key); } } },
      icon(iconName), h("div", { class: "text" }, h("div", { class: "name" }, name), h("div", { class: "meta" }, meta)), h("span", { class: "flag", "data-flag": key }));
  }
  function renderList() {
    const items = document.getElementById("items");
    const live = draft.step.images.map((img, i) => ({ img, i })).filter((x) => !x.img.removed);
    const head = state.mode === "register" ? [message() || "New step", table() ? "of " + table() : ""].filter(Boolean).join(" ") : state.message + (state.table ? " of " + state.table : "");
    items.replaceChildren(
      listItem("step", "event", head, shortName(typeName()) || "Pick the class, message and table"),
      ...(table() ? [h("div", { class: "group" }, "Images"), ...live.map(({ img, i }) => listItem("image:" + i, "image", img.alias || "(no alias)", (IMAGE_LABELS[img.type] || "Image") + ": " + (img.columns.length ? plural(img.columns.length, "column") : "all columns")))] : []),
      ...(table() && !live.length ? [h("div", { class: "nothing" }, "No images. An image gives the plug-in the row as it was before or after the change.")] : [])
    );
    const actions = document.getElementById("listActions");
    actions.replaceChildren(h("button", { class: "icon", type: "button", disabled: !table(), title: table() ? "" : "Pick a table first", onclick: addImage }, h("span", { html: ICONS.add }), "Add Image"));
  }
  function show(key) {
    selected = key;
    document.querySelectorAll("#items .item").forEach((e) => e.classList.toggle("selected", e.dataset.key === key));
    if (key === "step") renderStep();
    else renderImage(Number(key.split(":")[1]));
    if (lastStatus) showStatus(lastStatus);
  }
  function onStatus(status) {
    lastStatus = status;
    document.querySelectorAll("[data-flag]").forEach((e) => {
      const key = e.dataset.flag;
      const bad = status.problems.some((p) => (key === "step" ? !p.field.startsWith("image:") : p.field.startsWith(key + ":")));
      e.replaceChildren(bad ? h("span", { html: ICONS.warning, title: "Something to fix here" }) : "");
    });
  }
  function addImage() {
    const m = message().toLowerCase();
    const type = m === "create" ? 1 : 0;
    const suggested = type === 1 ? "PostImage" : "PreImage";
    const taken = draft.step.images.some((i) => !i.removed && i.alias === suggested);
    draft.step.images.push({ alias: taken ? "" : suggested, type, columns: [], messageProperty: messagePropertyFor(message()) });
    changed();
    renderList();
    show("image:" + (draft.step.images.length - 1));
    const alias = document.getElementById("image:" + (draft.step.images.length - 1) + ":alias");
    if (alias) alias.focus();
  }
  function autoName() {
    if (state.mode !== "register" || !draft.target.nameAuto) return;
    draft.step.name = typeName() ? shortName(typeName()) + ": " + message() + (table() ? " of " + table() : "") : "";
    const input = document.getElementById("name");
    if (input) input.value = draft.step.name;
  }
  function columnsList(t, picked, opts) {
    const holder = h("div", {}, h("div", { class: "loading" }, "Loading " + t + "'s columns…"));
    columnsFor(t).then((columns) => {
      const set = new Set(picked);
      const list = checklist(columns, set, { placeholder: "Search columns", noneText: opts.noneText, onChange: () => { picked.splice(0, picked.length, ...columns.map((c) => c.id).filter((c) => set.has(c))); changed(); opts.onChange && opts.onChange(); } });
      holder.replaceChildren(list);
    }).catch((err) => holder.replaceChildren(h("div", { class: "problem" }, h("span", { html: ICONS.warning }), "Couldn't load the columns: " + err.message)));
    return holder;
  }

  function renderStep() {
    const form = document.getElementById("form");
    const d = draft.step;
    const sections = [];
    if (state.mode === "register") {
      const t = draft.target;
      const classOptions = [{ value: "", label: "Pick a class…", disabled: true }, ...state.classes.map((c) => ({ value: c.id, label: shortName(c.typeName), description: c.typeName + " (" + c.assembly + ")" }))];
      const messageOptions = [{ value: "", label: "Pick a message…", disabled: true }, ...state.messages.map((m) => ({ value: m, label: m })), { value: "*", label: "Other…" }];
      const known = state.messages.includes(t.message);
      const otherShown = t.message === "*" || (!!t.message && !known);
      const solutionOptions = [{ value: "", label: "(don't add to a solution)" }, ...state.solutions.map((s) => ({ value: s, label: s }))];
      const grid = h("div", { class: "grid" },
        ...field("Plug-in class", select("pluginTypeId", t.pluginTypeId, classOptions, (v) => { t.pluginTypeId = v; t.typeName = (state.classes.find((c) => c.id === v) || {}).typeName || ""; autoName(); changed(); renderList(); }), { hint: "The registered class the step runs. Push the assembly first for a class that isn't listed." }),
        ...field("Message", select("message", otherShown ? "*" : t.message, messageOptions, (v) => { t.message = v; autoName(); syncImages(); changed(); renderList(); renderStep(); if (v === "*") { const o = document.getElementById("messageOther"); if (o) o.focus(); } }), { hint: "The event the step runs on." })
      );
      if (otherShown) grid.append(...field("Message name", text("messageOther", t.message === "*" ? "" : t.message, { placeholder: "A custom API, action or other message name", set: (v) => { t.message = v || "*"; autoName(); syncImages(); changed(); renderList(); } }), { key: "messageOther", hint: "Typed exactly as Dataverse names it, like contoso_Approve." }));
      grid.append(
        ...field("Table", pick("table", table() ? (state.tables.find((x) => x.id === table()) || { label: table() }).label : "", { options: state.tables, placeholder: "Any table (none)", noneText: "No table by that name", set: (o) => { t.table = o.id; autoName(); changed(); renderList(); renderStep(); }, typed: (v) => { if (!v.trim() && t.table) { t.table = ""; autoName(); changed(); renderList(); renderStep(); } } }), { key: "table", hint: "Leave it empty for a message that isn't about a table." }),
        ...field("Solution", select("solution", t.solution, solutionOptions, (v) => { t.solution = v; changed(); }), { hint: "The step is added to this solution." })
      );
      sections.push(h("h2", {}, "Event"), grid);
    } else {
      sections.push(h("h2", {}, "Event"), h("div", { class: "grid" },
        h("label", {}, "Message"), h("div", { class: "cell static" }, state.message),
        h("label", {}, "Table"), h("div", { class: "cell static" }, state.table || "(none)"),
        h("label", {}, "Plug-in class"), h("div", { class: "cell static" }, state.typeName)
      ));
    }
    const isUpdate = message().toLowerCase() === "update";
    const stepGrid = h("div", { class: "grid" },
      ...field("Name", text("name", d.name, { max: 256, set: (v) => { d.name = v; if (draft.target) draft.target.nameAuto = false; changed(); } })),
      ...field("Description", area("description", d.description, { set: (v) => { d.description = v; changed(); }, placeholder: "Optional" }), { top: true }),
      ...field("Stage", select("stage", d.stage, STAGES, (v) => { d.stage = Number(v); if (d.stage !== 40 && d.mode === 1) d.mode = 0; changed(); renderStep(); }), { hint: "When the step runs. Only post-operation steps can run asynchronously." }),
      ...field("Mode", select("mode", d.mode, [
        { value: 0, label: "Synchronous", description: "the user waits; errors block the save" },
        { value: 1, label: "Asynchronous", description: "runs in the background as a system job", disabled: d.stage !== 40 },
      ], (v) => { d.mode = Number(v); changed(); renderStep(); }), { hint: d.stage !== 40 ? "Asynchronous needs post-operation." : "Asynchronous steps run as system jobs after the save." }),
      ...field("Execution order", text("rank", String(d.rank), { type: "number", min: 0, set: (v) => { d.rank = v.trim() === "" ? NaN : Number(v); changed(); } }), { hint: "Steps on the same message and stage run lowest first." })
    );
    if (d.mode === 1) stepGrid.append(h("label", {}, ""), h("div", { class: "cell" }, checkbox("deleteJob", "Delete the system job when it succeeds", d.deleteJobOnSuccess, (v) => { d.deleteJobOnSuccess = v; changed(); }, { hint: "Keeps the system jobs list clean; failed runs stay." }), problemEl("deleteJob")));
    if (isUpdate && table()) stepGrid.append(...field("Filtering columns", columnsList(table(), d.filtering, { noneText: "none: runs on every update" }), { top: true, key: "filtering", hint: "Run only when one of these columns changes. Pick none to run on every update." }));
    else if (d.filtering.length) stepGrid.append(...field("Filtering columns", h("div", { class: "static" }, d.filtering.join(", ")), { key: "filtering", note: "Filtering columns only apply to Update steps.", hint: "Clear them to save." }), h("label", {}, ""), h("div", { class: "cell" }, h("button", { class: "link", type: "button", onclick: () => { d.filtering = []; changed(); renderStep(); } }, "Clear filtering columns")));
    const runAs = pick("runAs", d.runAs ? d.runAs.label : "", {
      placeholder: "Calling user",
      noneText: "No user's name or sign-in contains that",
      onSearch: (q) => (q ? ask("users", { text: q }) : Promise.resolve([])),
      set: (o) => { d.runAs = { id: o.id, label: o.label }; changed(); },
      typed: (v) => { if (!v.trim() && d.runAs) { d.runAs = undefined; changed(); } },
    });
    stepGrid.append(...field("Run as", runAs, { key: "runAs", hint: "Whose context the plug-in runs in: the calling user (the person or process whose change triggered the step), or a specific user. Type to search by name or sign-in.", note: d.runAs ? "Runs as " + d.runAs.label + ". Clear the box for the calling user." : "Runs as the calling user." }));
    sections.push(h("h2", {}, "Step"), stepGrid);

    const configGrid = h("div", { class: "grid" },
      ...field("Unsecure configuration", area("configuration", d.configuration, { rows: 4, set: (v) => { d.configuration = v; changed(); }, placeholder: "Optional" }), { top: true, hint: "Passed to the plug-in's constructor. Anyone who can read the step can read it." })
    );
    if (state.mode === "edit") {
      const sc = d.secureConfig;
      const choice = sc.replacement === null ? "remove" : sc.replacement !== undefined ? "set" : "keep";
      const options = [
        { value: "keep", label: sc.stored ? "Keep the stored one" : "None" },
        { value: "set", label: sc.stored ? "Replace it…" : "Set…" },
        ...(sc.stored ? [{ value: "remove", label: "Remove it" }] : []),
      ];
      const password = h("input", { type: "password", id: "secureConfigValue", placeholder: "Saved when you Save; it isn't shown again", hidden: choice !== "set", value: typeof sc.replacement === "string" ? sc.replacement : "", oninput: (e) => { sc.replacement = e.target.value; changed(); } });
      configGrid.append(
        ...field("Secure configuration", select("secureConfig", choice, options, (v) => { if (v === "keep") delete sc.replacement; else if (v === "remove") sc.replacement = null; else sc.replacement = password.value; password.hidden = v !== "set"; if (v === "set") password.focus(); changed(); }), { hint: "Only System Administrators can read it. Lantern never shows the stored value." }),
        h("label", {}, ""), h("div", { class: "cell" }, password, problemEl("secureConfigValue"))
      );
    } else {
      configGrid.append(h("label", {}, "Secure configuration"), h("div", { class: "cell static note" }, "Set it with Edit Step after registering."));
    }
    sections.push(h("h2", {}, "Configuration"), configGrid);
    form.replaceChildren(...sections);
  }
  /** Register Step: a new message changes what property images come from. */
  function syncImages() { for (const img of draft.step.images) if (!img.id) img.messageProperty = messagePropertyFor(message()); }

  function renderImage(i) {
    const form = document.getElementById("form");
    const img = draft.step.images[i];
    const m = message().toLowerCase();
    const key = (f) => "image:" + i + ":" + f;
    const grid = h("div", { class: "grid" },
      ...field("Alias", text(key("alias"), img.alias, { max: 256, set: (v) => { img.alias = v; changed(); renderList(); } }), { hint: 'The name your code reads it by, as in context.PreEntityImages["…"].' }),
      ...field("Type", select(key("type"), img.type, [
        { value: 0, label: IMAGE_LABELS[0], description: m === "create" ? "Create has none: the row doesn't exist yet" : "the row as it was before the change" },
        { value: 1, label: IMAGE_LABELS[1], description: draft.step.stage !== 40 ? "post-operation only" : m === "delete" ? "Delete has none: the row is gone" : "the row as it is after the change" },
        { value: 2, label: IMAGE_LABELS[2], description: "both" },
      ], (v) => { img.type = Number(v); changed(); renderList(); })),
      ...field("Message property", text(key("messageProperty"), img.messageProperty, { readOnly: true }), { hint: "The message parameter the image is taken from: Target for most messages, Id for Create, EntityMoniker for SetState." }),
      ...field("Columns", columnsList(table(), img.columns, { noneText: "none picked: all columns", onChange: renderList }), { top: true, key: key("columns"), hint: "Fewer columns make the step faster. Pick none for all columns." })
    );
    const remove = h("button", { class: "icon", type: "button", onclick: () => { if (img.id) img.removed = true; else draft.step.images.splice(i, 1); changed(); renderList(); show("step"); } }, h("span", { html: ICONS.trash }), "Remove Image");
    form.replaceChildren(h("h2", {}, "Image"), grid, h("p", { class: "note" }), remove);
  }
`;

export interface StepPanelHooks {
  columns: (table: string) => Promise<ColumnChoice[]>;
  users: (text: string) => Promise<Array<{ id: string; label: string; meta?: string }>>;
  /** Register Step: checks what the panel can't (that the message exists for the table). Returns a line to show when it doesn't. */
  submit?: (draft: StepPanelDraft) => Promise<string | undefined>;
}

/** Opens the page. Resolves with the edited draft on Save/Register, undefined on Cancel. */
export function openStepPanel(title: string, state: StepPanelState, was: StepDraft | undefined, hooks: StepPanelHooks): Promise<StepPanelDraft | undefined> {
  const validate = (d: StepPanelDraft): Status => {
    if (state.mode === "edit") {
      const problems = stepProblemList({ message: state.message }, d.step);
      const n = was ? changeCount(stepChanges(was, d.step)) : 1;
      return { problems, summary: n ? plural(n, "change") : "No changes yet", blocked: !n };
    }
    const t = d.target!;
    const message = targetMessage(t);
    const problems: Problem[] = [];
    if (!t.pluginTypeId) problems.push({ field: "pluginTypeId", text: "Pick the plug-in class." });
    if (!message) problems.push({ field: t.message === "*" ? "messageOther" : "message", text: t.message === "*" ? "Enter the message's name." : "Pick a message." });
    problems.push(...stepProblemList({ message }, d.step));
    const live = d.step.images.filter((i) => !i.removed);
    const summary = message
      ? `Registers ${message}${t.table ? ` of ${t.table}` : ""}${live.length ? ` with ${plural(live.length, "image")}` : ""}${t.solution ? ` in ${t.solution}` : ""}`
      : undefined;
    return { problems, summary };
  };
  return openPanel<StepPanelState, StepPanelDraft>({
    viewType: "lantern.step",
    title,
    subtitle: state.subtitle,
    state,
    body: BODY,
    script: SCRIPT,
    validate,
    request: (name, args) => {
      const a = (args ?? {}) as { table?: string; text?: string };
      if (name === "columns") return hooks.columns(a.table ?? "");
      if (name === "users") return hooks.users(a.text ?? "");
      return Promise.resolve(undefined);
    },
    submit: hooks.submit,
    action: state.mode === "edit" ? "Save" : "Register",
  });
}
