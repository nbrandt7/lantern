import * as fs from "fs";
import * as path from "path";
import { findFiles } from "./files";
import { findSolutionFolders } from "./solutions";

/**
 * The command bar (ribbon) of a table as a model: tabs, groups and controls for
 * each location (form, main grid, subgrid), the commands they run with their
 * actions, the enable and display rules those commands reference, and the modern
 * (appaction) commands. Built from the merged RibbonXml that RetrieveEntityRibbon
 * returns, then overlaid with the RibbonDiffXml from the client's local solution
 * folders so the page can tell which parts are the client's own, and so the
 * client's own parts can be edited and written back as RibbonDiffXml.
 */

// ---------- a small XML tree ----------

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export const encodeXml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

function readAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]] = decode(m[2] ?? m[3] ?? "");
  return out;
}

/**
 * Parses XML into a tree. Enough for ribbon XML, which is machine-written: elements,
 * attributes and text; comments, CDATA, processing instructions and a doctype are
 * skipped. Keeps the extension free of an XML dependency, like the form parser.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const text = xml.replace(/^﻿/, "");
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decode(m[6]);
    else if (m[3] !== undefined) {
      if (m[2]) {
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].name === m[3]) {
            stack.length = k;
            break;
          }
        }
      } else {
        const node: XmlNode = { name: m[3], attrs: readAttrs(m[4]), children: [], text: "" };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  return root;
}

/** A node as XML, indented two spaces per level. Text-only nodes stay on one line. */
export function xmlToString(node: XmlNode, indent = ""): string {
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${encodeXml(v)}"`).join("");
  const text = node.text.trim();
  if (!node.children.length && !text) return `${indent}<${node.name}${attrs} />`;
  if (!node.children.length) return `${indent}<${node.name}${attrs}>${encodeXml(text)}</${node.name}>`;
  return `${indent}<${node.name}${attrs}>\n${node.children.map((c) => xmlToString(c, indent + "  ")).join("\n")}\n${indent}</${node.name}>`;
}

