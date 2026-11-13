import { DataverseClient } from "./dataverse";
import { UserError } from "./errors";

/**
 * Reads what cloud flows do from their definitions (workflow.clientdata): the
 * trigger, every action with its connector and operation, nested in conditions,
 * switches, loops and scopes. Used to find flows by what they do ("send email")
 * and to outline a flow for someone, or an AI assistant, to explain.
 */

export interface FlowStep {
  name: string;
  kind: "trigger" | "action";
  type: string;
  /** shared_office365, shared_commondataserviceforapps, ... */
  connector?: string;
  operation?: string;
  /** Parameters as the designer shows them ("emailMessage/To"), when the step has any. */
  parameters: Record<string, unknown>;
  inputs: unknown;
  /** Trigger settings kept beside the inputs: a schedule's recurrence, a request trigger's kind. */
  recurrence?: Json;
  triggerKind?: string;
  /** "If yes", "Case Approved", "Apply to each", ... from the outside in. */
  branch: string[];
  depth: number;
  /** Condition, loop source, or switch subject; a trigger's conditions. */
  expression?: unknown;
}

export interface FlowDefinition {
  steps: FlowStep[];
  connectors: Array<{ connector: string; reference?: string }>;
}

const CONNECTOR_NAMES: Record<string, string> = {
  shared_commondataserviceforapps: "Dataverse",
  shared_commondataservice: "Dataverse (legacy)",
  shared_office365: "Office 365 Outlook",
  shared_outlook: "Outlook.com",
  shared_sendmail: "Mail",
  shared_sendgrid: "SendGrid",
  shared_smtp: "SMTP",
  shared_gmail: "Gmail",
  shared_teams: "Microsoft Teams",
  shared_sharepointonline: "SharePoint",
  shared_onedriveforbusiness: "OneDrive for Business",
  shared_excelonlinebusiness: "Excel Online (Business)",
  shared_approvals: "Approvals",
  shared_office365users: "Office 365 Users",
  shared_office365groups: "Office 365 Groups",
  shared_flowpush: "Notifications",
  shared_planner: "Planner",
  shared_webcontents: "HTTP with Microsoft Entra ID",
  shared_azureblob: "Azure Blob Storage",
  shared_sql: "SQL Server",
  shared_wordonlinebusiness: "Word Online (Business)",
  shared_powerplatformforadmins: "Power Platform for Admins",
};

export const connectorName = (connector: string): string => CONNECTOR_NAMES[connector.toLowerCase()] ?? connector.replace(/^shared_/, "");

const DATAVERSE_MESSAGES: Record<number, string> = {
  1: "added", 2: "deleted", 3: "modified", 4: "added or modified", 5: "added or deleted", 6: "modified or deleted", 7: "added, modified or deleted",
};
const DATAVERSE_SCOPES: Record<number, string> = { 1: "user", 2: "business unit", 3: "parent: child business unit", 4: "organization" };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** The definition inside clientdata, or an error a person can act on. */
export function parseFlow(clientdata: string | null | undefined): FlowDefinition {
  if (!clientdata) return { steps: [], connectors: [] };
  let data: Json;
  try {
    data = obj(JSON.parse(clientdata));
  } catch {
    throw new UserError("The flow's definition isn't valid JSON.");
  }
  const props = obj(data.properties);
  const definition = obj(props.definition);
  const refs = obj(props.connectionReferences);
  const connectorOfRef = (refName: string): string | undefined => {
    const ref = obj(refs[refName]);
    const api = obj(ref.api);
    // Flow definitions are user data: a name that isn't a string is treated as missing rather than crashing string handling later.
    if (typeof api.name === "string") return api.name;
    return typeof ref.id === "string" ? ref.id.split("/").pop() : undefined;
  };
  const steps: FlowStep[] = [];
  for (const [name, t] of Object.entries(obj(definition.triggers))) steps.push(step(name, obj(t), "trigger", [], 0, connectorOfRef));
  walk(obj(definition.actions), [], 0, steps, connectorOfRef);
  const connectors = Object.entries(refs).map(([reference, r]) => ({
    connector: connectorOfRef(reference) ?? reference,
    reference: ((name) => (typeof name === "string" ? name : reference))(obj(obj(r).connection).connectionReferenceLogicalName),
  }));
  return { steps, connectors };
}

