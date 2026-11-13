import { suggestEnvironmentName } from "../../core/discovery";
import { openPanel, Problem, Status } from "./panel";

/**
 * Add Environment as an editor tab: the environments the account can open on the
 * left (Global Discovery Service), the new environment's name, URL and protection
 * on the right. A client that still has a single org names it first, on the same page.
 */

export interface DiscoveredChoice {
  /** The org URL. */
  id: string;
  label: string;
  host: string;
  meta: string;
  disabled: boolean;
  /** DEV, TEST, … when the org's names say so. */
  suggested?: string;
}

export interface EnvironmentDraft {
  /** The name for the org in use, when the client has no environments yet. */
  currentName?: string;
  /** The discovered environment picked, or "custom" for a typed URL. */
  source: string;
  url: string;
  name: string;
  protected: boolean;
  /** The name and protection follow the pick until typed over. */
  nameAuto: boolean;
  protectedAuto: boolean;
}

export interface EnvironmentPanelState {
  subtitle: string;
  client: string;
  /** Name the org in use first. */
  current?: { host: string; suggested?: string; from: string };
  found: DiscoveredChoice[];
  /** The list couldn't be read (no token, or the service answered with an error). */
  discoveryFailed: boolean;
  /** Names already in use. */
  taken: string[];
  /** The usual names to offer. */
  names: string[];
  draft: EnvironmentDraft;
}

const hostOf = (org: string) => {
  try {
    return new URL(/^https?:\/\//i.test(org) ? org : `https://${org}`).host.toLowerCase();
  } catch {
    return org.toLowerCase();
  }
};

/** What's wrong with the draft, by field. */
export function environmentProblems(d: EnvironmentDraft, state: Pick<EnvironmentPanelState, "current" | "taken">, knownHosts: string[], placeholders = false): Problem[] {
  const problems: Problem[] = [];
  const taken = (n: string, besides?: string) => state.taken.some((t) => t.toLowerCase() === n.toLowerCase()) || (besides !== undefined && besides.trim().toLowerCase() === n.toLowerCase());
  if (state.current) {
    const n = (d.currentName ?? "").trim();
    if (!n) problems.push({ field: "currentName", text: "Name the org in use." });
  }
  const name = d.name.trim();
  if (!name) problems.push({ field: "name", text: "Enter a name." });
  else if (taken(name, state.current ? d.currentName : undefined)) problems.push({ field: "name", text: "That name is taken." });
  const url = d.url.trim();
  if (!url) problems.push({ field: "url", text: placeholders ? "Pick an environment or enter its org URL." : "Enter the org URL." });
  else if (!/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}/i.test(url)) problems.push({ field: "url", text: "Enter the org URL, like https://contoso-test.crm.dynamics.com." });
  else if (knownHosts.includes(hostOf(url))) problems.push({ field: "url", text: "That org is already one of this tenant's environments." });
  return problems;
}

const BODY = `
<main class="split" id="main">
  <nav class="list" id="list" aria-label="Environments you can open">
    <div class="search"><span class="icon"></span><input type="search" id="search" placeholder="Search environments" aria-label="Search environments"></div>
    <div class="items" id="items"></div>
    <div id="custom"></div>
  </nav>
  <section class="form" id="form"></section>
</main>`;

