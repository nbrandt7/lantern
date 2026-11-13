import { openPanel, Problem, Status } from "./panel";

/**
 * Register / Edit Plug-in Registration as an editor tab: the assembly (or package)
 * on the left with each of its classes, the selected one's properties on the
 * right. The Plugin Registration Tool's property panes, in one page.
 */

export interface RegistrationType {
  id?: string;
  typeName: string;
  workflow: boolean;
  name: string;
  /** Empty means a generated ID, the Plugin Registration Tool's default, so its tree shows the type name. */
  friendlyName: string;
  description: string;
  workflowGroup: string;
}

export interface RegistrationDraft {
  /** The assembly's description; undefined when there's no assembly section (a new package). */
  description?: string;
  /** Undefined when it can't be set: the assembly is in a package, which decides how it runs. */
  isolationMode?: number;
  /** The package's name when the assembly is in one. */
  packageName?: string;
  /** A new package's name and unique name. */
  pkg?: { name: string; uniqueName: string };
  types: RegistrationType[];
}

export interface RegistrationState {
  subtitle: string;
  mode: "register" | "edit";
  /** The assembly or package the page is about. */
  what: { name: string; version: string; kind: "assembly" | "package" };
  /** The publisher prefix a new package's unique name has to start with. */
  prefix?: string;
  draft: RegistrationDraft;
}

const shortName = (typeName: string) => typeName.split(/[.+]/).pop() ?? typeName;

/** What Dataverse would refuse, by field. Type problems name the class, since only the selected class's fields are on screen. */
export function registrationProblems(d: RegistrationDraft, prefix: string | undefined): Problem[] {
  const problems: Problem[] = [];
  const tooLong = (field: string, value: string | undefined, max: number, what: string) => {
    if ((value ?? "").trim().length > max) problems.push({ field, text: `${what} can have at most ${max} characters.` });
  };
  if (d.pkg) {
    if (!d.pkg.name.trim()) problems.push({ field: "pkg.name", text: "Enter a name." });
    tooLong("pkg.name", d.pkg.name, 100, "The name");
    const u = d.pkg.uniqueName.trim();
    const p = (prefix ?? "").toLowerCase();
    if (!u) problems.push({ field: "pkg.uniqueName", text: "Enter a unique name." });
    else if (p && (!u.toLowerCase().startsWith(`${p}_`) || u.length <= p.length + 1)) problems.push({ field: "pkg.uniqueName", text: `Start it with ${prefix}_ (the publisher's prefix).` });
    else if (/\s/.test(u)) problems.push({ field: "pkg.uniqueName", text: "Leave out spaces." });
    tooLong("pkg.uniqueName", u, 128, "The unique name");
  }
  if (d.packageName !== undefined) {
    if (!d.packageName.trim()) problems.push({ field: "packageName", text: "Enter a name." });
    tooLong("packageName", d.packageName, 100, "The name");
  }
  tooLong("description", d.description, 256, "The description");
  for (const t of d.types) {
    const key = (f: string) => `type:${t.typeName}:${f}`;
    const who = shortName(t.typeName);
    if (!t.name.trim()) problems.push({ field: key("name"), text: `${who} needs a name.` });
    tooLong(key("name"), t.name, 256, `${who}'s name`);
    tooLong(key("friendlyName"), t.friendlyName, 256, `${who}'s display name`);
    tooLong(key("description"), t.description, 256, `${who}'s description`);
    if (t.workflow && !t.workflowGroup.trim()) problems.push({ field: key("workflowGroup"), text: `${who} needs a workflow activity group.` });
    tooLong(key("workflowGroup"), t.workflowGroup, 256, `${who}'s workflow activity group`);
  }
  return problems;
}

const BODY = `
<main class="split" id="main">
  <nav class="list" id="list" aria-label="Assembly and classes"><div class="items" id="items"></div></nav>
  <section class="form" id="form"></section>
</main>`;