/** Actions in run order: each one after the actions it runs after. */
function ordered(actions: Json): Array<[string, Json]> {
  const entries = Object.entries(actions).map(([n, a]) => [n, obj(a)] as [string, Json]);
  const done = new Set<string>();
  const out: Array<[string, Json]> = [];
  while (out.length < entries.length) {
    const next = entries.filter(([n, a]) => !done.has(n) && Object.keys(obj(a.runAfter)).every((dep) => done.has(dep) || !(dep in actions)));
    // A cycle or a broken definition: keep the rest in file order rather than looping.
    const batch = next.length ? next : entries.filter(([n]) => !done.has(n));
    for (const e of batch) {
      done.add(e[0]);
      out.push(e);
    }
  }
  return out;
}

function walk(actions: Json, branch: string[], depth: number, out: FlowStep[], refs: (n: string) => string | undefined): void {
  for (const [name, a] of ordered(actions)) {
    const s = step(name, a, "action", branch, depth, refs);
    out.push(s);
    const type = String(a.type ?? "").toLowerCase();
    if (type === "if") {
      walk(obj(a.actions), [...branch, `${name}: yes`], depth + 1, out, refs);
      walk(obj(obj(a.else).actions), [...branch, `${name}: no`], depth + 1, out, refs);
    } else if (type === "switch") {
      for (const [caseName, c] of Object.entries(obj(a.cases))) walk(obj(obj(c).actions), [...branch, `${name}: case ${String(obj(c).case ?? caseName)}`], depth + 1, out, refs);
      walk(obj(obj(a.default).actions), [...branch, `${name}: default`], depth + 1, out, refs);
    } else if (a.actions) {
      // Foreach, Until, Scope
      walk(obj(a.actions), [...branch, name], depth + 1, out, refs);
    }
  }
}

function step(name: string, a: Json, kind: FlowStep["kind"], branch: string[], depth: number, refs: (n: string) => string | undefined): FlowStep {
  const inputs = a.inputs;
  const host = obj(obj(inputs).host);
  let connector: string | undefined;
  let operation: string | undefined;
  if (typeof host.apiId === "string") connector = host.apiId.split("/").pop();
  if (!connector && typeof host.connectionName === "string") connector = refs(host.connectionName) ?? host.connectionName;
  // Older ApiConnection steps: @parameters('$connections')['shared_office365']['connectionId']
  if (!connector && typeof obj(host.connection).name === "string") connector = /\['([^']+)'\]\['connectionId'\]/.exec(obj(host.connection).name as string)?.[1];
  if (typeof host.operationId === "string") operation = host.operationId;
  else if (typeof obj(inputs).path === "string") operation = `${String(obj(inputs).method ?? "").toUpperCase()} ${obj(inputs).path}`.trim();
  const type = String(a.type ?? "");
  const lower = type.toLowerCase();
  const expression =
    kind === "trigger" ? a.conditions : lower === "if" ? a.expression : lower === "foreach" ? a.foreach : lower === "switch" ? a.expression : lower === "until" ? a.expression : undefined;
  return {
    name, kind, type, connector, operation, parameters: obj(obj(inputs).parameters), inputs, branch, depth, expression,
    ...(a.recurrence ? { recurrence: obj(a.recurrence) } : {}),
    ...(typeof a.kind === "string" ? { triggerKind: a.kind } : {}),
  };
}

// ---------- what a step does ----------

export interface Capability {
  label: string;
  /** Words to narrow the flows Dataverse sends back before Lantern reads each definition. */
  prefilter: string[];
  matches(step: FlowStep): boolean;
}

const op = (s: FlowStep) => (s.operation ?? "").toLowerCase();
const conn = (s: FlowStep) => (s.connector ?? "").toLowerCase();
/** A step parameter by name, ignoring case ("actionName" and "actionname" are the same to the designer). */
const param = (s: FlowStep, key: string) => {
  const k = Object.keys(s.parameters).find((p) => p.toLowerCase() === key.toLowerCase());
  return String(k ? s.parameters[k] ?? "" : "").toLowerCase();
};
const EMAIL_CONNECTORS = ["shared_office365", "shared_outlook", "shared_sendmail", "shared_sendgrid", "shared_smtp", "shared_gmail"];
/** Operations that read, wait for or file messages rather than send them: GetEmailsV3, OnNewChannelMessage, ExportEmail_V2, ... */
const READS = /^(get|list|on|when|flag|move|delete|mark|export)/;