const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
const kids = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
/** Every descendant with the name, depth first. */
function descendants(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
const el = (name: string, attrs: Record<string, string | undefined> = {}, children: XmlNode[] = [], text = ""): XmlNode => ({
  name,
  attrs: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>,
  children,
  text,
});

// ---------- the model ----------

export type RibbonLocation = "Form" | "HomepageGrid" | "SubGrid" | "Other";
export const LOCATIONS: RibbonLocation[] = ["Form", "HomepageGrid", "SubGrid"];
export const LOCATION_LABELS: Record<RibbonLocation, string> = { Form: "Form", HomepageGrid: "Main grid", SubGrid: "Subgrid", Other: "Other" };

/** Where a part of the ribbon comes from. */
export type RibbonOrigin = "microsoft" | "client" | "other";

export type ControlKind = "button" | "splitButton" | "flyout" | "menuSection" | "toggleButton" | "label" | "other";

export interface RibbonControl {
  id: string;
  kind: ControlKind;
  /** The element name as written (Button, SplitButton, FlyoutAnchor, ...). */
  tag: string;
  /** Every attribute as written, so a client control is written back the way it was. */
  attrs: Record<string, string>;
  /** The label as the page should show it (resolved from LocLabels where it can be). */
  label: string;
  /** The LabelText as written, e.g. "$LocLabels:Acme.Approve.Label" or "$Resources:Ribbon.Form.MainTab.Save". */
  labelKey?: string;
  tooltipTitle?: string;
  tooltipTitleKey?: string;
  tooltipDescription?: string;
  tooltipDescriptionKey?: string;
  command?: string;
  sequence?: number;
  image16?: string;
  image32?: string;
  modernImage?: string;
  /** Flyouts filled at runtime: the command that builds the menu. */
  populateQueryCommand?: string;
  /** Menu items of a split button or flyout, menu sections of a menu. */
  children: RibbonControl[];
  /** The Ids of its Menu (a split button or flyout) or of its Controls (a menu section) as written; CustomAction Locations point at them. */
  menuId?: string;
  controlsId?: string;
  origin: RibbonOrigin;
  /** In the client's RibbonDiffXml but not in the environment's ribbon (not imported or published yet). */
  localOnly?: boolean;
  /** Added on the page and not saved yet: its Id can still be changed. */
  fresh?: boolean;
}

export interface RibbonGroup {
  id: string;
  attrs: Record<string, string>;
  label: string;
  labelKey?: string;
  command?: string;
  sequence?: number;
  controls: RibbonControl[];
  origin: RibbonOrigin;
}

export interface RibbonTab {
  id: string;
  attrs: Record<string, string>;
  location: RibbonLocation;
  label: string;
  labelKey?: string;
  command?: string;
  sequence?: number;
  groups: RibbonGroup[];
  origin: RibbonOrigin;
}

export interface RibbonParameter {
  /** CrmParameter, StringParameter, IntParameter, BoolParameter, ... */
  kind: string;
  value: string;
  name?: string;
}

export interface RibbonAction {
  /** JavaScriptFunction, Url, OpenDialog, ... */
  kind: string;
  functionName?: string;
  /** As written: "$webresource:acme_/ribbon.js", or a built-in path like "/_static/_forms/form.js". */
  library?: string;
  /** The web resource name when the library is one. */
  webResource?: string;
  url?: string;
  parameters: RibbonParameter[];
  attrs: Record<string, string>;
}

export interface RibbonRuleStep {
  /** EntityPrivilegeRule, FormStateRule, ValueRule, CustomRule, ... */
  kind: string;
  attrs: Record<string, string>;
  /** CustomRule only. */
  functionName?: string;
  library?: string;
  webResource?: string;
  parameters: RibbonParameter[];
  /** The rule in words. */
  text: string;
}

export interface RibbonRule {
  id: string;
  kind: "enable" | "display";
  steps: RibbonRuleStep[];
  origin: RibbonOrigin;
  fresh?: boolean;
  /** An Id typed on the page that another rule already has; the rule keeps its own until the Id changes. */
  takenId?: string;
}

export interface RibbonCommand {
  id: string;
  enableRules: string[];
  displayRules: string[];
  actions: RibbonAction[];
  origin: RibbonOrigin;
  fresh?: boolean;
  /** An Id typed on the page that another command already has; the command keeps its own until the Id changes. */
  takenId?: string;
}

export interface HiddenControl {
  id: string;
  location: string;
  origin: RibbonOrigin;
}

/** A CustomAction of the client's RibbonDiffXml: what it adds and where. */
export interface CustomActionDef {
  id: string;
  location: string;
  sequence?: number;
  element: XmlNode;
  /**
   * What it adds was put in the model's tabs when the diff was applied, so the page shows it:
   * it's written from the model, and missing there means it was removed on the page. Otherwise
   * (a MaxSize, a group the loaded ribbon doesn't have) it's written back as read.
   */
  placed?: boolean;
}

export interface LocTitle {
  languagecode: string;
  description: string;
}

/** A modern command (an appaction row): one button of an app's command bar. */
export interface ModernCommand {
  /** appactionid; none until created. */
  id?: string;
  uniqueName: string;
  name: string;
  label: string;
  tooltipTitle?: string;
  tooltipDescription?: string;
  /** appaction_location: 0 form, 1 main grid, 2 subgrid, 3 associated grid, 4 quick form, 5 global header, 6 dashboard. */
  location: number;
  /** appaction_type: 0 standard button, 1 dropdown, 2 split button, 3 group. */
  type: number;
  sequence?: number;
  app?: { id: string; name: string; uniqueName?: string };
  hidden: boolean;
  disabled: boolean;
  parentId?: string;
  groupTitle?: string;
  onClick: {
    /** 0 none, 1 formula (Power Fx in a component library), 2 JavaScript. */
    type: number;
    functionName?: string;
    /** The JavaScript web resource's name. */
    library?: string;
    libraryId?: string;
    parameters?: string;
    formulaFunction?: string;
    formulaComponent?: string;
    formulaLibrary?: string;
  };
  visibility: {
    /** 0 none, 1 formula, 2 classic rules. */
    type: number;
    formulaFunction?: string;
    formulaComponent?: string;
    formulaLibrary?: string;
  };
  icon: { fontIcon?: string; webResource?: string; webResourceId?: string };
  /** Marked for deletion on the page. */
  removed?: boolean;
  fresh?: boolean;
}

export const MODERN_LOCATIONS: Record<number, string> = { 0: "Form", 1: "Main grid", 2: "Subgrid", 3: "Associated grid", 4: "Quick form", 5: "Global header", 6: "Dashboard" };
export const MODERN_TYPES: Record<number, string> = { 0: "Button", 1: "Dropdown", 2: "Split button", 3: "Group" };

export interface RibbonModel {
  table: string;
  tabs: RibbonTab[];
  commands: Record<string, RibbonCommand>;
  enableRules: Record<string, RibbonRule>;
  displayRules: Record<string, RibbonRule>;
  /** LocLabels by Id: the text in the first language found (1033 preferred). */
  labels: Record<string, string>;
  /** The client's LocLabels in every language, so editing one keeps the others. */
  locLabels: Record<string, LocTitle[]>;
  /** Controls a HideCustomAction removes (the environment's merged ribbon no longer has them). */
  hidden: HiddenControl[];
  /** The client's CustomActions as read, so tabs and groups it adds are written back as they were. */
  customActions: CustomActionDef[];
  /** The client's RibbonTemplates and TabDisplayRules as read: the page doesn't edit them, but they're written back. */
  templates?: XmlNode[];
  tabDisplayRules?: XmlNode[];
  /** Modern commands of the table, every app. */
  modern: ModernCommand[];
}

export function emptyModel(table: string): RibbonModel {
  return { table, tabs: [], commands: {}, enableRules: {}, displayRules: {}, labels: {}, locLabels: {}, hidden: [], customActions: [], modern: [] };
}

/** Microsoft's own parts are named Mscrm.*; everything else came from a solution. */
export function originOfId(id: string): RibbonOrigin {
  return /^Mscrm\./i.test(id) ? "microsoft" : "other";
}

/** The location a ribbon element belongs to, from its Id (Mscrm.Form.account.MainTab, Mscrm.HomepageGrid.…, Mscrm.SubGrid.…). */
export function locationOfId(id: string): RibbonLocation {
  const m = /^(?:Mscrm\.)?(Form|HomepageGrid|SubGrid)\b/i.exec(id);
  if (!m) return "Other";
  const key = m[1].toLowerCase();
  return key === "form" ? "Form" : key === "homepagegrid" ? "HomepageGrid" : "SubGrid";
}

const WEBRESOURCE = /^\$webresource:/i;
export const webResourceOf = (library: string | undefined): string | undefined => (library && WEBRESOURCE.test(library) ? library.replace(WEBRESOURCE, "") : undefined);

const num = (s: string | undefined): number | undefined => (s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : undefined);

/** "$LocLabels:X" → the LocLabel text; "$Resources:A.B.Save" → "Save" (the platform's resource, not in the file); otherwise the text itself. */
export function resolveLabel(key: string | undefined, labels: Record<string, string>): string {
  if (!key) return "";
  const loc = /^\$LocLabels:(.+)$/i.exec(key);
  if (loc) return labels[loc[1]] ?? loc[1];
  const res = /^\$Resources:(.+)$/i.exec(key);
  if (res) {
    const last = res[1].split(/[.:]/).pop() ?? res[1];
    return last.replace(/_/g, " ").replace(/^Ribbon /, "").trim() || res[1];
  }
  return key;
}

function readLabels(def: XmlNode, into: Record<string, string>, all?: Record<string, LocTitle[]>): void {
  for (const loc of descendants(def, "LocLabel")) {
    const id = loc.attrs.Id;
    if (!id) continue;
    const titles = descendants(loc, "Title");
    const title = titles.find((t) => t.attrs.languagecode === "1033") ?? titles[0];
    if (title) into[id] = title.attrs.description ?? "";
    if (all) all[id] = titles.map((t) => ({ languagecode: t.attrs.languagecode ?? "1033", description: t.attrs.description ?? "" }));
  }
}

function readParameters(node: XmlNode): RibbonParameter[] {
  return node.children
    .filter((c) => /Parameter$/.test(c.name))
    .map((c) => ({ kind: c.name, value: c.attrs.Value ?? c.attrs.value ?? "", name: c.attrs.Name }));
}

function readAction(node: XmlNode): RibbonAction {
  const a = node.attrs;
  return {
    kind: node.name,
    functionName: a.FunctionName,
    library: a.Library,
    webResource: webResourceOf(a.Library),
    url: a.Address ?? a.Url,
    parameters: readParameters(node),
    attrs: a,
  };
}

function readCommand(node: XmlNode, origin?: RibbonOrigin): RibbonCommand {
  const id = node.attrs.Id ?? "";
  return {
    id,
    enableRules: kids(child(node, "EnableRules"), "EnableRule").map((r) => r.attrs.Id ?? "").filter(Boolean),
    displayRules: kids(child(node, "DisplayRules"), "DisplayRule").map((r) => r.attrs.Id ?? "").filter(Boolean),
    actions: (child(node, "Actions")?.children ?? []).map(readAction),
    origin: origin ?? originOfId(id),
  };
}

/** A rule step from its element. */
export function readRuleStep(c: XmlNode): RibbonRuleStep {
  return {
    kind: c.name,
    attrs: c.attrs,
    functionName: c.name === "CustomRule" ? c.attrs.FunctionName : undefined,
    library: c.name === "CustomRule" ? c.attrs.Library : undefined,
    webResource: c.name === "CustomRule" ? webResourceOf(c.attrs.Library) : undefined,
    parameters: c.name === "CustomRule" ? readParameters(c) : [],
    text: explainRule(c),
  };
}

function readRule(node: XmlNode, kind: "enable" | "display", origin?: RibbonOrigin): RibbonRule {
  const id = node.attrs.Id ?? "";
  return { id, kind, steps: node.children.map(readRuleStep), origin: origin ?? originOfId(id) };
}

const CONTROL_KINDS: Record<string, ControlKind> = {
  Button: "button",
  SplitButton: "splitButton",
  FlyoutAnchor: "flyout",
  MenuSection: "menuSection",
  ToggleButton: "toggleButton",
  Label: "label",
};
export const KIND_TAGS: Record<ControlKind, string> = { button: "Button", splitButton: "SplitButton", flyout: "FlyoutAnchor", menuSection: "MenuSection", toggleButton: "ToggleButton", label: "Label", other: "Button" };

function isControl(node: XmlNode): boolean {
  return node.name in CONTROL_KINDS || /Button|Anchor|Menu|Label|ComboBox|Spinner|CheckBox|TextBox|DropDown|Gallery|InsertTable|ColorPicker/.test(node.name);
}

function readControl(node: XmlNode, labels: Record<string, string>, origin?: RibbonOrigin): RibbonControl {
  const a = node.attrs;
  const id = a.Id ?? "";
  const children: RibbonControl[] = [];
  // SplitButton / FlyoutAnchor → Menu → MenuSection → Controls → Button; a Menu's sections are shown as children too.
  // Only its own Menu's: a flyout inside a section reads its sections itself.
  for (const section of kids(child(node, "Menu"), "MenuSection")) {
    const items = (child(section, "Controls")?.children ?? []).filter(isControl);
    children.push({
      id: section.attrs.Id ?? "",
      kind: "menuSection",
      tag: "MenuSection",
      attrs: section.attrs,
      label: resolveLabel(section.attrs.Title, labels),
      labelKey: section.attrs.Title,
      sequence: num(section.attrs.Sequence),
      children: items.map((c) => readControl(c, labels, origin)),
      origin: origin ?? originOfId(section.attrs.Id ?? id),
      ...(child(section, "Controls")?.attrs.Id ? { controlsId: child(section, "Controls")?.attrs.Id } : {}),
    });
  }
  const menuId = child(node, "Menu")?.attrs.Id;
  return {
    id,
    kind: CONTROL_KINDS[node.name] ?? "other",
    tag: node.name,
    attrs: a,
    label: resolveLabel(a.LabelText, labels) || (node.name === "Label" ? "" : id.split(".").pop() ?? id),
    labelKey: a.LabelText,
    tooltipTitle: a.ToolTipTitle ? resolveLabel(a.ToolTipTitle, labels) : undefined,
    tooltipTitleKey: a.ToolTipTitle,
    tooltipDescription: a.ToolTipDescription ? resolveLabel(a.ToolTipDescription, labels) : undefined,
    tooltipDescriptionKey: a.ToolTipDescription,
    command: a.Command,
    sequence: num(a.Sequence),
    image16: a.Image16by16,
    image32: a.Image32by32,
    modernImage: a.ModernImage,
    populateQueryCommand: a.PopulateQueryCommand,
    children,
    origin: origin ?? originOfId(id),
    ...(menuId ? { menuId } : {}),
  };
}

function readGroup(node: XmlNode, labels: Record<string, string>, origin?: RibbonOrigin): RibbonGroup {
  const a = node.attrs;
  const id = a.Id ?? "";
  return {
    id,
    attrs: a,
    label: resolveLabel(a.Title, labels) || id.split(".").pop() || id,
    labelKey: a.Title,
    command: a.Command,
    sequence: num(a.Sequence),
    controls: (child(node, "Controls")?.children ?? []).filter(isControl).map((c) => readControl(c, labels, origin)),
    origin: origin ?? originOfId(id),
  };
}

function readTab(node: XmlNode, labels: Record<string, string>, location: RibbonLocation | undefined, origin?: RibbonOrigin): RibbonTab {
  const a = node.attrs;
  const id = a.Id ?? "";
  return {
    id,
    attrs: a,
    location: location ?? locationOfId(id),
    label: resolveLabel(a.Title, labels) || id.split(".").pop() || id,
    labelKey: a.Title,
    command: a.Command,
    sequence: num(a.Sequence),
    groups: kids(child(node, "Groups"), "Group").map((g) => readGroup(g, labels, origin)),
    origin: origin ?? originOfId(id),
  };
}

const bySequence = <T extends { sequence?: number }>(list: T[]): T[] => [...list].sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0));

/**
 * The merged ribbon of one table as RetrieveEntityRibbon returns it (the RibbonXml
 * inside the zip). With a location, every tab is that location's; without, the
 * location comes from each tab's Id.
 */
