import { DataverseClient } from "./dataverse";
import { UserError } from "./errors";
import { ModernCommand } from "./ribbonModel";

/**
 * Modern commands (the appaction table): the buttons the command designer adds to
 * an app's command bar for a table. Read for the command bar page, written back
 * row by row through the Web API, then the app is published so the bar picks them up.
 */

const SELECT = [
  "appactionid", "name", "uniquename", "buttonlabeltext", "buttontooltiptitle", "buttontooltipdescription", "location", "type", "sequence", "hidden", "isdisabled", "grouptitle", "fonticon",
  "onclickeventtype", "onclickeventjavascriptfunctionname", "onclickeventjavascriptparameters", "onclickeventformulafunctionname", "onclickeventformulacomponentname", "onclickeventformulacomponentlibrary",
  "visibilitytype", "visibilityformulafunctionname", "visibilityformulacomponentname", "visibilityformulacomponentlibrary",
  "_appmoduleid_value", "_parentappactionid_value", "_iconwebresourceid_value", "_onclickeventjavascriptwebresourceid_value", "contextvalue",
].join(",");

interface AppActionRow {
  appactionid: string;
  name: string | null;
  uniquename: string | null;
  buttonlabeltext: string | null;
  buttontooltiptitle: string | null;
  buttontooltipdescription: string | null;
  location: number | null;
  type: number | null;
  sequence: number | null;
  hidden: boolean | null;
  isdisabled: boolean | null;
  grouptitle: string | null;
  fonticon: string | null;
  onclickeventtype: number | null;
  onclickeventjavascriptfunctionname: string | null;
  onclickeventjavascriptparameters: string | null;
  onclickeventformulafunctionname: string | null;
  onclickeventformulacomponentname: string | null;
  onclickeventformulacomponentlibrary: string | null;
  visibilitytype: number | null;
  visibilityformulafunctionname: string | null;
  visibilityformulacomponentname: string | null;
  visibilityformulacomponentlibrary: string | null;
  _appmoduleid_value: string | null;
  _parentappactionid_value: string | null;
  _iconwebresourceid_value: string | null;
  _onclickeventjavascriptwebresourceid_value: string | null;
  appmoduleid?: { appmoduleid: string; name: string | null; uniquename: string | null } | null;
  iconwebresourceid?: { webresourceid: string; name: string | null } | null;
  onclickeventjavascriptwebresourceid?: { webresourceid: string; name: string | null } | null;
}

export interface AppChoice {
  id: string;
  name: string;
  uniqueName: string;
}