/** Built-in shortcuts for common questions ("which flows send email?"). */
export const CAPABILITIES: Record<string, Capability> = {
  email: {
    label: "send email",
    prefilter: ["mail"],
    // Only actions send: a trigger like SharedMailboxOnNewEmailV2 waits for mail.
    matches: (s) =>
      s.kind === "action" &&
      ((EMAIL_CONNECTORS.includes(conn(s)) && /send|forward|reply|mail/.test(op(s)) && !READS.test(op(s))) ||
        // Dataverse: the SendEmail action on an email row, or SendEmailFromTemplate
        (conn(s).startsWith("shared_commondataservice") && /sendemail/.test(param(s, "actionname") + op(s))) ||
        // Notifications connector: "Send me an email notification"
        (conn(s) === "shared_flowpush" && /mail/.test(op(s)))),
  },
  teams: {
    label: "post to Microsoft Teams",
    prefilter: ["shared_teams"],
    matches: (s) => s.kind === "action" && conn(s) === "shared_teams" && /post|send|reply|message|card|chat/.test(op(s)) && !READS.test(op(s)),
  },
  approval: {
    label: "start an approval",
    prefilter: ["shared_approvals"],
    matches: (s) => conn(s) === "shared_approvals",
  },
  http: {
    label: "call an HTTP endpoint",
    prefilter: ["Http"],
    matches: (s) => s.type.toLowerCase() === "http" || conn(s) === "shared_webcontents",
  },
  sharepoint: {
    label: "use SharePoint",
    prefilter: ["shared_sharepointonline"],
    matches: (s) => conn(s) === "shared_sharepointonline",
  },
  childflow: {
    label: "run a child flow",
    prefilter: ["Workflow"],
    matches: (s) => s.type.toLowerCase() === "workflow",
  },
  "dataverse-write": {
    label: "create, update or delete Dataverse rows",
    prefilter: ["shared_commondataserviceforapps"],
    matches: (s) => conn(s) === "shared_commondataserviceforapps" && /createrecord|updaterecord|deleterecord|updateonlyrecord|upsert|associate/.test(op(s)),
  },
};

/** A shortcut from CAPABILITIES, or the text itself anywhere in a step (its name, connector, operation, inputs, or condition). */
export function capabilityFor(uses: string): Capability {
  const known = CAPABILITIES[uses.trim().toLowerCase()];
  if (known) return known;
  const text = uses.trim().toLowerCase();
  return {
    label: `mention "${uses.trim()}"`,
    prefilter: [uses.trim()],
    // The expression too: Dataverse found the text in the definition, and it may only be in an If, a loop's source or a trigger condition.
    matches: (s) =>
      [s.name, s.type, s.connector ?? "", s.operation ?? "", JSON.stringify(s.inputs ?? ""), JSON.stringify(s.expression ?? "")].some((v) => v.toLowerCase().includes(text)),
  };
}

// ---------- searching ----------

export interface FlowRow {
  workflowid: string;
  name: string;
  description: string | null;
  statecode: number;
  clientdata?: string | null;
}

export interface FlowMatch {
  id: string;
  name: string;
  description: string;
  on: boolean;
  solutions: string[];
  steps: FlowStep[];
}

