import { DataverseClient } from "./dataverse";
import { UserError } from "./errors";
import { ColumnMeta, TableMeta } from "./metadata";
import { Cell, ResultSet } from "./query";

const ANNOTATIONS = { Prefer: 'odata.include-annotations="*"' };
const FV = "@OData.Community.Display.V1.FormattedValue";

// ---------- publish ----------

export async function publishAll(dv: DataverseClient): Promise<void> {
  await dv.action("PublishAllXml");
}

// ---------- plug-in steps ----------

export interface StepInfo {
  id: string;
  name: string;
  message: string;
  table: string;
  stage: string;
  mode: "Synchronous" | "Asynchronous";
  enabled: boolean;
  typeName: string;
  assembly: string;
  filtering: string;
  rank: number;
}

const STAGE: Record<number, string> = { 10: "Pre-validation", 20: "Pre-operation", 30: "Main operation", 40: "Post-operation" };

/** Custom (not Microsoft's) plug-in steps, newest assemblies first by name. */
export async function fetchSteps(dv: DataverseClient): Promise<StepInfo[]> {
  const rows = await dv.getAll<{
    sdkmessageprocessingstepid: string;
    name: string;
    stage: number;
    mode: number;
    statecode: number;
    rank: number;
    filteringattributes: string | null;
    sdkmessageid?: { name?: string } | null;
    sdkmessagefilterid?: { primaryobjecttypecode?: string } | null;
    plugintypeid?: { typename?: string; assemblyname?: string } | null;
  }>(
    "sdkmessageprocessingsteps?$select=name,stage,mode,statecode,rank,filteringattributes" +
      "&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode),plugintypeid($select=typename,assemblyname)" +
      "&$filter=customizationlevel eq 1"
  );
  return rows
    .map((r) => ({
      id: r.sdkmessageprocessingstepid,
      name: r.name,
      message: r.sdkmessageid?.name ?? "",
      table: r.sdkmessagefilterid?.primaryobjecttypecode ?? "",
      stage: STAGE[r.stage] ?? `Stage ${r.stage}`,
      mode: r.mode === 1 ? ("Asynchronous" as const) : ("Synchronous" as const),
      enabled: r.statecode === 0,
      typeName: r.plugintypeid?.typename ?? "",
      assembly: r.plugintypeid?.assemblyname ?? "(no assembly)",
      filtering: r.filteringattributes ?? "",
      rank: r.rank ?? 1,
    }))
    .sort((a, b) => a.assembly.localeCompare(b.assembly) || a.typeName.localeCompare(b.typeName) || a.message.localeCompare(b.message));
}

export async function setStepEnabled(dv: DataverseClient, id: string, enabled: boolean): Promise<void> {
  await dv.update(`sdkmessageprocessingsteps(${id})`, enabled ? { statecode: 0, statuscode: 1 } : { statecode: 1, statuscode: 2 });
}

// ---------- system jobs ----------

export interface JobInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  failed: boolean;
  createdOn: string;
  completedOn?: string;
  message: string;
  regarding?: { table: string; id: string; name: string };
}

export interface JobFilter {
  status: "failed" | "active" | "all";
  hours: number;
}

export const DEFAULT_JOB_FILTER: JobFilter = { status: "failed", hours: 24 };

export async function fetchJobs(dv: DataverseClient, filter: JobFilter, top = 100): Promise<JobInfo[]> {
  const clauses: string[] = [];
  if (filter.status === "failed") clauses.push("statuscode eq 31");
  if (filter.status === "active") clauses.push("(statuscode eq 0 or statuscode eq 10 or statuscode eq 20 or statuscode eq 21)");
  if (filter.hours > 0) clauses.push(`createdon ge ${new Date(Date.now() - filter.hours * 3600_000).toISOString()}`);
  const where = clauses.length ? `&$filter=${encodeURIComponent(clauses.join(" and "))}` : "";
  const r = await dv.getJson<{ value: Array<Record<string, unknown>> }>(
    `asyncoperations?$select=name,operationtype,statuscode,createdon,completedon,message,friendlymessage,_regardingobjectid_value&$orderby=createdon desc&$top=${top}${where}`,
    ANNOTATIONS
  );
  return r.value.map((j) => {
    const regardingId = j._regardingobjectid_value as string | null;
    return {
      id: j.asyncoperationid as string,
      name: (j.name as string) || "(unnamed job)",
      type: (j[`operationtype${FV}`] as string) ?? String(j.operationtype),
      status: (j[`statuscode${FV}`] as string) ?? String(j.statuscode),
      failed: j.statuscode === 31,
      createdOn: j.createdon as string,
      completedOn: (j.completedon as string) ?? undefined,
      message: [j.friendlymessage, j.message].filter((m) => typeof m === "string" && m.trim()).join("\n\n"),
      regarding: regardingId
        ? {
            id: regardingId,
            table: (j["_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname"] as string) ?? "",
            name: (j[`_regardingobjectid_value${FV}`] as string) ?? regardingId,
          }
        : undefined,
    };
  });
}