const SCRIPT = `
  let selected;
  let itemsByKey = new Map();
  function build() {
    const items = [];
    const a = state.what;
    if (draft.pkg || draft.packageName !== undefined || draft.description !== undefined) {
      items.push({ key: "head", icon: "package", label: a.name, meta: (a.kind === "package" ? "Package " : "Assembly ") + a.version, render: renderHead });
    }
    for (const t of draft.types) items.push({ key: "type:" + t.typeName, icon: t.workflow ? "event" : "cls", label: shortName(t.typeName), meta: t.workflow ? "Workflow activity" : "Plug-in", render: () => renderType(t) });
    itemsByKey = new Map(items.map((i) => [i.key, i]));
    const main = document.getElementById("main");
    if (items.length === 1) {
      main.className = "single";
      document.getElementById("list").remove();
      selected = items[0].key;
      items[0].render();
      return;
    }
    const list = document.getElementById("items");
    list.replaceChildren(...items.map((i) => h("div", { class: "item", "data-key": i.key, role: "button", tabindex: "0", onclick: () => show(i.key), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(i.key); } } },
      icon(i.icon), h("div", { class: "text" }, h("div", { class: "name" }, i.label), h("div", { class: "meta" }, i.meta)), h("span", { class: "flag", "data-flag": i.key }))));
    show(items[0].key);
  }
  function show(key) {
    selected = key;
    document.querySelectorAll("#items .item").forEach((e) => e.classList.toggle("selected", e.dataset.key === key));
    itemsByKey.get(key).render();
    if (lastStatus) showStatus(lastStatus);
  }
  let lastStatus;
  function onStatus(status) {
    lastStatus = status;
    document.querySelectorAll("[data-flag]").forEach((e) => {
      const key = e.dataset.flag;
      const bad = status.problems.some((p) => (key === "head" ? !p.field.startsWith("type:") : p.field.startsWith(key + ":")));
      e.replaceChildren(bad ? h("span", { html: ICONS.warning, title: "Something to fix here" }) : "");
    });
  }
  const shortName = (typeName) => typeName.split(/[.+]/).pop() || typeName;
  function renderHead() {
    const form = document.getElementById("form");
    const rows = [];
    const a = state.what;
    if (draft.pkg) {
      rows.push(h("h2", {}, "Package"));
      rows.push(h("div", { class: "grid" },
        ...field("Name", text("pkg.name", draft.pkg.name, { max: 100, set: (v) => { draft.pkg.name = v; changed(); } }), { hint: "How the package is listed in Dataverse. Can be changed later." }),
        ...field("Unique name", text("pkg.uniqueName", draft.pkg.uniqueName, { max: 128, set: (v) => { draft.pkg.uniqueName = v; changed(); } }), {
          hint: "Dataverse's key for the package. It can't be changed after registering.",
          note: state.prefix ? "Has to start with " + state.prefix + "_, the solution publisher's prefix." : undefined,
        })
      ));
    }
    if (draft.packageName !== undefined || draft.description !== undefined) {
      rows.push(h("h2", {}, draft.packageName !== undefined ? "Package and assembly" : "Assembly"));
      const grid = h("div", { class: "grid" });
      if (draft.packageName !== undefined) grid.append(...field("Package name", text("packageName", draft.packageName, { max: 100, set: (v) => { draft.packageName = v; changed(); } }), { hint: "How the package is listed in Dataverse." }));
      grid.append(...field("Description", area("description", draft.description, { set: (v) => { draft.description = v; changed(); }, placeholder: "Optional" }), { top: true }));
      if (draft.isolationMode !== undefined) {
        grid.append(...field("Isolation mode", select("isolationMode", draft.isolationMode, [
          { value: 2, label: "Sandbox", description: "the only mode Dataverse online allows" },
          { value: 1, label: "None", description: "on-premises only, and only for System Administrators" },
        ], (v) => { draft.isolationMode = Number(v); changed(); })));
      } else if (draft.packageName !== undefined) {
        grid.append(h("label", {}, "Isolation mode"), h("div", { class: "cell static" }, "Decided by the package."));
      }
      rows.push(grid);
      if (draft.types.length && state.mode === "register") rows.push(h("p", { class: "note" }, "Each class on the left can be named before it's registered; the defaults are the Plugin Registration Tool's."));
    }
    form.replaceChildren(...rows);
  }
  function renderType(t) {
    const form = document.getElementById("form");
    const key = (f) => "type:" + t.typeName + ":" + f;
    const grid = h("div", { class: "grid" },
      h("label", {}, "Class"), h("div", { class: "cell static" }, t.typeName),
      ...field("Name", text(key("name"), t.name, { max: 256, set: (v) => { t.name = v; changed(); } }), { hint: "The plug-in type's name in Dataverse; usually the full class name." }),
      ...field("Display name", text(key("friendlyName"), t.friendlyName, { max: 256, placeholder: "Generated (the Plugin Registration Tool's default)", set: (v) => { t.friendlyName = v; changed(); } }), { hint: "Shown beside the class in the tree. Leave it empty for a generated ID, as the Plugin Registration Tool does." }),
      ...field("Description", area(key("description"), t.description, { set: (v) => { t.description = v; changed(); }, placeholder: "Optional" }), { top: true })
    );
    if (t.workflow) grid.append(...field("Workflow activity group", text(key("workflowGroup"), t.workflowGroup, { max: 256, set: (v) => { t.workflowGroup = v; changed(); } }), { hint: "Where the activity shows up in the classic workflow designer's step menu." }));
    form.replaceChildren(h("h2", {}, t.workflow ? "Workflow activity" : "Plug-in"), grid);
  }
`;

const same = (a: RegistrationDraft, b: RegistrationDraft) => JSON.stringify(a) === JSON.stringify(b);

/** Opens the page. Resolves with the edited draft on Register/Save, undefined on Cancel. */
export function openRegistrationPanel(title: string, state: RegistrationState, countChanges?: (d: RegistrationDraft) => number): Promise<RegistrationDraft | undefined> {
  const initial: RegistrationDraft = JSON.parse(JSON.stringify(state.draft));
  const validate = (d: RegistrationDraft): Status => {
    const problems = registrationProblems(d, state.prefix);
    if (state.mode === "register") return { problems, summary: d.types.length ? `${d.types.length} ${d.types.length === 1 ? "class" : "classes"} to register` : undefined };
    const n = countChanges ? countChanges(d) : same(d, initial) ? 0 : 1;
    return { problems, summary: n ? `${n} ${n === 1 ? "change" : "changes"}` : "No changes yet", blocked: !n };
  };
  return openPanel<RegistrationState, RegistrationDraft>({
    viewType: "lantern.registration",
    title,
    subtitle: state.subtitle,
    state,
    body: BODY,
    script: SCRIPT,
    validate,
    action: state.mode === "register" ? "Register" : "Save",
  });
}
