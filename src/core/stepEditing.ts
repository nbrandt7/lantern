import { DataverseClient } from "./dataverse";

/**
 * Reading, changing and unregistering a registered plug-in step and its images,
 * with what the Plugin Registration Tool's Update Step lets you change. Message,
 * table and plug-in class stay: a step for another event is a new step.
 */

export const STAGE_LABELS: Record<number, string> = { 10: "Pre-validation", 20: "Pre-operation", 30: "Main operation", 40: "Post-operation" };
export const IMAGE_LABELS: Record<number, string> = { 0: "Pre-image", 1: "Post-image", 2: "Pre- and post-image" };

export interface StepImage {
  /** Undefined for an image added in this edit. */
  id?: string;
  alias: string;
  /** 0 pre, 1 post, 2 both. */
  type: number;
  /** Empty: all columns. */
  columns: string[];
  messageProperty: string;
  removed?: boolean;
}

export interface StepDraft {
  name: string;
  description: string;
  stage: number;
  /** 0 synchronous, 1 asynchronous. */
  mode: number;
  rank: number;
  filtering: string[];
  runAs?: { id: string; label: string };
  deleteJobOnSuccess: boolean;
  configuration: string;
  /** Write-only: whether one is stored, and the new value when it's being replaced (null: remove it). */
  secureConfig: { stored: boolean; replacement?: string | null };
  images: StepImage[];
}

export interface LoadedStep {
  id: string;
  message: string;
  table: string;
  typeName: string;
  managed: boolean;
  enabled: boolean;
  secureConfigId?: string;
  draft: StepDraft;
}

interface StepRow {
  name: string;
  description: string | null;
  stage: number;
  mode: number;
  rank: number;
  statecode: number;
  ismanaged: boolean;
  filteringattributes: string | null;
  configuration: string | null;
  asyncautodelete: boolean | null;
  _impersonatinguserid_value?: string | null;
  "_impersonatinguserid_value@OData.Community.Display.V1.FormattedValue"?: string;
  _sdkmessageprocessingstepsecureconfigid_value?: string | null;
  sdkmessageid?: { name?: string } | null;
  sdkmessagefilterid?: { primaryobjecttypecode?: string } | null;
  plugintypeid?: { typename?: string } | null;
}