export function parseRibbonXml(xml: string, table: string, location?: RibbonLocation): RibbonModel {
  const model = emptyModel(table);
  const root = parseXml(xml);
  const defs = descendants(root, "RibbonDefinition");
  const definitions = defs.length ? defs : [root];
  for (const def of definitions) readLabels(def, model.labels);
  for (const def of definitions) {
    const ribbon = descendants(def, "Ribbon")[0] ?? def;
    for (const tab of descendants(ribbon, "Tab")) model.tabs.push(readTab(tab, model.labels, location));
    for (const c of descendants(def, "CommandDefinition")) model.commands[c.attrs.Id ?? ""] = readCommand(c);
    for (const r of descendants(def, "EnableRule").filter((n) => n.children.length)) model.enableRules[r.attrs.Id ?? ""] = readRule(r, "enable");
    for (const r of descendants(def, "DisplayRule").filter((n) => n.children.length)) model.displayRules[r.attrs.Id ?? ""] = readRule(r, "display");
  }
  model.tabs = bySequence(model.tabs);
  for (const t of model.tabs) {
    t.groups = bySequence(t.groups);
    for (const g of t.groups) g.controls = bySequence(g.controls);
  }
  return model;
}

/** One model from the per-location ribbons, in Form, main grid, subgrid order. */
export function mergeRibbons(models: RibbonModel[]): RibbonModel {
  const out = emptyModel(models[0]?.table ?? "");
  for (const m of models) {
    out.tabs.push(...m.tabs);
    Object.assign(out.commands, m.commands);
    Object.assign(out.enableRules, m.enableRules);
    Object.assign(out.displayRules, m.displayRules);
    Object.assign(out.labels, m.labels);
    Object.assign(out.locLabels, m.locLabels);
    out.hidden.push(...m.hidden);
    out.customActions.push(...m.customActions);
    out.modern.push(...m.modern);
  }
  const order = (t: RibbonTab) => LOCATIONS.indexOf(t.location) === -1 ? 9 : LOCATIONS.indexOf(t.location);
  out.tabs.sort((a, b) => order(a) - order(b) || (a.sequence ?? 0) - (b.sequence ?? 0));
  return out;
}

// ---------- the client's RibbonDiffXml ----------

export interface RibbonDiff {
  /** Controls, groups and tabs the diff adds, with the Location each goes into. */
  customActions: CustomActionDef[];
  hidden: Array<{ id: string; location: string }>;
  commands: Record<string, RibbonCommand>;
  enableRules: Record<string, RibbonRule>;
  displayRules: Record<string, RibbonRule>;
  labels: Record<string, string>;
  locLabels: Record<string, LocTitle[]>;
  /** The RibbonTemplates elements under <Templates>, and the TabDisplayRule elements, as read. */
  templates: XmlNode[];
  tabDisplayRules: XmlNode[];
}

/** Everything a RibbonDiffXml declares, by Id. */
export function parseRibbonDiff(xml: string | XmlNode): RibbonDiff {
  const root = typeof xml === "string" ? parseXml(xml) : xml;
  const diff: RibbonDiff = { customActions: [], hidden: [], commands: {}, enableRules: {}, displayRules: {}, labels: {}, locLabels: {}, templates: [], tabDisplayRules: [] };
  readLabels(root, diff.labels, diff.locLabels);
  diff.templates = kids(descendants(root, "Templates")[0], "RibbonTemplates");
  diff.tabDisplayRules = descendants(root, "TabDisplayRules")[0]?.children ?? [];
  for (const ca of descendants(root, "CustomAction")) {
    const element = child(ca, "CommandUIDefinition")?.children[0];
    if (!element) continue;
    diff.customActions.push({ id: ca.attrs.Id ?? element.attrs.Id ?? "", location: ca.attrs.Location ?? "", sequence: num(ca.attrs.Sequence), element });
  }
  for (const h of descendants(root, "HideCustomAction")) diff.hidden.push({ id: h.attrs.HideActionId ?? "", location: h.attrs.Location ?? "" });
  for (const c of descendants(root, "CommandDefinition")) diff.commands[c.attrs.Id ?? ""] = readCommand(c, "client");
  for (const r of descendants(root, "EnableRule").filter((n) => n.children.length)) diff.enableRules[r.attrs.Id ?? ""] = readRule(r, "enable", "client");
  for (const r of descendants(root, "DisplayRule").filter((n) => n.children.length)) diff.displayRules[r.attrs.Id ?? ""] = readRule(r, "display", "client");
  return diff;
}

/** Every control Id a RibbonDiffXml element defines, the element's own included. */
function controlIds(element: XmlNode, out: string[] = []): string[] {
  if (element.attrs.Id && (isControl(element) || element.name === "Group" || element.name === "Tab")) out.push(element.attrs.Id);
  for (const c of element.children) controlIds(c, out);
  return out;
}

/** The group Id a CustomAction Location points at: "Mscrm.Form.account.MainTab.Save.Controls._children" → "Mscrm.Form.account.MainTab.Save". */
export function groupOfLocation(location: string): string | undefined {
  const m = /^(.*)\.Controls\._children$/i.exec(location);
  return m ? m[1] : undefined;
}

function* allControls(model: RibbonModel): Generator<RibbonControl> {
  const walk = function* (c: RibbonControl): Generator<RibbonControl> {
    yield c;
    for (const k of c.children) yield* walk(k);
  };
  for (const t of model.tabs) for (const g of t.groups) for (const c of g.controls) yield* walk(c);
}