const odata = (s: string) => s.replace(/'/g, "''");
const FLOW_COLUMNS = "workflowid,name,description,statecode";

/**
 * Cloud flows whose definitions do something. Dataverse narrows the list by
 * text first (contains on clientdata); Lantern then reads each definition and
 * keeps the flows with a step that really matches. If the org refuses the text
 * filter, every flow's definition is read instead.
 */
export async function searchFlowsByUse(
  dv: DataverseClient,
  uses: string,
  options: { name?: string; solution?: string; limit?: number } = {}
): Promise<{ capability: Capability; flows: FlowMatch[]; scannedAll: boolean; total: number }> {
  const capability = capabilityFor(uses);
  const base = `category eq 5 and type eq 1${options.name ? ` and contains(name,'${odata(options.name)}')` : ""}`;
  const narrowed = `${base} and (${capability.prefilter.map((p) => `contains(clientdata,'${odata(p)}')`).join(" or ")})`;
  let rows: FlowRow[];
  let scannedAll = false;
  try {
    rows = await dv.getAll<FlowRow>(`workflows?$select=${FLOW_COLUMNS},clientdata&$filter=${encodeURIComponent(narrowed)}`);
  } catch {
    scannedAll = true;
    rows = await dv.getAll<FlowRow>(`workflows?$select=${FLOW_COLUMNS},clientdata&$filter=${encodeURIComponent(base)}`);
  }
  if (options.solution) {
    const inSolution = await solutionFlowIds(dv, options.solution);
    rows = rows.filter((r) => inSolution.has(r.workflowid.toLowerCase()));
  }
  const found: FlowMatch[] = [];
  for (const r of rows) {
    let steps: FlowStep[];
    try {
      steps = parseFlow(r.clientdata).steps.filter((s) => capability.matches(s));
    } catch {
      continue;
    }
    if (steps.length) found.push({ id: r.workflowid, name: r.name, description: r.description ?? "", on: r.statecode === 1, solutions: [], steps });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  const limited = found.slice(0, options.limit ?? 50);
  const memberships = await solutionsOf(dv, limited.map((f) => f.id));
  for (const f of limited) f.solutions = memberships.get(f.id.toLowerCase()) ?? [];
  return { capability, flows: limited, scannedAll, total: found.length };
}

async function solutionFlowIds(dv: DataverseClient, uniqueName: string): Promise<Set<string>> {
  const solutions = await dv.getAll<{ solutionid: string }>(`solutions?$select=solutionid&$filter=uniquename eq '${odata(uniqueName)}'`);
  if (!solutions[0]) throw new UserError(`There's no solution named ${uniqueName} in this org.`);
  const components = await dv.getAll<{ objectid: string }>(
    `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${solutions[0].solutionid} and componenttype eq 29`
  );
  return new Set(components.map((c) => c.objectid.toLowerCase()));
}

/** Display names of the solutions each flow is in, leaving out Default and Active. */
export async function solutionsOf(dv: DataverseClient, flowIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(flowIds.map((id) => id.toLowerCase()))];
  for (let i = 0; i < ids.length; i += 40) {
    const filter = `componenttype eq 29 and (${ids.slice(i, i + 40).map((id) => `objectid eq ${id}`).join(" or ")})`;
    const components = await dv.getAll<{ objectid: string; _solutionid_value: string }>(`solutioncomponents?$select=objectid,_solutionid_value&$filter=${encodeURIComponent(filter)}`);
    const solutionIds = [...new Set(components.map((c) => c._solutionid_value.toLowerCase()))];
    const names = new Map<string, string>();
    for (let j = 0; j < solutionIds.length; j += 40) {
      const sf = solutionIds.slice(j, j + 40).map((id) => `solutionid eq ${id}`).join(" or ");
      for (const s of await dv.getAll<{ solutionid: string; friendlyname: string; uniquename: string }>(`solutions?$select=solutionid,friendlyname,uniquename&$filter=${encodeURIComponent(sf)}`)) {
        if (["default", "active"].includes(s.uniquename.toLowerCase())) continue;
        names.set(s.solutionid.toLowerCase(), s.friendlyname || s.uniquename);
      }
    }
    for (const c of components) {
      const name = names.get(c._solutionid_value.toLowerCase());
      if (!name) continue;
      const list = out.get(c.objectid.toLowerCase()) ?? [];
      if (!list.includes(name)) list.push(name);
      out.set(c.objectid.toLowerCase(), list.sort((a, b) => a.localeCompare(b)));
    }
  }
  return out;
}

const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

/** One flow by ID or name: an exact name wins, otherwise the only name containing the text. */
export async function findFlow(dv: DataverseClient, idOrName: string): Promise<FlowRow> {
  const text = idOrName.trim();
  const select = `${FLOW_COLUMNS},clientdata`;
  if (GUID.test(text)) {
    const rows = await dv.getAll<FlowRow>(`workflows?$select=${select}&$filter=workflowid eq ${text.replace(/[{}]/g, "")}`);
    if (rows[0]) return rows[0];
    throw new UserError(`There's no flow with ID ${text}.`);
  }
  const rows = await dv.getAll<FlowRow>(`workflows?$select=${select}&$filter=${encodeURIComponent(`category eq 5 and type eq 1 and contains(name,'${odata(text)}')`)}`);
  const exact = rows.filter((r) => r.name.toLowerCase() === text.toLowerCase());
  if (exact.length === 1) return exact[0];
  const candidates = exact.length ? exact : rows;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new UserError(`No cloud flow's name contains "${text}".`);
  throw new UserError(`${candidates.length} flows match "${text}": ${candidates.slice(0, 20).map((r) => `${r.name} (${r.workflowid})`).join("; ")}. Pass the ID of the one you mean.`);
}

// ---------- describing ----------

const clip = (v: unknown, max = 160): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** "When a row is added or modified (Dataverse): table account, ..." */
export function describeTrigger(s: FlowStep): string {
  const p = s.parameters;
  const type = s.type.toLowerCase();
  if (s.connector?.startsWith("shared_commondataservice") && p["subscriptionRequest/message"] !== undefined) {
    const parts = [`table ${p["subscriptionRequest/entityname"] ?? "?"}`];
    const scope = DATAVERSE_SCOPES[Number(p["subscriptionRequest/scope"])];
    if (scope) parts.push(`scope ${scope}`);
    if (p["subscriptionRequest/filteringattributes"]) parts.push(`only when these change: ${p["subscriptionRequest/filteringattributes"]}`);
    if (p["subscriptionRequest/filterexpression"]) parts.push(`rows matching ${clip(p["subscriptionRequest/filterexpression"])}`);
    return `When a row is ${DATAVERSE_MESSAGES[Number(p["subscriptionRequest/message"])] ?? "changed"} (Dataverse): ${parts.join(", ")}`;
  }
  if (type === "recurrence") {
    const r = s.recurrence ?? {};
    return `On a schedule: every ${r.interval ?? 1} ${String(r.frequency ?? "?").toLowerCase()}${r.startTime ? ` from ${r.startTime}` : ""}${r.timeZone ? ` (${r.timeZone})` : ""}`;
  }
  if (type === "request") {
    const k = (s.triggerKind ?? "").toLowerCase();
    return k === "button" ? "Run by hand (instant flow)" : k === "powerapp" || k === "powerappv2" ? "Called from a Power App" : k === "skills" ? "Called from Copilot Studio" : "When an HTTP request is received";
  }
  return `${s.name} (${s.connector ? `${connectorName(s.connector)} · ` : ""}${s.operation ?? s.type})`;
}

/** Markdown outline of a flow: trigger, steps in order and nesting, connectors. */
export function outlineFlow(row: FlowRow, solutions: string[] = []): string {
  const def = parseFlow(row.clientdata);
  const lines = [`# ${row.name}`, "", `${row.statecode === 1 ? "On" : "Off"} · ID ${row.workflowid}${solutions.length ? ` · in ${solutions.join(", ")}` : ""}`];
  if (row.description) lines.push("", row.description);
  const triggers = def.steps.filter((s) => s.kind === "trigger");
  lines.push("", "## Trigger", ...(triggers.length ? triggers.map((t) => `- ${describeTrigger(t)}`) : ["- (none found)"]));
  lines.push("", "## Steps");
  const actions = def.steps.filter((s) => s.kind === "action");
  if (!actions.length) lines.push("- (no actions)");
  let lastBranch = "";
  for (const s of actions) {
    // Each level of nesting: the branch label ("Check: yes") under its parent, then the steps under it.
    const pad = "    ".repeat(s.depth);
    const branch = s.branch.join(" › ");
    const label = s.branch[s.branch.length - 1];
    // Loops and scopes have no branches worth naming: their steps simply sit under them.
    if (branch && branch !== lastBranch && s.depth > 0 && label.includes(": ")) lines.push(`${"    ".repeat(s.depth - 1)}  - _${label}_`);
    lastBranch = branch;
    const what = s.connector ? `${connectorName(s.connector)} · ${s.operation ?? s.type}` : s.type;
    let line = `${pad}- **${s.name}** (${what})`;
    if (s.expression !== undefined) line += `: \`${clip(s.expression, 200)}\``;
    lines.push(line);
    const params = Object.entries(s.parameters).filter(([, v]) => v !== "" && v !== null && v !== undefined).slice(0, 8);
    for (const [k, v] of params) lines.push(`${pad}  - ${k}: ${clip(v)}`);
    if (!params.length && !s.connector && s.inputs !== undefined && !["if", "switch", "foreach", "until", "scope"].includes(s.type.toLowerCase())) {
      lines.push(`${pad}  - inputs: ${clip(s.inputs, 240)}`);
    }
  }
  if (def.connectors.length) {
    lines.push("", "## Connections", ...def.connectors.map((c) => `- ${connectorName(c.connector)} (${c.connector})${c.reference && c.reference !== c.connector ? ` via ${c.reference}` : ""}`));
  }
  return lines.join("\n");
}