const SCRIPT = `
  const looksProd = (n) => /prod|live/i.test(n);
  function build() {
    document.querySelector("#list .search .icon").innerHTML = ICONS.search;
    document.getElementById("search").addEventListener("input", renderList);
    renderList();
    renderForm();
  }
  function choose(source) {
    const wasPicked = draft.source && draft.source !== "custom";
    draft.source = source;
    if (source === "custom" && wasPicked) { draft.url = ""; if (draft.nameAuto) draft.name = ""; if (draft.protectedAuto) draft.protected = false; }
    if (source !== "custom") {
      const e = state.found.find((x) => x.id === source);
      draft.url = e.id;
      if (draft.nameAuto) { draft.name = e.suggested && !isTaken(e.suggested) ? e.suggested : ""; }
      if (draft.protectedAuto) draft.protected = looksProd(draft.name);
    }
    changed();
    renderList();
    renderForm();
    const focus = document.getElementById(source === "custom" ? "url" : "name");
    if (focus) focus.focus();
  }
  const isTaken = (n) => state.taken.concat(state.current && draft.currentName ? [draft.currentName] : []).some((t) => t.toLowerCase() === n.trim().toLowerCase());
  function renderList() {
    const q = document.getElementById("search").value.trim().toLowerCase();
    const items = document.getElementById("items");
    const shown = state.found.filter((e) => !q || (e.label + " " + e.host + " " + e.meta).toLowerCase().includes(q));
    items.replaceChildren(
      ...shown.map((e) => h("div", { class: "item" + (draft.source === e.id ? " selected" : ""), role: "button", tabindex: "0", onclick: () => choose(e.id), onkeydown: (k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); choose(e.id); } } },
        icon("server"), h("div", { class: "text" }, h("div", { class: "name" }, e.label), h("div", { class: "meta" }, e.host + (e.meta ? " · " + e.meta : ""))), e.disabled ? h("span", { class: "count" }, "disabled") : null)),
      ...(!state.found.length ? [h("div", { class: "nothing" }, state.discoveryFailed ? "Lantern couldn't list the environments your account can open, so enter the org URL." : "Every environment your account can open is added already. Enter another org URL.")] : []),
      ...(state.found.length && !shown.length ? [h("div", { class: "nothing" }, "Nothing matches.")] : [])
    );
    const custom = h("div", { class: "item" + (draft.source === "custom" ? " selected" : ""), role: "button", tabindex: "0", onclick: () => choose("custom"), onkeydown: (k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); choose("custom"); } } },
      icon("add"), h("div", { class: "text" }, h("div", { class: "name" }, "Enter an org URL…"), h("div", { class: "meta" }, "An org that isn't listed")));
    document.getElementById("custom").replaceChildren(custom);
  }
  function chips(input, set, except) {
    const names = [...new Set([...(except ? [] : []), ...state.names])].filter((n) => !isTaken(n) || n === input.value);
    return h("div", { class: "chips" }, ...names.map((n) => h("button", { type: "button", class: "chip" + (n === except ? " suggested" : ""), onclick: () => { input.value = n; set(n); } }, n)));
  }
  function renderForm() {
    const form = document.getElementById("form");
    const parts = [];
    if (state.current) {
      const c = state.current;
      const input = text("currentName", draft.currentName, { max: 50, placeholder: "DEV", set: (v) => { draft.currentName = v; changed(); } });
      parts.push(h("h2", {}, "The org in use"), h("div", { class: "grid" },
        h("label", {}, "Org"), h("div", { class: "cell static" }, c.host),
        ...field("Name", input, { hint: "A short name for this org, like DEV or PROD. It becomes the first environment, so the new one can be added beside it.", note: c.suggested ? "Suggested from " + c.from + ": " + c.suggested : undefined }),
        h("label", {}, ""), h("div", { class: "cell" }, chips(input, (v) => { draft.currentName = v; changed(); }, c.suggested))
      ));
    }
    if (!draft.source) {
      parts.push(h("h2", {}, "New environment"), empty("globe", "No environment selected", state.found.length ? "Pick an environment from the list, or enter an org URL." : "Enter the environment's org URL."));
      form.replaceChildren(...parts);
      return;
    }
    const picked = draft.source !== "custom" ? state.found.find((x) => x.id === draft.source) : undefined;
    const name = text("name", draft.name, { max: 50, placeholder: "TEST", set: (v) => { draft.name = v; draft.nameAuto = false; if (draft.protectedAuto) { draft.protected = looksProd(v); const box = document.getElementById("protected"); if (box) box.checked = draft.protected; } changed(); } });
    let suggesting;
    const url = text("url", draft.url, { type: "url", placeholder: "https://contoso-test.crm.dynamics.com", readOnly: !!picked, set: (v) => {
      draft.url = v;
      changed();
      if (!draft.nameAuto) return;
      clearTimeout(suggesting);
      suggesting = setTimeout(() => ask("suggest", { url: v }).then((n) => {
        if (!draft.nameAuto || draft.url !== v || !n || isTaken(n)) return;
        draft.name = n;
        name.value = n;
        if (draft.protectedAuto) { draft.protected = looksProd(n); const box = document.getElementById("protected"); if (box) box.checked = draft.protected; }
        changed();
      }).catch(() => undefined), 300);
    } });
    parts.push(h("h2", {}, "New environment"), h("div", { class: "grid" },
      ...field("Name", name, { hint: "How Lantern shows the environment: in the Tenant view, the status bar, and the .lantern/config.json environments list.", note: picked && picked.suggested ? "Suggested from " + picked.label + ": " + picked.suggested : undefined }),
      h("label", {}, ""), h("div", { class: "cell" }, chips(name, (v) => { draft.name = v; draft.nameAuto = false; if (draft.protectedAuto) { draft.protected = looksProd(v); const box = document.getElementById("protected"); if (box) box.checked = draft.protected; } changed(); }, picked ? picked.suggested : undefined)),
      ...field("Org URL", url, { hint: picked ? "From the environments your account can open." : "The environment's Web API address, as in the maker portal's environment details." }),
      h("label", {}, ""), h("div", { class: "cell" }, checkbox("protected", "Ask before changes", draft.protected, (v) => { draft.protected = v; draft.protectedAuto = false; changed(); }, { hint: "Lantern confirms before pushes, imports, publishing and data changes in this environment. Suggested for PROD." }))
    ));
    form.replaceChildren(...parts);
  }
`;

/** Opens the page. Resolves with the draft on Add, undefined on Cancel. */
export function openEnvironmentPanel(state: EnvironmentPanelState, knownHosts: string[]): Promise<EnvironmentDraft | undefined> {
  const validate = (d: EnvironmentDraft): Status => ({ problems: environmentProblems(d, state, knownHosts, !d.source), summary: d.source && d.name.trim() ? `Adds ${d.name.trim()} to ${state.client}` : undefined });
  return openPanel<EnvironmentPanelState, EnvironmentDraft>({
    viewType: "lantern.environment",
    title: "Add Environment",
    subtitle: state.subtitle,
    state,
    body: BODY,
    script: SCRIPT,
    validate,
    request: (name, args) => Promise.resolve(name === "suggest" ? suggestEnvironmentName(hostOf(String((args as { url?: string })?.url ?? "")).split(".")[0]) : undefined),
    action: "Add",
  });
}