/** The list a control sits in (a group's controls or a menu section's), and where in it. */
function controlSlot(model: RibbonModel, id: string): { list: RibbonControl[]; index: number } | undefined {
  const find = (list: RibbonControl[]): { list: RibbonControl[]; index: number } | undefined => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { list, index: i };
      const deeper = find(list[i].children);
      if (deeper) return deeper;
    }
    return undefined;
  };
  for (const t of model.tabs) {
    for (const g of t.groups) {
      const hit = find(g.controls);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The controls a CustomAction adds, each with the group it goes in: the element itself, or a Group's (or a Tab's groups') controls. */
function addedControls(ca: CustomActionDef): Array<{ element: XmlNode; groupId?: string }> {
  const e = ca.element;
  if (isControl(e)) return [{ element: e, groupId: groupOfLocation(ca.location) }];
  const groups = e.name === "Group" ? [e] : e.name === "Tab" ? kids(child(e, "Groups"), "Group") : [];
  return groups.flatMap((g) => (child(g, "Controls")?.children ?? []).filter(isControl).map((c) => ({ element: c, groupId: g.attrs.Id })));
}

/**
 * Marks what the client's RibbonDiffXml owns: controls (and the groups and tabs it
 * adds), commands and rules, by Id. A control the diff adds that the environment's
 * ribbon doesn't have yet is put into its group as local-only, so the page shows it.
 * HideCustomActions are listed, since the merged ribbon no longer has those controls.
 * For the client, its own copy of a control, command or rule replaces the environment's:
 * the local file may hold edits that aren't imported yet, and saving mustn't undo them.
 */
export function applyDiff(model: RibbonModel, diff: RibbonDiff, origin: RibbonOrigin = "client"): RibbonModel {
  const mine = origin === "client";
  Object.assign(model.labels, diff.labels);
  if (mine) {
    Object.assign(model.locLabels, diff.locLabels);
    for (const ca of diff.customActions) if (!model.customActions.some((x) => x.id === ca.id && x.location === ca.location)) model.customActions.push({ ...ca });
    if (diff.templates.length) model.templates = diff.templates;
    if (diff.tabDisplayRules.length) model.tabDisplayRules = diff.tabDisplayRules;
  }
  const owned = new Set<string>();
  for (const ca of diff.customActions) for (const id of controlIds(ca.element)) owned.add(id);
  for (const t of model.tabs) {
    if (owned.has(t.id)) t.origin = origin;
    for (const g of t.groups) if (owned.has(g.id)) g.origin = origin;
  }
  const present = new Set<string>();
  for (const c of allControls(model)) {
    present.add(c.id);
    if (owned.has(c.id)) c.origin = origin;
  }
  for (const ca of diff.customActions) {
    for (const { element, groupId } of addedControls(ca)) {
      const id = element.attrs.Id;
      if (!id) continue;
      const control = readControl(element, model.labels, origin);
      if (element === ca.element && ca.sequence !== undefined && control.sequence === undefined) control.sequence = ca.sequence;
      if (present.has(id)) {
        const slot = mine ? controlSlot(model, id) : undefined;
        if (slot) slot.list[slot.index] = { ...control, sequence: control.sequence ?? slot.list[slot.index].sequence };
        continue;
      }
      const group = model.tabs.flatMap((t) => t.groups).find((g) => g.id === groupId);
      if (!group) continue;
      control.localOnly = true;
      group.controls = bySequence([...group.controls, control]);
      for (const k of controlIds(element)) present.add(k);
    }
  }
  if (mine) {
    const groups = new Set(model.tabs.flatMap((t) => t.groups.map((g) => g.id)));
    const tabs = new Set(model.tabs.map((t) => t.id));
    for (const ca of model.customActions) {
      const id = ca.element.attrs.Id ?? "";
      ca.placed ||= isControl(ca.element) ? present.has(id) : ca.element.name === "Group" ? groups.has(id) : ca.element.name === "Tab" && tabs.has(id);
    }
  }
  const take = <T extends { origin: RibbonOrigin }>(existing: T | undefined, theirs: T): T => (existing && !mine ? { ...existing, origin } : { ...theirs, origin });
  for (const [id, c] of Object.entries(diff.commands)) model.commands[id] = take(model.commands[id], c);
  for (const [id, r] of Object.entries(diff.enableRules)) model.enableRules[id] = take(model.enableRules[id], r);
  for (const [id, r] of Object.entries(diff.displayRules)) model.displayRules[id] = take(model.displayRules[id], r);
  for (const h of diff.hidden) {
    if (!h.id) continue;
    const at = model.hidden.find((x) => x.id === h.id && x.location === h.location);
    if (!at) model.hidden.push({ ...h, origin });
    else if (mine) at.origin = origin;
  }
  return model;
}

// ---------- rules in words ----------

const PRIVILEGES: Record<string, string> = { Create: "create", Read: "read", Write: "write", Delete: "delete", Append: "append", AppendTo: "append to", Assign: "assign", Share: "share", AllPrivileges: "use" };
const DEPTHS: Record<string, string> = { Basic: "their own", Local: "their business unit's", Deep: "their business unit's and child units'", Global: "any" };

/** One rule element in plain words, e.g. "The user can delete account records (at least their business unit's)." */
export function explainRule(node: XmlNode): string {
  const a = node.attrs;
  const invert = a.InvertResult === "true";
  const not = (yes: string, no: string) => (invert ? no : yes);
  const entity = a.EntityName ? `${a.EntityName} records` : "the table's records";
  switch (node.name) {
    case "EntityPrivilegeRule": {
      const priv = PRIVILEGES[a.PrivilegeType] ?? (a.PrivilegeType ?? "use").toLowerCase();
      const depth = a.PrivilegeDepth && DEPTHS[a.PrivilegeDepth] ? ` (at least ${DEPTHS[a.PrivilegeDepth]})` : "";
      return `The user ${not("can", "can't")} ${priv} ${entity}${depth}.`;
    }
    case "RecordPrivilegeRule": {
      const priv = PRIVILEGES[a.PrivilegeType] ?? (a.PrivilegeType ?? "use").toLowerCase();
      return `The user ${not("can", "can't")} ${priv} this record${a.AppliesTo === "SelectedEntity" ? " (the selected row)" : ""}.`;
    }
    case "FormStateRule": {
      const states: Record<string, string> = { Create: "a new record", Existing: "an existing record", ReadOnly: "read-only", Disabled: "disabled", BulkEdit: "in bulk edit" };
      return `The form is ${not("", "not ")}${states[a.State] ?? a.State ?? "in that state"}.`;
    }
    case "FormTypeRule":
      return `The form ${not("is", "isn't")} a ${a.Type ?? ""} form.`;
    case "ValueRule":
      return `${a.Field ?? "The field"} ${not("is", "isn't")} ${a.Value === undefined || a.Value === "null" ? "empty" : JSON.stringify(a.Value)}.`;
    case "CustomRule":
      return `${a.FunctionName ?? "A function"} in ${webResourceOf(a.Library) ?? a.Library ?? "a library"} returns ${not("true", "false")}${a.Default ? ` (${a.Default} until it answers)` : ""}.`;
    case "SelectionCountRule": {
      const min = a.Minimum ?? "0";
      const max = a.Maximum;
      const range = max && max !== min ? `between ${min} and ${max}` : min === "1" && !max ? "at least 1" : max ? `exactly ${min}` : `at least ${min}`;
      return `${range} ${range.endsWith("1") ? "row is" : "rows are"} selected${a.AppliesTo === "SelectedEntity" ? " in the subgrid" : ""}${invert ? " (inverted)" : ""}.`;
    }
    case "EntityRule": {
      const ctx = a.Context ? ` in a ${a.Context.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}` : "";
      const which = a.AppliesTo === "PrimaryEntity" ? "The record's table" : a.AppliesTo === "SelectedEntity" ? "The selected rows' table" : "The table";
      return `${which} ${not("is", "isn't")} ${a.EntityName ?? "this one"}${ctx}.`;
    }
    case "CrmClientTypeRule":
      return `The client ${not("is", "isn't")} ${a.Type ?? "this type"}.`;
    case "CommandClientTypeRule":
      return `The command runs in ${a.Type ?? "this client"}${invert ? " (inverted)" : ""}.`;
    case "CrmOfflineAccessStateRule":
      return `The client ${not("is", "isn't")} ${a.State ?? ""} offline.`;
    case "CrmOutlookClientTypeRule":
      return `The Outlook client ${not("is", "isn't")} ${a.Type ?? ""}.`;
    case "OutlookVersionRule":
    case "OutlookRenderTypeRule":
    case "OutlookItemTypeRule":
      return `Outlook: ${Object.entries(a).map(([k, v]) => `${k} ${v}`).join(", ")}.`;
    case "SkuRule":
      return `The licence ${not("is", "isn't")} ${a.Sku ?? ""}.`;
    case "FormEntityContextRule":
      return `The form ${not("is", "isn't")} for ${a.EntityName ?? "this table"}.`;
    case "ReferencingAttributeRequiredRule":
      return `The subgrid's relationship column ${not("is", "isn't")} required.`;
    case "RelationshipTypeRule":
      return `The relationship ${not("is", "isn't")} ${a.RelationshipType ?? ""}${a.AppliesTo ? ` (${a.AppliesTo})` : ""}.`;
    case "HideForTabletExperienceRule":
      return "Hidden on tablets.";
    case "OptimisticEnableRule":
      return "Enabled right away, before the rules are evaluated.";
    case "OrRule": {
      // <OrRule><Or>rule rule</Or><Or>rule</Or></OrRule>: the rules in an <Or> all hold, and any <Or> is enough.
      const alternatives = node.children.map((or) => (or.name === "Or" ? or.children : [or]).map((c) => explainRule(c).replace(/\.$/, "")).join(" and "));
      return `Any of: ${alternatives.join("; or ")}.`;
    }
    case "PageRule":
      return `The page ${not("is", "isn't")} ${a.Address ?? ""}.`;
    case "DeviceTypeRule":
      return `The device ${not("is", "isn't")} ${a.Type ?? ""}.`;
    case "MiscellaneousPrivilegeRule":
      return `The user ${not("has", "lacks")} the ${a.PrivilegeName ?? ""} privilege${a.PrivilegeDepth && DEPTHS[a.PrivilegeDepth] ? ` (at least ${DEPTHS[a.PrivilegeDepth]})` : ""}.`;
    default: {
      const detail = Object.entries(a).filter(([k]) => k !== "InvertResult").map(([k, v]) => `${k}=${v}`).join(", ");
      return `${node.name}${detail ? ` (${detail})` : ""}${invert ? ", inverted" : ""}.`;
    }
  }
}

/** A step's element (CustomRule parameters included), for explaining and writing it. */
export function stepToXml(s: RibbonRuleStep): XmlNode {
  const attrs: Record<string, string | undefined> = { ...s.attrs };
  if (s.kind === "CustomRule") {
    attrs.FunctionName = s.functionName;
    attrs.Library = s.library ?? (s.webResource ? `$webresource:${s.webResource}` : undefined);
  }
  return el(s.kind, attrs, s.kind === "CustomRule" ? s.parameters.map(parameterToXml) : []);
}

/** The words for a step as the page has edited it. */
export function explainStep(s: RibbonRuleStep): string {
  return explainRule(stepToXml(s));
}

/** The attributes each rule kind takes, for the page's editor. */
export const RULE_KINDS: Record<string, Array<{ name: string; options?: string[]; hint?: string }>> = {
  CustomRule: [{ name: "Default", options: ["", "true", "false"], hint: "What the rule answers until the function has run." }, { name: "InvertResult", options: ["", "true"] }],
  EntityPrivilegeRule: [{ name: "EntityName" }, { name: "PrivilegeType", options: ["Create", "Read", "Write", "Delete", "Append", "AppendTo", "Assign", "Share", "AllPrivileges"] }, { name: "PrivilegeDepth", options: ["Basic", "Local", "Deep", "Global"] }, { name: "AppliesTo", options: ["", "PrimaryEntity", "SelectedEntity"] }, { name: "InvertResult", options: ["", "true"] }],
  RecordPrivilegeRule: [{ name: "PrivilegeType", options: ["Create", "Read", "Write", "Delete", "Append", "AppendTo", "Assign", "Share", "AllPrivileges"] }, { name: "AppliesTo", options: ["", "PrimaryEntity", "SelectedEntity"] }, { name: "InvertResult", options: ["", "true"] }],
  FormStateRule: [{ name: "State", options: ["Create", "Existing", "ReadOnly", "Disabled", "BulkEdit"] }, { name: "InvertResult", options: ["", "true"] }],
  FormTypeRule: [{ name: "Type", options: ["Main", "QuickCreate", "Quick"] }, { name: "InvertResult", options: ["", "true"] }],
  ValueRule: [{ name: "Field" }, { name: "Value", hint: "The value to compare with; null for empty." }, { name: "InvertResult", options: ["", "true"] }],
  SelectionCountRule: [{ name: "Minimum" }, { name: "Maximum" }, { name: "AppliesTo", options: ["", "PrimaryEntity", "SelectedEntity"] }, { name: "InvertResult", options: ["", "true"] }],
  EntityRule: [{ name: "EntityName" }, { name: "AppliesTo", options: ["", "PrimaryEntity", "SelectedEntity"] }, { name: "Context", options: ["", "Form", "HomePageGrid", "SubGridStandard", "SubGridAssociated"] }, { name: "InvertResult", options: ["", "true"] }],
  CrmClientTypeRule: [{ name: "Type", options: ["Web", "Outlook", "Modern"] }, { name: "InvertResult", options: ["", "true"] }],
  CommandClientTypeRule: [{ name: "Type", options: ["Modern", "Refresh", "Legacy"] }, { name: "InvertResult", options: ["", "true"] }],
  CrmOfflineAccessStateRule: [{ name: "State", options: ["Online", "Offline"] }, { name: "InvertResult", options: ["", "true"] }],
  SkuRule: [{ name: "Sku", options: ["OnPremise", "Online", "Live", "Spla"] }, { name: "InvertResult", options: ["", "true"] }],
  FormEntityContextRule: [{ name: "EntityName" }, { name: "InvertResult", options: ["", "true"] }],
  ReferencingAttributeRequiredRule: [{ name: "InvertResult", options: ["", "true"] }],
  RelationshipTypeRule: [{ name: "RelationshipType", options: ["NoRelationship", "OneToMany", "ManyToMany"] }, { name: "AppliesTo", options: ["", "PrimaryEntity", "SelectedEntity"] }, { name: "InvertResult", options: ["", "true"] }],
  HideForTabletExperienceRule: [],
  OptimisticEnableRule: [],
  MiscellaneousPrivilegeRule: [{ name: "PrivilegeName" }, { name: "PrivilegeDepth", options: ["Basic", "Local", "Deep", "Global"] }, { name: "InvertResult", options: ["", "true"] }],
  DeviceTypeRule: [{ name: "Type", options: ["Desktop", "Tablet", "Phone"] }, { name: "InvertResult", options: ["", "true"] }],
};

/** The parameter kinds an action or custom rule can pass, with the CrmParameter values. */
export const PARAMETER_KINDS = ["CrmParameter", "StringParameter", "IntParameter", "BoolParameter", "DecimalParameter", "FloatParameter"];
export const CRM_PARAMETER_VALUES = [
  "PrimaryControl", "PrimaryEntityTypeName", "PrimaryEntityTypeCode", "FirstPrimaryItemId", "PrimaryItemIds", "PrimaryEntityName", "PrimaryEntityTypeNameLower",
  "SelectedControl", "SelectedControlSelectedItemCount", "SelectedControlSelectedItemIds", "SelectedControlSelectedItemReferences", "SelectedControlAllItemCount", "SelectedControlAllItemIds", "SelectedControlAllItemReferences", "SelectedControlUnselectedItemCount", "SelectedControlUnselectedItemIds", "SelectedControlUnselectedItemReferences",
  "SelectedEntityTypeName", "SelectedEntityTypeCode", "SelectedEntityTypeNameLower", "CommandProperties", "OrgName", "OrgLCID", "UserLCID", "ControlType", "GridControl",
];

// ---------- JavaScript references ----------

export interface RibbonProblem {
  /** "command", "enable rule", "display rule" or "modern command". */
  kind: "command" | "enable rule" | "display rule" | "modern command";
  /** The command's or rule's Id, or the modern command's unique name. */
  id: string;
  /** Index of the action or rule step within it. */
  index: number;
  webResource: string;
  functionName: string;
  /** The local file, when the library was found but not the function. */
  file?: string;
  text: string;
}

export interface LibraryLookup {
  file: string;
  text: string;
}

/**
 * Every JavaScriptFunction, CustomRule and modern JavaScript command that names a web
 * resource, checked against the workspace: the library has to be a web resource in
 * the client folder, and the function has to be defined in it. `lookup` is the
 * extension's web resource matching; `defines` the function finder the form
 * diagnostics use.
 */
export function checkRibbonReferences(model: RibbonModel, lookup: (webResource: string) => LibraryLookup | undefined, defines: (text: string, fn: string) => boolean): RibbonProblem[] {
  const out: RibbonProblem[] = [];
  const found = new Map<string, LibraryLookup | undefined>();
  const check = (kind: RibbonProblem["kind"], id: string, index: number, webResource: string | undefined, functionName: string | undefined) => {
    if (!webResource || !functionName) return;
    const key = webResource.toLowerCase();
    if (!found.has(key)) found.set(key, lookup(webResource));
    const lib = found.get(key);
    if (!lib) out.push({ kind, id, index, webResource, functionName, text: `${webResource} isn't a web resource in the workspace.` });
    else if (!defines(lib.text, functionName)) out.push({ kind, id, index, webResource, functionName, file: lib.file, text: `${functionName} isn't defined in ${path.basename(lib.file)}.` });
  };
  for (const c of Object.values(model.commands)) c.actions.forEach((a, i) => check("command", c.id, i, a.webResource, a.functionName));
  for (const r of Object.values(model.enableRules)) r.steps.forEach((s, i) => check("enable rule", r.id, i, s.webResource, s.functionName));
  for (const r of Object.values(model.displayRules)) r.steps.forEach((s, i) => check("display rule", r.id, i, s.webResource, s.functionName));
  for (const m of model.modern) if (!m.removed && m.onClick.type === 2) check("modern command", m.uniqueName, 0, m.onClick.library, m.onClick.functionName);
  return out;
}

/** Problems grouped by command or rule Id, for the list's counts. */
export function problemCounts(problems: RibbonProblem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of problems) out[`${p.kind}:${p.id}`] = (out[`${p.kind}:${p.id}`] ?? 0) + 1;
  return out;
}

// ---------- the client's RibbonDiffXml on disk ----------

export interface LocalRibbonDiff {
  file: string;
  solution: string;
  diff: RibbonDiff;
}

function solutionNameOf(folder: string): string {
  try {
    const m = /<UniqueName>\s*([^<]+?)\s*<\/UniqueName>/.exec(fs.readFileSync(path.join(folder, "Other", "Solution.xml"), "utf8"));
    if (m) return m[1];
  } catch {
    // no Solution.xml
  }
  return path.basename(folder);
}

function tableOfEntityFolder(folder: string): string | undefined {
  try {
    const m = /<Name\b[^>]*>\s*([^<]+?)\s*<\/Name>/.exec(fs.readFileSync(path.join(folder, "Entity.xml"), "utf8"));
    if (m) return m[1].toLowerCase();
  } catch {
    // no Entity.xml
  }
  return path.basename(folder).toLowerCase();
}

/**
 * The table's RibbonDiffXml in the client's unpacked solutions: Entities/<Table>/RibbonDiff.xml
 * from pac solution unpack, or the <RibbonDiffXml> inside the table's <Entity> in a
 * customizations.xml.
 */
export function findRibbonDiffs(clientDir: string, table: string): LocalRibbonDiff[] {
  const wanted = table.toLowerCase();
  const out: LocalRibbonDiff[] = [];
  for (const folder of findSolutionFolders(clientDir)) {
    const solution = solutionNameOf(folder);
    for (const file of findFiles(folder, (n) => n.toLowerCase() === "ribbondiff.xml")) {
      if (tableOfEntityFolder(path.dirname(file)) !== wanted) continue;
      try {
        out.push({ file, solution, diff: parseRibbonDiff(fs.readFileSync(file, "utf8")) });
      } catch {
        // unreadable
      }
    }
    for (const file of findFiles(folder, (n) => n.toLowerCase() === "customizations.xml")) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const diff = entityRibbonDiff(text, wanted);
      if (diff) out.push({ file, solution, diff: parseRibbonDiff(diff) });
    }
  }
  return out;
}