const q = (s: string) => s.replace(/'/g, "''");

/** The modern commands of a table, every app. Empty when the environment has no appaction table yet. */
export async function fetchModernCommands(dv: DataverseClient, table: string): Promise<ModernCommand[]> {
  let rows: AppActionRow[];
  try {
    rows = await dv.getAll<AppActionRow>(
      `appactions?$select=${SELECT}&$filter=contextvalue eq '${q(table)}' and statecode eq 0&$expand=appmoduleid($select=appmoduleid,name,uniquename),iconwebresourceid($select=webresourceid,name),onclickeventjavascriptwebresourceid($select=webresourceid,name)`
    );
  } catch (err) {
    // An older environment, or no read privilege on appaction: the classic ribbon still shows.
    if (/404|Resource not found|appaction/i.test(err instanceof Error ? err.message : String(err))) return [];
    throw err;
  }
  return rows.map(rowToCommand).sort((a, b) => a.location - b.location || (a.app?.name ?? "").localeCompare(b.app?.name ?? "") || (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function rowToCommand(r: AppActionRow): ModernCommand {
  return {
    id: r.appactionid,
    uniqueName: r.uniquename ?? "",
    name: r.name ?? r.uniquename ?? "",
    label: r.buttonlabeltext ?? "",
    tooltipTitle: r.buttontooltiptitle ?? undefined,
    tooltipDescription: r.buttontooltipdescription ?? undefined,
    location: r.location ?? 0,
    type: r.type ?? 0,
    sequence: r.sequence ?? undefined,
    app: r.appmoduleid ? { id: r.appmoduleid.appmoduleid, name: r.appmoduleid.name ?? r.appmoduleid.uniquename ?? "", uniqueName: r.appmoduleid.uniquename ?? undefined } : r._appmoduleid_value ? { id: r._appmoduleid_value, name: "" } : undefined,
    hidden: r.hidden === true,
    disabled: r.isdisabled === true,
    parentId: r._parentappactionid_value ?? undefined,
    groupTitle: r.grouptitle ?? undefined,
    onClick: {
      type: r.onclickeventtype ?? 0,
      functionName: r.onclickeventjavascriptfunctionname ?? undefined,
      library: r.onclickeventjavascriptwebresourceid?.name ?? undefined,
      libraryId: r.onclickeventjavascriptwebresourceid?.webresourceid ?? r._onclickeventjavascriptwebresourceid_value ?? undefined,
      parameters: r.onclickeventjavascriptparameters ?? undefined,
      formulaFunction: r.onclickeventformulafunctionname ?? undefined,
      formulaComponent: r.onclickeventformulacomponentname ?? undefined,
      formulaLibrary: r.onclickeventformulacomponentlibrary ?? undefined,
    },
    visibility: {
      type: r.visibilitytype ?? 0,
      formulaFunction: r.visibilityformulafunctionname ?? undefined,
      formulaComponent: r.visibilityformulacomponentname ?? undefined,
      formulaLibrary: r.visibilityformulacomponentlibrary ?? undefined,
    },
    icon: { fontIcon: r.fonticon ?? undefined, webResource: r.iconwebresourceid?.name ?? undefined, webResourceId: r.iconwebresourceid?.webresourceid ?? r._iconwebresourceid_value ?? undefined },
  };
}

/** The model-driven apps of the environment, for a new command's app. */
export async function fetchApps(dv: DataverseClient): Promise<AppChoice[]> {
  const rows = await dv.getAll<{ appmoduleid: string; name: string | null; uniquename: string | null }>("appmodules?$select=appmoduleid,name,uniquename&$filter=statecode eq 0&$orderby=name");
  return rows.map((r) => ({ id: r.appmoduleid, name: r.name ?? r.uniquename ?? "", uniqueName: r.uniquename ?? "" }));
}

/** The appaction columns a command's editable fields map to (lookups aside). */
export function commandBody(m: ModernCommand, table: string): Record<string, unknown> {
  return {
    name: m.name || m.label || m.uniqueName,
    uniquename: m.uniqueName,
    buttonlabeltext: m.label || null,
    buttontooltiptitle: m.tooltipTitle || null,
    buttontooltipdescription: m.tooltipDescription || null,
    location: m.location,
    type: m.type,
    sequence: m.sequence ?? null,
    hidden: m.hidden,
    isdisabled: m.disabled,
    grouptitle: m.groupTitle || null,
    fonticon: m.icon.fontIcon || null,
    context: 1,
    contextvalue: table,
    onclickeventtype: m.onClick.type,
    onclickeventjavascriptfunctionname: m.onClick.type === 2 ? m.onClick.functionName || null : null,
    onclickeventjavascriptparameters: m.onClick.type === 2 ? m.onClick.parameters || null : null,
    onclickeventformulafunctionname: m.onClick.type === 1 ? m.onClick.formulaFunction || null : null,
    onclickeventformulacomponentname: m.onClick.type === 1 ? m.onClick.formulaComponent || null : null,
    onclickeventformulacomponentlibrary: m.onClick.type === 1 ? m.onClick.formulaLibrary || null : null,
    visibilitytype: m.visibility.type,
    visibilityformulafunctionname: m.visibility.type === 1 ? m.visibility.formulaFunction || null : null,
    visibilityformulacomponentname: m.visibility.type === 1 ? m.visibility.formulaComponent || null : null,
    visibilityformulacomponentlibrary: m.visibility.type === 1 ? m.visibility.formulaLibrary || null : null,
  };
}

/** What changed, so only those rows are written. */
export interface ModernChanges {
  create: ModernCommand[];
  update: ModernCommand[];
  remove: ModernCommand[];
}

export function modernChanges(before: ModernCommand[], after: ModernCommand[]): ModernChanges {
  const was = new Map(before.map((m) => [m.id ?? "", m]));
  const out: ModernChanges = { create: [], update: [], remove: [] };
  for (const m of after) {
    if (m.removed) {
      if (m.id && was.has(m.id)) out.remove.push(m);
    } else if (!m.id) out.create.push(m);
    else if (JSON.stringify({ ...was.get(m.id), fresh: undefined }) !== JSON.stringify({ ...m, fresh: undefined })) out.update.push(m);
  }
  return out;
}

/**
 * What earlier Saves of one page wrote, so saving again after one stopped part-way doesn't
 * write it twice: `before` (the rows as loaded) follows each row written, and rows the page
 * added are matched by unique name, since the page never learns their IDs.
 */
export class ModernSaveTracker {
  private readonly created = new Map<string, string>();

  constructor(private readonly before: ModernCommand[]) {}

  /**
   * What the draft changes from the rows as they are now. Rows already created get their IDs
   * (on the draft too); one created since that the draft no longer has (discarded, or renamed
   * on the page) is deleted.
   */
  changes(draft: ModernCommand[]): ModernChanges {
    for (const m of draft) if (!m.id && this.created.has(m.uniqueName)) m.id = this.created.get(m.uniqueName);
    const dropped = [...this.created.values()]
      .filter((id) => !draft.some((m) => m.id === id))
      .flatMap((id) => this.before.filter((x) => x.id === id).map((x) => ({ ...x, removed: true })));
    return modernChanges(this.before, [...draft, ...dropped]);
  }

  /** saveModernCommands' `written`. */
  readonly written = (m: ModernCommand, what: "created" | "updated" | "removed", id: string): void => {
    const at = this.before.findIndex((x) => x.id === id);
    if (what === "removed") {
      if (at >= 0) this.before.splice(at, 1);
      return;
    }
    if (what === "created") this.created.set(m.uniqueName, id);
    const row: ModernCommand = { ...JSON.parse(JSON.stringify(m)), id };
    if (at >= 0) this.before[at] = row;
    else this.before.push(row);
  };
}

export interface SaveModernOptions {
  table: string;
  /** Added to this solution (new rows). */
  solution?: string;
  /** Resolves a web resource name to its ID (for the JavaScript library and the icon). */
  webResourceId: (name: string) => Promise<string | undefined>;
  log?: (line: string) => void;
  /** Called as each row is written (with its ID), so a caller can keep track when a later one fails. */
  written?: (m: ModernCommand, what: "created" | "updated" | "removed", id: string) => void;
}

/** A DELETE that answers 404 found nothing to delete: what it was for. */
async function removeIfThere(dv: DataverseClient, path: string): Promise<void> {
  try {
    await dv.remove(path);
  } catch (err) {
    if (!/\b404\b/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}

/**
 * Writes the changed modern commands: deletes, creates (in the solution) and updates,
 * resolving the library and icon web resources by name, then publishes every app
 * touched so the command bar shows the result. Returns the created rows' IDs by
 * unique name.
 */
export async function saveModernCommands(dv: DataverseClient, changes: ModernChanges, o: SaveModernOptions): Promise<Record<string, string>> {
  const created: Record<string, string> = {};
  const apps = new Set<string>();
  const webResource = async (name: string | undefined, what: string) => {
    if (!name) return undefined;
    const id = await o.webResourceId(name);
    if (!id) throw new UserError(`${what} ${name} isn't a web resource in the environment. Push it first.`);
    return id;
  };
  let entityId: string | undefined;
  const entityRef = async () => {
    if (!entityId) {
      const rows = await dv.getAll<{ entityid: string }>(`entities?$select=entityid&$filter=logicalname eq '${q(o.table)}'`);
      entityId = rows[0]?.entityid;
    }
    return entityId;
  };
  for (const m of changes.remove) {
    o.log?.(`Deleting modern command ${m.uniqueName}`);
    // Already gone (deleted by an earlier Save that stopped later on, or by someone else) is fine.
    await removeIfThere(dv, `appactions(${m.id})`);
    if (m.app) apps.add(m.app.id);
    o.written?.(m, "removed", m.id ?? "");
  }
  for (const m of [...changes.create, ...changes.update]) {
    const body = commandBody(m, o.table);
    const libraryId = m.onClick.type === 2 ? await webResource(m.onClick.library, "The library") : undefined;
    const iconId = await webResource(m.icon.webResource, "The icon");
    if (m.app) body["appmoduleid@odata.bind"] = `/appmodules(${m.app.id})`;
    if (m.parentId) body["parentappactionid@odata.bind"] = `/appactions(${m.parentId})`;
    if (libraryId) body["onclickeventjavascriptwebresourceid@odata.bind"] = `/webresourceset(${libraryId})`;
    if (iconId) body["iconwebresourceid@odata.bind"] = `/webresourceset(${iconId})`;
    if (m.app) apps.add(m.app.id);
    if (!m.id) {
      const entity = await entityRef();
      if (entity) body["contextentity@odata.bind"] = `/entities(${entity})`;
      o.log?.(`Creating modern command ${m.uniqueName}`);
      created[m.uniqueName] = await dv.create("appactions", body, o.solution ? { "MSCRM.SolutionUniqueName": o.solution } : {});
      o.written?.(m, "created", created[m.uniqueName]);
    } else {
      o.log?.(`Updating modern command ${m.uniqueName}`);
      await dv.update(`appactions(${m.id})`, body);
      // Cleared lookups can't be set to null in a PATCH; they're removed by reference (404: already empty).
      if (!libraryId && m.onClick.libraryId) await removeIfThere(dv, `appactions(${m.id})/onclickeventjavascriptwebresourceid/$ref`);
      if (!iconId && m.icon.webResourceId) await removeIfThere(dv, `appactions(${m.id})/iconwebresourceid/$ref`);
      o.written?.(m, "updated", m.id);
    }
  }
  if (apps.size) {
    o.log?.(`Publishing ${apps.size} app${apps.size === 1 ? "" : "s"}`);
    await dv.action("PublishXml", { ParameterXml: `<importexportxml><appmodules>${[...apps].map((id) => `<appmodule>{${id}}</appmodule>`).join("")}</appmodules></importexportxml>` });
  }
  return created;
}