const split = (s: string | null | undefined) => (s ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

export async function loadStep(dv: DataverseClient, id: string): Promise<LoadedStep> {
  const s = await dv.getJson<StepRow>(
    `sdkmessageprocessingsteps(${id})?$select=name,description,stage,mode,rank,statecode,ismanaged,filteringattributes,configuration,asyncautodelete,_impersonatinguserid_value,_sdkmessageprocessingstepsecureconfigid_value` +
      "&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode),plugintypeid($select=typename)",
    { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' }
  );
  const images = await dv.getAll<{ sdkmessageprocessingstepimageid: string; entityalias: string; name: string; imagetype: number; attributes: string | null; messagepropertyname: string | null }>(
    `sdkmessageprocessingstepimages?$select=sdkmessageprocessingstepimageid,entityalias,name,imagetype,attributes,messagepropertyname&$filter=_sdkmessageprocessingstepid_value eq ${id}`
  );
  const table = s.sdkmessagefilterid?.primaryobjecttypecode ?? "";
  return {
    id,
    message: s.sdkmessageid?.name ?? "",
    table: table === "none" ? "" : table,
    typeName: s.plugintypeid?.typename ?? "",
    managed: s.ismanaged === true,
    enabled: s.statecode === 0,
    secureConfigId: s._sdkmessageprocessingstepsecureconfigid_value ?? undefined,
    draft: {
      name: s.name,
      description: s.description ?? "",
      stage: s.stage,
      mode: s.mode,
      rank: s.rank ?? 1,
      filtering: split(s.filteringattributes),
      runAs: s._impersonatinguserid_value ? { id: s._impersonatinguserid_value, label: s["_impersonatinguserid_value@OData.Community.Display.V1.FormattedValue"] ?? s._impersonatinguserid_value } : undefined,
      deleteJobOnSuccess: s.asyncautodelete === true,
      configuration: s.configuration ?? "",
      secureConfig: { stored: !!s._sdkmessageprocessingstepsecureconfigid_value },
      images: images
        .map((i) => ({ id: i.sdkmessageprocessingstepimageid, alias: i.entityalias || i.name, type: i.imagetype, columns: split(i.attributes), messageProperty: i.messagepropertyname || "Target" }))
        .sort((a, b) => a.type - b.type || a.alias.localeCompare(b.alias)),
    },
  };
}

/** The message property an image of this message is taken from. */
export function imageMessageProperty(message: string): string {
  const m = message.toLowerCase();
  if (m === "create") return "Id";
  if (m === "setstate" || m === "setstatedynamicentity") return "EntityMoniker";
  return "Target";
}

/** What Dataverse would refuse, before anything is sent. Empty when the draft can be saved. */
export function stepProblems(step: Pick<LoadedStep, "message">, d: StepDraft): string[] {
  const problems: string[] = [];
  const message = step.message.toLowerCase();
  if (!d.name.trim()) problems.push("The step needs a name.");
  if (d.mode === 1 && d.stage !== 40) problems.push("Asynchronous steps can only run post-operation.");
  if (!Number.isInteger(d.rank) || d.rank < 0) problems.push("The execution order is a whole number.");
  if (d.filtering.length && message !== "update") problems.push("Filtering columns only apply to Update steps.");
  // Saving "" would store an empty secure configuration rather than none.
  if (d.secureConfig.replacement === "") problems.push(`Type the secure configuration, or choose ${d.secureConfig.stored ? "Keep the stored one" : "None"}.`);
  for (const i of d.images.filter((x) => !x.removed)) {
    if (!i.alias.trim()) problems.push("Every image needs an alias.");
    if ((i.type === 1 || i.type === 2) && d.stage !== 40) problems.push(`The post-image "${i.alias}" only works post-operation.`);
    if ((i.type === 0 || i.type === 2) && message === "create") problems.push(`Create has no pre-image ("${i.alias}"): the row doesn't exist yet.`);
    if ((i.type === 1 || i.type === 2) && message === "delete") problems.push(`Delete has no post-image ("${i.alias}"): the row is gone.`);
  }
  const aliases = d.images.filter((x) => !x.removed).map((x) => x.alias.trim().toLowerCase());
  if (new Set(aliases).size !== aliases.length) problems.push("Two images have the same alias.");
  return [...new Set(problems)];
}

export interface StepChanges {
  step: Record<string, unknown>;
  /** Navigation properties to clear (DELETE .../$ref). */
  clear: string[];
  images: { create: StepImage[]; update: Array<{ id: string; patch: Record<string, unknown> }>; remove: string[] };
  secureConfig?: { value: string } | { remove: true };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function stepChanges(was: StepDraft, now: StepDraft): StepChanges {
  const step: Record<string, unknown> = {};
  const clear: string[] = [];
  if (now.name !== was.name) step.name = now.name.trim();
  if (now.description !== was.description) step.description = now.description || null;
  if (now.stage !== was.stage) step.stage = now.stage;
  if (now.mode !== was.mode) step.mode = now.mode;
  if (now.rank !== was.rank) step.rank = now.rank;
  if (!same([...now.filtering].sort(), [...was.filtering].sort())) step.filteringattributes = now.filtering.length ? now.filtering.join(",") : null;
  if (now.configuration !== was.configuration) step.configuration = now.configuration || null;
  const deleteJob = now.mode === 1 && now.deleteJobOnSuccess;
  if (deleteJob !== (was.mode === 1 && was.deleteJobOnSuccess)) step.asyncautodelete = deleteJob;
  if (now.runAs?.id !== was.runAs?.id) {
    if (now.runAs) step["impersonatinguserid@odata.bind"] = `/systemusers(${now.runAs.id})`;
    else clear.push("impersonatinguserid");
  }
  const images: StepChanges["images"] = { create: [], update: [], remove: [] };
  for (const i of now.images) {
    if (i.removed) {
      if (i.id) images.remove.push(i.id);
      continue;
    }
    if (!i.id) {
      images.create.push(i);
      continue;
    }
    const before = was.images.find((x) => x.id === i.id);
    if (!before) continue;
    const patch: Record<string, unknown> = {};
    if (i.alias !== before.alias) Object.assign(patch, { entityalias: i.alias.trim(), name: i.alias.trim() });
    if (i.type !== before.type) patch.imagetype = i.type;
    if (!same([...i.columns].sort(), [...before.columns].sort())) patch.attributes = i.columns.length ? i.columns.join(",") : null;
    if (Object.keys(patch).length) images.update.push({ id: i.id, patch });
  }
  const r = now.secureConfig.replacement;
  const secureConfig = r === undefined ? undefined : r === null ? (was.secureConfig.stored ? { remove: true as const } : undefined) : { value: r };
  return { step, clear, images, ...(secureConfig ? { secureConfig } : {}) };
}

export const changeCount = (c: StepChanges) =>
  Object.keys(c.step).length + c.clear.length + c.images.create.length + c.images.update.length + c.images.remove.length + (c.secureConfig ? 1 : 0);

/** Sends the changes: the step, then its images, then the secure configuration. */
export async function saveStep(dv: DataverseClient, step: Pick<LoadedStep, "id" | "secureConfigId">, c: StepChanges, solution?: string, log?: (line: string) => void): Promise<void> {
  const headers: Record<string, string> = solution ? { "MSCRM.SolutionUniqueName": solution } : {};
  if (Object.keys(c.step).length) {
    await dv.update(`sdkmessageprocessingsteps(${step.id})`, c.step);
    log?.(`Updated the step: ${Object.keys(c.step).map((k) => k.replace("@odata.bind", "")).join(", ")}\n`);
  }
  for (const nav of c.clear) {
    await dv.remove(`sdkmessageprocessingsteps(${step.id})/${nav}/$ref`);
    log?.(`Cleared ${nav}\n`);
  }
  for (const id of c.images.remove) {
    await dv.remove(`sdkmessageprocessingstepimages(${id})`);
    log?.("Removed an image\n");
  }
  for (const u of c.images.update) {
    await dv.update(`sdkmessageprocessingstepimages(${u.id})`, u.patch);
    log?.(`Updated image ${String(u.patch.entityalias ?? "")}\n`.replace(/ \n$/, "\n"));
  }
  for (const i of c.images.create) {
    await dv.create(
      "sdkmessageprocessingstepimages",
      {
        name: i.alias.trim(),
        entityalias: i.alias.trim(),
        imagetype: i.type,
        messagepropertyname: i.messageProperty,
        ...(i.columns.length ? { attributes: i.columns.join(",") } : {}),
        "sdkmessageprocessingstepid@odata.bind": `/sdkmessageprocessingsteps(${step.id})`,
      },
      headers
    );
    log?.(`Added image ${i.alias.trim()}\n`);
  }
  if (c.secureConfig && "value" in c.secureConfig) {
    if (step.secureConfigId) {
      await dv.update(`sdkmessageprocessingstepsecureconfigs(${step.secureConfigId})`, { secureconfig: c.secureConfig.value });
    } else {
      const id = await dv.create("sdkmessageprocessingstepsecureconfigs", { secureconfig: c.secureConfig.value });
      await dv.update(`sdkmessageprocessingsteps(${step.id})`, { "sdkmessageprocessingstepsecureconfigid@odata.bind": `/sdkmessageprocessingstepsecureconfigs(${id})` });
    }
    log?.("Saved the secure configuration\n");
  } else if (c.secureConfig && step.secureConfigId) {
    await dv.remove(`sdkmessageprocessingsteps(${step.id})/sdkmessageprocessingstepsecureconfigid/$ref`);
    await dv.remove(`sdkmessageprocessingstepsecureconfigs(${step.secureConfigId})`);
    log?.("Removed the secure configuration\n");
  }
}

/** Unregisters a step. Its images go with it; its secure configuration (often credentials) is deleted after. */
export async function unregisterStep(dv: DataverseClient, step: Pick<LoadedStep, "id" | "secureConfigId">): Promise<void> {
  await dv.remove(`sdkmessageprocessingsteps(${step.id})`);
  if (step.secureConfigId) {
    try {
      await dv.remove(`sdkmessageprocessingstepsecureconfigs(${step.secureConfigId})`);
    } catch {
      // the step is gone; a leftover secure configuration does nothing
    }
  }
}