/** The <RibbonDiffXml> inside the table's <Entity> of a customizations.xml, when it has one. */
export function entityRibbonDiff(customizations: string, table: string): XmlNode | undefined {
  if (!/<RibbonDiffXml/.test(customizations)) return undefined;
  const wanted = table.toLowerCase();
  for (const entity of descendants(parseXml(customizations), "Entity")) {
    if (child(entity, "Name")?.text.trim().toLowerCase() === wanted) return child(entity, "RibbonDiffXml");
  }
  return undefined;
}

/** Where a new RibbonDiff.xml for the table would go in an unpacked solution folder: Entities/<Table>/, when that folder exists. */
export function ribbonDiffPathFor(clientDir: string, table: string): string | undefined {
  const wanted = table.toLowerCase();
  for (const folder of findSolutionFolders(clientDir)) {
    const entities = path.join(folder, "Entities");
    let names: string[];
    try {
      names = fs.readdirSync(entities);
    } catch {
      continue;
    }
    for (const n of names) {
      const dir = path.join(entities, n);
      try {
        if (fs.statSync(dir).isDirectory() && tableOfEntityFolder(dir) === wanted) return path.join(dir, "RibbonDiff.xml");
      } catch {
        // skip
      }
    }
  }
  return undefined;
}

// ---------- writing RibbonDiffXml ----------

function parameterToXml(p: RibbonParameter): XmlNode {
  return el(p.kind, { Value: p.value, Name: p.name });
}