export function formatJob(j: JobInfo): string {
  return [
    j.name,
    "",
    `Type:       ${j.type}`,
    `Status:     ${j.status}`,
    `Created:    ${new Date(j.createdOn).toLocaleString()}`,
    j.completedOn ? `Completed:  ${new Date(j.completedOn).toLocaleString()}` : "",
    j.regarding ? `Regarding:  ${j.regarding.name} (${j.regarding.table} ${j.regarding.id})` : "",
    "",
    "Message",
    "-------",
    j.message.trim() || "(no message)",
    "",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

// ---------- environment variables ----------

export interface EnvVarInfo {
  definitionId: string;
  schemaName: string;
  displayName: string;
  type: string;
  editable: boolean;
  defaultValue: string;
  valueId?: string;
  value?: string;
}

const ENV_TYPE: Record<number, string> = {
  100000000: "Text", 100000001: "Number", 100000002: "Yes/No", 100000003: "JSON", 100000004: "Data source", 100000005: "Secret",
};

export async function fetchEnvVars(dv: DataverseClient): Promise<EnvVarInfo[]> {
  const rows = await dv.getAll<{
    environmentvariabledefinitionid: string;
    schemaname: string;
    displayname: string | null;
    type: number;
    defaultvalue: string | null;
    environmentvariabledefinition_environmentvariablevalue?: Array<{ environmentvariablevalueid: string; value: string | null }>;
  }>(
    "environmentvariabledefinitions?$select=schemaname,displayname,type,defaultvalue" +
      "&$expand=environmentvariabledefinition_environmentvariablevalue($select=value)&$orderby=schemaname"
  );
  return rows.map((r) => {
    const v = r.environmentvariabledefinition_environmentvariablevalue?.[0];
    return {
      definitionId: r.environmentvariabledefinitionid,
      schemaName: r.schemaname,
      displayName: r.displayname || r.schemaname,
      type: ENV_TYPE[r.type] ?? `Type ${r.type}`,
      editable: r.type !== 100000004 && r.type !== 100000005,
      defaultValue: r.defaultvalue ?? "",
      valueId: v?.environmentvariablevalueid,
      value: v?.value ?? undefined,
    };
  });
}

/** Sets the current value, creating the value row when the variable only has a default. */
export async function setEnvVar(dv: DataverseClient, v: EnvVarInfo, value: string): Promise<void> {
  if (v.valueId) await dv.update(`environmentvariablevalues(${v.valueId})`, { value });
  else {
    await dv.create("environmentvariablevalues", {
      value,
      schemaname: `${v.schemaName}_value`,
      "EnvironmentVariableDefinitionId@odata.bind": `/environmentvariabledefinitions(${v.definitionId})`,
    });
  }
}

// ---------- environment details ----------

export interface EnvironmentInfo {
  friendlyName: string;
  uniqueName: string;
  organizationId: string;
  environmentId: string;
  tenantId: string;
  version: string;
  geo: string;
  userId: string;
  userName: string;
  userEmail: string;
  businessUnit: string;
  roles: string[];
}

export async function fetchEnvironment(dv: DataverseClient): Promise<EnvironmentInfo> {
  const who = await dv.getJson<{ UserId: string; BusinessUnitId: string; OrganizationId: string }>("WhoAmI");
  const [org, version, user, bu] = await Promise.all([
    dv
      .getJson<{ Detail: Record<string, unknown> }>("RetrieveCurrentOrganization(AccessType=@p)?@p=Microsoft.Dynamics.CRM.EndpointAccessType'Default'")
      .then((r) => r.Detail)
      .catch(() => ({} as Record<string, unknown>)),
    dv.getJson<{ Version: string }>("RetrieveVersion()").then((r) => r.Version).catch(() => ""),
    dv
      .getJson<{ fullname: string; domainname: string; systemuserroles_association?: Array<{ name: string }> }>(
        `systemusers(${who.UserId})?$select=fullname,domainname&$expand=systemuserroles_association($select=name)`
      )
      .catch(() => ({ fullname: "", domainname: "", systemuserroles_association: [] })),
    dv.getJson<{ name: string }>(`businessunits(${who.BusinessUnitId})?$select=name`).then((r) => r.name).catch(() => ""),
  ]);
  return {
    friendlyName: String(org.FriendlyName ?? ""),
    uniqueName: String(org.UniqueName ?? ""),
    organizationId: who.OrganizationId,
    environmentId: String(org.EnvironmentId ?? ""),
    tenantId: String(org.TenantId ?? ""),
    version: version || String(org.OrganizationVersion ?? ""),
    geo: String(org.Geo ?? ""),
    userId: who.UserId,
    userName: user.fullname,
    userEmail: user.domainname,
    businessUnit: bu,
    roles: (user.systemuserroles_association ?? []).map((r) => r.name).sort(),
  };
}

// ---------- users ----------

export interface UserInfo {
  systemuserid: string;
  fullname: string;
  domainname: string;
}

export function fetchUsers(dv: DataverseClient): Promise<UserInfo[]> {
  return dv.getAll<UserInfo>(
    "systemusers?$select=systemuserid,fullname,domainname&$filter=isdisabled eq false and accessmode ne 4 and applicationid eq null&$orderby=fullname"
  );
}

// ---------- records ----------

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A record reference from what people paste: a record URL from the app
 * (...main.aspx?etn=account&id=...), "account:GUID", or a bare GUID (table unknown).
 */
export function parseRecordRef(input: string): { table?: string; id: string } | undefined {
  const text = input.trim();
  let id: string | undefined;
  let table: string | undefined;
  if (/^https?:\/\//i.test(text)) {
    // App URLs carry other GUIDs too (appid=...), so only the id parameter counts.
    let decoded = text;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      // keep the raw text
    }
    id = new RegExp(`[?&#]id=\\{?(${GUID.source})`, "i").exec(decoded)?.[1];
    table = /[?&#]etn=([\w]+)/i.exec(decoded)?.[1];
  } else {
    id = GUID.exec(text)?.[0];
    table = /^([a-z][\w]*)\s*[:/ ]/i.exec(text)?.[1];
  }
  if (!id) return undefined;
  return { table: table?.toLowerCase(), id: id.toLowerCase() };
}

/**
 * Every column of one record as a two-way grid: one row per column with its display
 * name, logical name, and value (display and stored). Empty columns sort last.
 */
export async function inspectRecord(dv: DataverseClient, table: TableMeta, columns: ColumnMeta[], id: string): Promise<ResultSet> {
  const started = Date.now();
  if (!table.entitySetName) throw new UserError(`${table.logicalName} can't be read through the Web API.`);
  const row = await dv.getJson<Record<string, unknown>>(`${table.entitySetName}(${id})`, ANNOTATIONS);
  const byName = new Map(columns.map((c) => [c.logicalName, c]));
  const keys = Object.keys(row).filter((k) => !k.includes("@"));
  const entries = keys.map((key) => {
    const logical = /^_(.+)_value$/.exec(key)?.[1] ?? key;
    const meta = byName.get(logical);
    const raw = row[key] ?? null;
    const value: Cell = { raw };
    const formatted = row[`${key}${FV}`] as string | undefined;
    if (formatted !== undefined && String(formatted) !== String(raw)) value.formatted = formatted;
    const target = row[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`] as string | undefined;
    if (target && typeof raw === "string") value.ref = { table: target, id: raw };
    return { logical, display: meta?.displayName || logical, type: meta?.type ?? "", value };
  });
  entries.sort((a, b) => Number(a.value.raw === null) - Number(b.value.raw === null) || a.display.localeCompare(b.display));
  return {
    source: `${table.displayName} ${id}`,
    table: table.logicalName,
    fetchXml: "",
    columns: ["Column", "Logical name", "Type", "Value"],
    rows: entries.map((e) => [{ raw: e.display }, { raw: e.logical }, { raw: e.type }, e.value]),
    rowIds: entries.map(() => id),
    truncated: false,
    elapsedMs: Date.now() - started,
    kind: "record",
    record: { table: table.logicalName, id },
  };
}

// ---------- audit history ----------

interface AuditRow {
  createdon: string;
  operation: number;
  action: number;
  changedata: string | null;
  _userid_value: string;
  [key: string]: unknown;
}

/** Change history for a record (optionally one column), newest first, one row per changed column. */
export async function auditHistory(dv: DataverseClient, table: string, id: string, column?: string): Promise<ResultSet> {
  const started = Date.now();
  const rows = await dv.getAll<AuditRow>(
    `audits?$select=createdon,operation,action,changedata,_userid_value&$filter=_objectid_value eq ${id}&$orderby=createdon desc`,
    ANNOTATIONS
  );
  const out: Cell[][] = [];
  for (const a of rows) {
    const when: Cell = { raw: a.createdon, formatted: a[`createdon${FV}`] as string | undefined };
    const user: Cell = { raw: a._userid_value, formatted: a[`_userid_value${FV}`] as string | undefined, ref: { table: "systemuser", id: a._userid_value } };
    const action: Cell = { raw: a.action, formatted: (a[`action${FV}`] as string) ?? (a[`operation${FV}`] as string) };
    const changes = parseChangeData(a.changedata);
    if (!changes.length) {
      if (!column) out.push([when, user, action, { raw: null }, { raw: null }, { raw: null }]);
      continue;
    }
    for (const c of changes) {
      if (column && c.logicalName !== column) continue;
      out.push([when, user, action, { raw: c.logicalName }, { raw: c.oldValue ?? null }, { raw: c.newValue ?? null }]);
    }
  }
  return {
    source: `Audit history for ${table} ${id}${column ? `, column ${column}` : ""}`,
    table,
    fetchXml: "",
    columns: ["Changed on", "Changed by", "Event", "Column", "Old value", "New value"],
    rows: out,
    rowIds: out.map(() => id),
    truncated: false,
    elapsedMs: Date.now() - started,
    kind: "audit",
    record: { table, id },
  };
}

/** changedata is JSON: {"changedAttributes":[{"logicalName":"fax","oldValue":"1","newValue":"2"}]} */
export function parseChangeData(data: string | null): Array<{ logicalName: string; oldValue?: string; newValue?: string }> {
  if (!data) return [];
  try {
    const parsed = JSON.parse(data) as { changedAttributes?: Array<{ logicalName: string; oldValue?: string | null; newValue?: string | null }> };
    return (parsed.changedAttributes ?? []).map((c) => ({ logicalName: c.logicalName, oldValue: c.oldValue ?? undefined, newValue: c.newValue ?? undefined }));
  } catch {
    return [];
  }
}

// ---------- solutions ----------

export interface OrgSolution {
  id: string;
  uniqueName: string;
  friendlyName: string;
  version: string;
  managed: boolean;
  publisher: string;
}

/** Visible solutions in the org, unmanaged first. */
export async function fetchOrgSolutions(dv: DataverseClient): Promise<OrgSolution[]> {
  const rows = await dv.getAll<Record<string, unknown>>(
    "solutions?$select=solutionid,uniquename,friendlyname,version,ismanaged,_publisherid_value&$filter=isvisible eq true&$orderby=friendlyname",
    ANNOTATIONS
  );
  return rows
    .map((r) => ({
      id: r.solutionid as string,
      uniqueName: r.uniquename as string,
      friendlyName: (r.friendlyname as string) || (r.uniquename as string),
      version: (r.version as string) ?? "",
      managed: r.ismanaged === true,
      publisher: (r[`_publisherid_value${FV}`] as string) ?? "",
    }))
    .sort((a, b) => Number(a.managed) - Number(b.managed) || a.friendlyName.localeCompare(b.friendlyName));
}

export interface SolutionWebResource {
  id: string;
  name: string;
  displayName: string;
  type: number;
}

/** Web resources that are components of a solution. */
export async function fetchSolutionWebResources(dv: DataverseClient, uniqueName: string): Promise<SolutionWebResource[]> {
  const found = await dv.getAll<{ solutionid: string }>(`solutions?$select=solutionid&$filter=uniquename eq '${uniqueName.replace(/'/g, "''")}'`);
  if (!found[0]) throw new UserError(`There's no solution named ${uniqueName} in this org.`);
  const components = await dv.getAll<{ objectid: string }>(
    `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${found[0].solutionid} and componenttype eq 61`
  );
  const out: SolutionWebResource[] = [];
  // In batches, so the filter stays a reasonable URL length.
  for (let i = 0; i < components.length; i += 40) {
    const ids = components.slice(i, i + 40).map((c) => `webresourceid eq ${c.objectid}`).join(" or ");
    const rows = await dv.getAll<{ webresourceid: string; name: string; displayname: string | null; webresourcetype: number }>(
      `webresourceset?$select=name,displayname,webresourcetype&$filter=${encodeURIComponent(ids)}`
    );
    out.push(...rows.map((r) => ({ id: r.webresourceid, name: r.name, displayName: r.displayname || r.name, type: r.webresourcetype })));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