function actionToXml(a: RibbonAction): XmlNode {
  const attrs: Record<string, string | undefined> = { ...a.attrs };
  if (a.kind === "JavaScriptFunction") {
    attrs.FunctionName = a.functionName;
    attrs.Library = a.library ?? (a.webResource ? `$webresource:${a.webResource}` : undefined);
  } else if (a.kind === "Url") {
    attrs.Address = a.url;
  }
  return el(a.kind, attrs, a.parameters.map(parameterToXml));
}

/** The LocLabels key a control's text is stored under. */
export const labelKeyFor = (controlId: string, what: "LabelText" | "ToolTipTitle" | "ToolTipDescription"): string => `${controlId}.${what}`;

function controlToXml(c: RibbonControl): XmlNode {
  const attrs: Record<string, string | undefined> = { ...c.attrs };
  attrs.Id = c.id;
  if (c.kind === "menuSection") {
    attrs.Title = c.labelKey;
    attrs.Sequence = c.sequence === undefined ? attrs.Sequence : String(c.sequence);
    delete attrs.Command;
    return el("MenuSection", attrs, [el("Controls", { Id: c.controlsId || `${c.id}.Controls` }, c.children.map(controlToXml))]);
  }
  attrs.Command = c.command;
  attrs.Sequence = c.sequence === undefined ? attrs.Sequence : String(c.sequence);
  attrs.LabelText = c.labelKey;
  attrs.ToolTipTitle = c.tooltipTitleKey;
  attrs.ToolTipDescription = c.tooltipDescriptionKey;
  attrs.Image16by16 = c.image16;
  attrs.Image32by32 = c.image32;
  attrs.ModernImage = c.modernImage;
  attrs.PopulateQueryCommand = c.populateQueryCommand;
  if (c.kind === "button" && !attrs.TemplateAlias) attrs.TemplateAlias = "o1";
  const tag = c.tag || KIND_TAGS[c.kind];
  const children: XmlNode[] = [];
  if (c.children.length) {
    const sections = c.children.filter((k) => k.kind === "menuSection");
    const loose = c.children.filter((k) => k.kind !== "menuSection");
    const items = sections.map(controlToXml);
    if (loose.length) items.push(el("MenuSection", { Id: `${c.id}.Section`, Sequence: "10", DisplayMode: "Menu16" }, [el("Controls", { Id: `${c.id}.Section.Controls` }, loose.map(controlToXml))]));
    children.push(el("Menu", { Id: c.menuId || `${c.id}.Menu` }, items));
  }
  return el(tag, attrs, children);
}

function commandToXml(c: RibbonCommand): XmlNode {
  return el("CommandDefinition", { Id: c.id }, [
    el("EnableRules", {}, c.enableRules.map((id) => el("EnableRule", { Id: id }))),
    el("DisplayRules", {}, c.displayRules.map((id) => el("DisplayRule", { Id: id }))),
    el("Actions", {}, c.actions.map(actionToXml)),
  ]);
}

function ruleToXml(r: RibbonRule): XmlNode {
  return el(r.kind === "enable" ? "EnableRule" : "DisplayRule", { Id: r.id }, r.steps.map(stepToXml));
}

/** Every LocLabels key an element and the elements in it use, in any attribute. */
function locLabelKeys(node: XmlNode, out: Set<string>): void {
  for (const v of Object.values(node.attrs)) {
    const m = /^\$LocLabels:(.+)$/i.exec(v);
    if (m) out.add(m[1]);
  }
  for (const c of node.children) locLabelKeys(c, out);
}

export interface ClientLayer {
  xml: string;
  /** What the layer holds, for the summary. */
  counts: { controls: number; hidden: number; commands: number; rules: number; labels: number };
}

/**
 * The client's layer of the ribbon as RibbonDiffXml: its CustomActions (what the page
 * shows from the model as it is now, the rest as read: MaxSize and Scale, a group the
 * loaded ribbon doesn't have), the client's controls that have none yet (added on the
 * page), the HideCustomActions, its commands and rules, its templates, and the labels
 * all of them use.
 */
export function serializeRibbonDiff(model: RibbonModel): ClientLayer {
  const customActions: XmlNode[] = [];
  const counts = { controls: 0, hidden: 0, commands: 0, rules: 0, labels: 0 };
  const action = (id: string, location: string, sequence: number | undefined, element: XmlNode) =>
    customActions.push(el("CustomAction", { Id: id, Location: location, Sequence: sequence === undefined ? undefined : String(sequence) }, [el("CommandUIDefinition", {}, [element])]));
  const controls = new Map<string, RibbonControl>();
  for (const c of allControls(model)) if (!controls.has(c.id)) controls.set(c.id, c);
  const groups = new Map(model.tabs.flatMap((t) => t.groups).map((g) => [g.id, g]));
  // A control with a CustomAction of its own is written by it; the client's others go in their client parent's element, or get one.
  const ownAction = new Set(model.customActions.filter((ca) => ca.placed && isControl(ca.element)).map((ca) => ca.element.attrs.Id ?? ""));
  const rebuilt = new Set<string>();
  /** A client group as read, its controls as they are on the page now. */
  const liveGroup = (e: XmlNode): XmlNode => {
    const g = groups.get(e.attrs.Id ?? "");
    if (!g) return e;
    rebuilt.add(g.id);
    const items = g.controls.filter((c) => c.origin === "client" && !ownAction.has(c.id)).map(controlToXml);
    counts.controls += items.length;
    const was = child(e, "Controls");
    const now = el("Controls", was?.attrs ?? { Id: `${g.id}.Controls` }, items);
    return { ...e, children: was ? e.children.map((x) => (x === was ? now : x)) : [...e.children, now] };
  };
  for (const ca of model.customActions) {
    const e = ca.element;
    let element: XmlNode | undefined = e;
    let sequence = ca.sequence;
    if (ca.placed && isControl(e)) {
      // Shown on the page: as it is there now, or left out because it was removed there.
      const c = controls.get(e.attrs.Id ?? "");
      element = c && controlToXml(c);
      sequence = c?.sequence ?? ca.sequence;
    } else if (ca.placed && e.name === "Group") element = liveGroup(e);
    else if (ca.placed && e.name === "Tab") element = { ...e, children: e.children.map((x) => (x.name === "Groups" ? { ...x, children: x.children.map((g) => (g.name === "Group" ? liveGroup(g) : g)) } : x)) };
    if (!element) continue;
    if (isControl(e)) counts.controls++;
    action(ca.id, ca.location, sequence, element);
  }
  const rest = (list: RibbonControl[], location: string, inParent: boolean) => {
    for (const c of list) {
      if (c.origin === "client" && !inParent && !ownAction.has(c.id)) {
        counts.controls++;
        action(`${c.id}.CustomAction`, location, c.sequence, controlToXml(c));
      }
      // A client control's element holds its menu; someone else's menu section can hold the client's buttons.
      rest(c.children, `${c.controlsId ?? `${c.id}.Controls`}._children`, inParent || c.origin === "client");
    }
  };
  for (const t of model.tabs) for (const g of t.groups) rest(g.controls, `${g.id}.Controls._children`, rebuilt.has(g.id));
  const hidden = model.hidden.filter((h) => h.origin === "client").map((h) => el("HideCustomAction", { HideActionId: h.id, Location: h.location }));
  counts.hidden = hidden.length;
  const commands = Object.values(model.commands).filter((c) => c.origin === "client").map(commandToXml);
  counts.commands = commands.length;
  const enable = Object.values(model.enableRules).filter((r) => r.origin === "client").map(ruleToXml);
  const display = Object.values(model.displayRules).filter((r) => r.origin === "client").map(ruleToXml);
  counts.rules = enable.length + display.length;
  const labelKeys = new Set<string>();
  for (const ca of customActions) locLabelKeys(ca, labelKeys);
  // A key nothing defines stays the reference it was; no text is made up for it.
  const locLabels = [...labelKeys].sort().flatMap((key) => {
    const titles = model.locLabels[key]?.length ? model.locLabels[key] : key in model.labels ? [{ languagecode: "1033", description: model.labels[key] }] : [];
    return titles.length ? [el("LocLabel", { Id: key }, [el("Titles", {}, titles.map((t) => el("Title", { description: t.description, languagecode: t.languagecode })))])] : [];
  });
  counts.labels = locLabels.length;
  const root = el("RibbonDiffXml", { "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance", "xmlns:xsd": "http://www.w3.org/2001/XMLSchema" }, [
    el("CustomActions", {}, customActions),
    el("HideCustomActions", {}, hidden),
    el("Templates", {}, model.templates?.length ? model.templates : [el("RibbonTemplates", { Id: "Mscrm.Templates" })]),
    el("CommandDefinitions", {}, commands),
    el("RuleDefinitions", {}, [el("TabDisplayRules", {}, model.tabDisplayRules ?? []), el("DisplayRules", {}, display), el("EnableRules", {}, enable)]),
    el("LocLabels", {}, locLabels),
  ]);
  return { xml: xmlToString(root), counts };
}

/** The whole RibbonDiff.xml file for an unpacked solution (pac's shape: a declaration, then the diff). */
export function ribbonDiffFile(layer: ClientLayer): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n${layer.xml}\n`;
}

// ---------- keeping what a RibbonDiffXml already holds ----------

/** What a RibbonDiffXml defines, in words ("Button acme.Approve", "command acme.Run"): what writing over it has to keep. */
export function ribbonDiffParts(diff: RibbonDiff): Set<string> {
  const out = new Set<string>();
  const walk = (n: XmlNode, top: boolean) => {
    if (n.attrs.Id && (top || n.name === "Group" || n.name === "Tab" || (isControl(n) && n.name !== "Menu"))) out.add(`${n.name} ${n.attrs.Id}`);
    for (const c of n.children) walk(c, false);
  };
  for (const ca of diff.customActions) walk(ca.element, true);
  for (const h of diff.hidden) out.add(`hidden ${h.id}`);
  for (const id of Object.keys(diff.commands)) out.add(`command ${id}`);
  for (const id of Object.keys(diff.enableRules)) out.add(`enable rule ${id}`);
  for (const id of Object.keys(diff.displayRules)) out.add(`display rule ${id}`);
  return out;
}

/** What the page removed, in the words of ribbonDiffParts: controls, commands, rules and hidden controls it showed that the draft no longer has. */
export function removedParts(original: RibbonModel, draft: RibbonModel): Set<string> {
  const out = new Set<string>();
  const now = new Set([...allControls(draft)].map((c) => c.id));
  for (const c of allControls(original)) if (!now.has(c.id)) out.add(`${c.tag} ${c.id}`);
  for (const id of Object.keys(original.commands)) if (!draft.commands[id]) out.add(`command ${id}`);
  for (const id of Object.keys(original.enableRules)) if (!draft.enableRules[id]) out.add(`enable rule ${id}`);
  for (const id of Object.keys(original.displayRules)) if (!draft.displayRules[id]) out.add(`display rule ${id}`);
  for (const h of original.hidden) if (!draft.hidden.some((x) => x.id === h.id && x.location === h.location)) out.add(`hidden ${h.id}`);
  return out;
}

/** What `before` defines that the RibbonDiffXml `after` doesn't, leaving out what the page removed on purpose. */
export function lostParts(before: RibbonDiff, after: string, removed: Iterable<string> = []): string[] {
  const kept = ribbonDiffParts(parseRibbonDiff(after));
  const gone = new Set(removed);
  return [...ribbonDiffParts(before)].filter((p) => !kept.has(p) && !gone.has(p));
}

/**
 * The draft with the RibbonDiffXml a solution already holds for the table laid under it,
 * for publishing through that solution: the import replaces the table's whole
 * RibbonDiffXml, so what's there has to go back in. What the page never had as the
 * client's (a button added in the Ribbon Workbench, a MaxSize) is kept as it is there;
 * what the page had and the draft no longer has was removed on the page and stays out;
 * where both have something, the draft's wins.
 */
export function mergePublishedDiff(draft: RibbonModel, original: RibbonModel, published: RibbonDiff): RibbonModel {
  const m: RibbonModel = JSON.parse(JSON.stringify(draft));
  const shown = new Map<string, RibbonOrigin>();
  const wasShown = new Set<string>();
  for (const t of m.tabs) for (const x of [t, ...t.groups]) shown.set(x.id, x.origin);
  for (const c of allControls(m)) shown.set(c.id, c.origin);
  for (const t of original.tabs) for (const x of [t, ...t.groups]) wasShown.add(x.id);
  for (const c of allControls(original)) wasShown.add(c.id);
  // The page's own (written from the draft) and what it removed: left out of the solution's copy.
  const pageHas = (id: string) => shown.get(id) === "client" || (wasShown.has(id) && !shown.has(id));
  const prune = (n: XmlNode): XmlNode | undefined =>
    n.attrs.Id && pageHas(n.attrs.Id) ? undefined : { ...n, children: n.children.map(prune).filter((x): x is XmlNode => !!x) };
  for (const ca of published.customActions) {
    if (m.customActions.some((x) => (x.id === ca.id && x.location === ca.location) || (!!ca.element.attrs.Id && x.element.attrs.Id === ca.element.attrs.Id))) continue;
    const element = prune(ca.element);
    if (element) m.customActions.push({ ...ca, element, placed: false });
  }
  const merge = <T extends { origin: RibbonOrigin }>(mine: Record<string, T>, was: Record<string, T>, theirs: Record<string, T>) => {
    for (const [id, x] of Object.entries(theirs)) {
      if (mine[id]?.origin === "client" || (was[id] && !mine[id])) continue;
      mine[id] = { ...x, origin: "client" };
    }
  };
  merge(m.commands, original.commands, published.commands);
  merge(m.enableRules, original.enableRules, published.enableRules);
  merge(m.displayRules, original.displayRules, published.displayRules);
  for (const h of published.hidden) {
    const same = (x: { id: string; location: string }) => x.id === h.id && x.location === h.location;
    const at = m.hidden.find(same);
    if (at) at.origin = "client";
    else if (!original.hidden.some(same)) m.hidden.push({ ...h, origin: "client" });
  }
  for (const [key, titles] of Object.entries(published.locLabels)) if (!m.locLabels[key]?.length) m.locLabels[key] = titles;
  const groupTemplates = (list: XmlNode[] = []) => list.flatMap((t) => t.children);
  const have = groupTemplates(m.templates);
  const moreTemplates = groupTemplates(published.templates).filter((g) => !have.some((x) => x.attrs.Id === g.attrs.Id));
  if (moreTemplates.length) m.templates = [el("RibbonTemplates", { Id: m.templates?.[0]?.attrs.Id ?? published.templates[0]?.attrs.Id ?? "Mscrm.Templates" }, [...have, ...moreTemplates])];
  const tabRules = m.tabDisplayRules ?? [];
  const moreTabRules = published.tabDisplayRules.filter((r) => !tabRules.some((x) => x.attrs.TabCommand === r.attrs.TabCommand));
  if (moreTabRules.length) m.tabDisplayRules = [...tabRules, ...moreTabRules];
  return m;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Puts a RibbonDiffXml into the table's <Entity> of a customizations.xml (a local one
 * or an exported solution's), replacing the one there or adding it. Undefined when
 * the file has no <Entity> for the table.
 */
export function replaceEntityRibbonDiff(text: string, table: string, diffXml: string): string | undefined {
  const entityRe = /<Entity>[\s\S]*?<\/Entity>/g;
  const nameRe = new RegExp(`<Name\\b[^>]*>\\s*${escapeRe(table)}\\s*</Name>`, "i");
  let m: RegExpExecArray | null;
  while ((m = entityRe.exec(text))) {
    const block = m[0];
    const nameAt = block.search(/<Name\b/);
    // The table's own <Name>, not one inside its forms or views.
    if (nameAt < 0 || !nameRe.test(block.slice(nameAt, block.indexOf("</Name>", nameAt) + 7))) continue;
    const body = diffXml.replace(/^<\?xml[^>]*>\s*/, "");
    const replaced = /<RibbonDiffXml[\s\S]*?<\/RibbonDiffXml>|<RibbonDiffXml\s*\/>/.test(block)
      ? block.replace(/<RibbonDiffXml[\s\S]*?<\/RibbonDiffXml>|<RibbonDiffXml\s*\/>/, () => body)
      : block.replace(/<\/Entity>$/, () => `${body}\n</Entity>`);
    return text.slice(0, m.index) + replaced + text.slice(m.index + block.length);
  }
  return undefined;
}

// ---------- changes and validation ----------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed between the loaded model and the edited one, in words. */
export function ribbonChanges(before: RibbonModel, after: RibbonModel): string[] {
  const out: string[] = [];
  const controlsOf = (m: RibbonModel) => {
    const map = new Map<string, RibbonControl>();
    for (const c of allControls(m)) map.set(c.id, c);
    return map;
  };
  const was = controlsOf(before);
  const now = controlsOf(after);
  const strip = (c: RibbonControl) => ({ ...c, children: c.children.map((k) => k.id), fresh: undefined, localOnly: undefined });
  for (const [id, c] of now) {
    const w = was.get(id);
    if (!w) out.push(`added ${c.label || id}`);
    else if (!same(strip(w), strip(c))) out.push(`changed ${c.label || id}`);
  }
  for (const [id, c] of was) if (!now.has(id)) out.push(`removed ${c.label || id}`);
  const hiddenKey = (h: HiddenControl) => `${h.id}@${h.location}`;
  for (const h of after.hidden) if (!before.hidden.some((x) => hiddenKey(x) === hiddenKey(h))) out.push(`hid ${h.id.split(".").pop()}`);
  for (const h of before.hidden) if (!after.hidden.some((x) => hiddenKey(x) === hiddenKey(h))) out.push(`unhid ${h.id.split(".").pop()}`);
  const diffRecords = <T extends { fresh?: boolean }>(a: Record<string, T>, b: Record<string, T>, what: string) => {
    for (const [id, v] of Object.entries(b)) {
      if (!a[id]) out.push(`added ${what} ${id}`);
      else if (!same({ ...a[id], fresh: undefined }, { ...v, fresh: undefined })) out.push(`changed ${what} ${id}`);
    }
    for (const id of Object.keys(a)) if (!b[id]) out.push(`removed ${what} ${id}`);
  };
  diffRecords(before.commands, after.commands, "command");
  diffRecords(before.enableRules, after.enableRules, "enable rule");
  diffRecords(before.displayRules, after.displayRules, "display rule");
  const modernWas = new Map(before.modern.map((m) => [m.id ?? m.uniqueName, m]));
  for (const m of after.modern) {
    const w = modernWas.get(m.id ?? m.uniqueName);
    if (m.removed) {
      if (w) out.push(`removed modern command ${m.label || m.uniqueName}`);
    } else if (!w) out.push(`added modern command ${m.label || m.uniqueName}`);
    else if (!same({ ...w, fresh: undefined }, { ...m, fresh: undefined })) out.push(`changed modern command ${m.label || m.uniqueName}`);
  }
  return out;
}

export interface EditProblem {
  field: string;
  text: string;
}

const ID_RE = /^[A-Za-z_][\w.]*$/;
const FN_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/**
 * What Dataverse would reject or the command bar would break on, each keyed to the
 * field on the page: ids, labels, commands that exist, function and library names,
 * sequences, and the publisher prefix on new ids (when known).
 */
export function ribbonEditProblems(model: RibbonModel, opts: { prefix?: string } = {}): EditProblem[] {
  const out: EditProblem[] = [];
  const ids = new Map<string, number>();
  for (const c of allControls(model)) ids.set(c.id, (ids.get(c.id) ?? 0) + 1);
  const prefixOk = (id: string) => !opts.prefix || id.toLowerCase().startsWith(`${opts.prefix.toLowerCase()}.`) || id.toLowerCase().startsWith(`${opts.prefix.toLowerCase()}_`);
  for (const t of model.tabs) {
    for (const g of t.groups) {
      for (const c of g.controls) {
        const walk = (c: RibbonControl, inMenu: boolean) => {
          const key = (f: string) => `control:${c.id}:${f}`;
          if (c.origin === "client") {
            if (!c.id.trim()) out.push({ field: key("id"), text: "The control needs an Id." });
            else if (!ID_RE.test(c.id)) out.push({ field: key("id"), text: "Use letters, digits, dots and underscores in the Id." });
            else if ((ids.get(c.id) ?? 0) > 1) out.push({ field: key("id"), text: "Another control has this Id." });
            else if (c.fresh && !prefixOk(c.id)) out.push({ field: key("id"), text: `Start the Id with ${opts.prefix} (the publisher prefix).` });
            if (c.kind !== "menuSection" && c.kind !== "label" && !c.label.trim()) out.push({ field: key("label"), text: "The button needs a label." });
            if (c.kind === "button" && !c.command) out.push({ field: key("command"), text: "Pick or create the command the button runs." });
            if (c.command && !model.commands[c.command]) out.push({ field: key("command"), text: `There's no command named ${c.command} in this ribbon.` });
            if (c.sequence !== undefined && !(Number.isFinite(c.sequence) && c.sequence >= 0)) out.push({ field: key("sequence"), text: "The sequence is a number, 0 or more." });
            if (!inMenu && c.sequence === undefined) out.push({ field: key("sequence"), text: "Give the button a sequence (its place in the group)." });
          }
          for (const k of c.children) walk(k, true);
        };
        walk(c, false);
      }
    }
  }
  for (const cmd of Object.values(model.commands)) {
    if (cmd.origin !== "client") continue;
    const key = (f: string) => `command:${cmd.id}:${f}`;
    if (cmd.takenId) out.push({ field: key("id"), text: `Another command has the Id ${cmd.takenId}.` });
    else if (!ID_RE.test(cmd.id)) out.push({ field: key("id"), text: "Use letters, digits, dots and underscores in the Id." });
    else if (cmd.fresh && !prefixOk(cmd.id)) out.push({ field: key("id"), text: `Start the Id with ${opts.prefix} (the publisher prefix).` });
    if (!cmd.actions.length) out.push({ field: key("actions"), text: "The command needs at least one action." });
    cmd.actions.forEach((a, i) => {
      if (a.kind === "JavaScriptFunction") {
        if (!a.functionName?.trim()) out.push({ field: key(`action:${i}:function`), text: "Name the function." });
        else if (!FN_RE.test(a.functionName.trim())) out.push({ field: key(`action:${i}:function`), text: "Use a JavaScript name like Acme.Account.approve." });
        if (!a.webResource?.trim() && !a.library?.trim()) out.push({ field: key(`action:${i}:library`), text: "Name the web resource that defines the function." });
      } else if (a.kind === "Url" && !a.url?.trim()) out.push({ field: key(`action:${i}:url`), text: "Enter the address to open." });
    });
    for (const id of cmd.enableRules) if (!model.enableRules[id]) out.push({ field: key("enableRules"), text: `There's no enable rule named ${id}.` });
    for (const id of cmd.displayRules) if (!model.displayRules[id]) out.push({ field: key("displayRules"), text: `There's no display rule named ${id}.` });
  }
  for (const r of [...Object.values(model.enableRules), ...Object.values(model.displayRules)]) {
    if (r.origin !== "client") continue;
    const key = (f: string) => `rule:${r.kind}:${r.id}:${f}`;
    if (r.takenId) out.push({ field: key("id"), text: `Another ${r.kind} rule has the Id ${r.takenId}.` });
    else if (!ID_RE.test(r.id)) out.push({ field: key("id"), text: "Use letters, digits, dots and underscores in the Id." });
    else if (r.fresh && !prefixOk(r.id)) out.push({ field: key("id"), text: `Start the Id with ${opts.prefix} (the publisher prefix).` });
    if (!r.steps.length) out.push({ field: key("steps"), text: "The rule needs at least one step." });
    r.steps.forEach((s, i) => {
      if (s.kind === "CustomRule") {
        if (!s.functionName?.trim()) out.push({ field: key(`step:${i}:function`), text: "Name the function." });
        else if (!FN_RE.test(s.functionName.trim())) out.push({ field: key(`step:${i}:function`), text: "Use a JavaScript name like Acme.Account.canApprove." });
        if (!s.webResource?.trim() && !s.library?.trim()) out.push({ field: key(`step:${i}:library`), text: "Name the web resource that defines the function." });
      }
      if (s.kind === "ValueRule" && !s.attrs.Field?.trim()) out.push({ field: key(`step:${i}:Field`), text: "Name the column." });
      if (s.kind === "EntityPrivilegeRule" && !s.attrs.PrivilegeType) out.push({ field: key(`step:${i}:PrivilegeType`), text: "Pick the privilege." });
      if (s.kind === "FormStateRule" && !s.attrs.State) out.push({ field: key(`step:${i}:State`), text: "Pick the form state." });
    });
  }
  const modernNames = new Map<string, number>();
  for (const m of model.modern) if (!m.removed) modernNames.set(m.uniqueName, (modernNames.get(m.uniqueName) ?? 0) + 1);
  for (const m of model.modern) {
    if (m.removed) continue;
    const key = (f: string) => `modern:${m.id ?? m.uniqueName}:${f}`;
    if (!m.uniqueName.trim()) out.push({ field: key("uniqueName"), text: "The command needs a unique name." });
    else if (!/^[A-Za-z_][\w.]*$/.test(m.uniqueName)) out.push({ field: key("uniqueName"), text: "Use letters, digits, dots and underscores in the unique name." });
    else if ((modernNames.get(m.uniqueName) ?? 0) > 1) out.push({ field: key("uniqueName"), text: "Another modern command has this unique name." });
    else if (m.fresh && opts.prefix && !m.uniqueName.toLowerCase().startsWith(`${opts.prefix.toLowerCase()}_`) && !m.uniqueName.toLowerCase().startsWith(`${opts.prefix.toLowerCase()}.`)) out.push({ field: key("uniqueName"), text: `Start the unique name with ${opts.prefix}_ (the publisher prefix).` });
    if (m.type !== 3 && !m.label.trim()) out.push({ field: key("label"), text: "The button needs a label." });
    if (m.fresh && !m.app) out.push({ field: key("app"), text: "Pick the app the command belongs to." });
    if (m.onClick.type === 2) {
      if (!m.onClick.functionName?.trim()) out.push({ field: key("function"), text: "Name the function." });
      else if (!FN_RE.test(m.onClick.functionName.trim())) out.push({ field: key("function"), text: "Use a JavaScript name like Acme.Account.approve." });
      if (!m.onClick.library?.trim()) out.push({ field: key("library"), text: "Name the JavaScript web resource." });
    }
    if (m.sequence !== undefined && !(Number.isFinite(m.sequence) && m.sequence >= 0)) out.push({ field: key("sequence"), text: "The sequence is a number, 0 or more." });
  }
  return out;
}

/** A new button for a group, with Ids the publisher prefix and table make unique enough. */
export function newButton(model: RibbonModel, groupId: string, prefix: string, name = "NewButton"): RibbonControl {
  const base = `${prefix || "new"}.${model.table}.${name}`;
  let id = `${base}.Button`;
  const taken = new Set([...allControls(model)].map((c) => c.id));
  for (let n = 2; taken.has(id); n++) id = `${base}${n}.Button`;
  const group = model.tabs.flatMap((t) => t.groups).find((g) => g.id === groupId);
  const last = Math.max(0, ...(group?.controls.map((c) => c.sequence ?? 0) ?? []));
  return {
    id,
    kind: "button",
    tag: "Button",
    attrs: { TemplateAlias: "o1" },
    label: "New button",
    labelKey: `$LocLabels:${labelKeyFor(id, "LabelText")}`,
    command: undefined,
    sequence: last + 10,
    children: [],
    origin: "client",
    localOnly: true,
    fresh: true,
  };
}
