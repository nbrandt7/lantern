import { DataverseClient } from "./dataverse";
import { TableMeta } from "./metadata";

export const ACTIONS = ["Create", "Read", "Write", "Delete", "Append", "AppendTo", "Assign", "Share"] as const;
export type Action = (typeof ACTIONS)[number];
export type Depth = "Basic" | "Local" | "Deep" | "Global";

export const DEPTH_LABEL: Record<Depth, string> = { Basic: "User", Local: "Business unit", Deep: "Parent: child business units", Global: "Organization" };
const DEPTH_RANK: Record<Depth, number> = { Basic: 1, Local: 2, Deep: 3, Global: 4 };

/** prvAppendToAccount -> { action: "AppendTo", schema: "Account" }. AppendTo is checked before Append. */
export function parsePrivilege(name: string): { action: Action; schema: string } | undefined {
  const m = /^prv(AppendTo|Append|Create|Read|Write|Delete|Assign|Share)(\w+)$/.exec(name);
  return m ? { action: m[1] as Action, schema: m[2] } : undefined;
}

export interface RolePrivileges {
  /** Table logical name -> action -> depth. */
  tables: Map<string, Partial<Record<Action, Depth>>>;
}

export async function rolePrivileges(dv: DataverseClient, roleId: string, tables: TableMeta[]): Promise<RolePrivileges> {
  const r = await dv.getJson<{ RolePrivileges: Array<{ PrivilegeName: string; Depth: Depth }> }>(`RetrieveRolePrivilegesRole(RoleId=@p)?@p=${roleId}`);
  const bySchema = new Map(tables.map((t) => [t.schemaName.toLowerCase(), t.logicalName]));
  const out: RolePrivileges = { tables: new Map() };
  for (const p of r.RolePrivileges ?? []) {
    const parsed = parsePrivilege(p.PrivilegeName);
    if (!parsed) continue;
    const table = bySchema.get(parsed.schema.toLowerCase());
    if (!table) continue;
    const entry = out.tables.get(table) ?? {};
    entry[parsed.action] = p.Depth;
    out.tables.set(table, entry);
  }
  return out;
}

/** The broadest depth across several roles for one action on one table. */
export function bestDepth(roles: RolePrivileges[], table: string, action: Action): Depth | undefined {
  let best: Depth | undefined;
  for (const r of roles) {
    const d = r.tables.get(table)?.[action];
    if (d && (!best || DEPTH_RANK[d] > DEPTH_RANK[best])) best = d;
  }
  return best;
}

export interface AccessExplanation {
  rights: string[];
  canRead: boolean;
  readDepth?: Depth;
  sameBusinessUnit: boolean;
  ownedByUser: boolean;
  owner: string;
  recordBusinessUnit: string;
  userBusinessUnit: string;
  roles: string[];
  teamRoles: string[];
  reasons: string[];
}

/**
 * Why a user can or can't see a record: the platform's own answer (RetrievePrincipalAccess),
 * plus the facts behind it: their roles' Read level for the table, who owns the record,
 * and which business units are involved.
 */
export async function explainAccess(
  dv: DataverseClient,
  userId: string,
  table: TableMeta,
  recordId: string,
  tables: TableMeta[]
): Promise<AccessExplanation> {
  const FV = "@OData.Community.Display.V1.FormattedValue";
  const annotations = { Prefer: 'odata.include-annotations="*"' };
  const target = encodeURIComponent(JSON.stringify({ "@odata.id": `${table.entitySetName}(${recordId})` }));
  const [access, record, user, teams] = await Promise.all([
    dv.getJson<{ AccessRights: string }>(`systemusers(${userId})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t=${target}`),
    dv.getJson<Record<string, string>>(`${table.entitySetName}(${recordId})?$select=_ownerid_value,_owningbusinessunit_value`, annotations),
    dv.getJson<Record<string, unknown> & { systemuserroles_association?: Array<{ roleid: string; name: string }> }>(
      `systemusers(${userId})?$select=fullname,_businessunitid_value&$expand=systemuserroles_association($select=roleid,name)`,
      annotations
    ),
    dv
      .getJson<{ value: Array<{ name: string; teamroles_association?: Array<{ roleid: string; name: string }> }> }>(
        `systemusers(${userId})/teammembership_association?$select=name&$expand=teamroles_association($select=roleid,name)`
      )
      .catch(() => ({ value: [] })),
  ]);
  const rights = (access.AccessRights ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "None");
  const userRoles = user.systemuserroles_association ?? [];
  const teamRoles = teams.value.flatMap((t) => (t.teamroles_association ?? []).map((r) => ({ ...r, team: t.name })));
  const privileges = await Promise.all([...userRoles, ...teamRoles].map((r) => rolePrivileges(dv, r.roleid, tables).catch(() => ({ tables: new Map() }))));
  const readDepth = bestDepth(privileges, table.logicalName, "Read");
  const ownedByUser = (record._ownerid_value ?? "").toLowerCase() === userId.toLowerCase();
  const sameBusinessUnit = (record._owningbusinessunit_value ?? "").toLowerCase() === String(user._businessunitid_value ?? "").toLowerCase();
  const canRead = rights.includes("ReadAccess");
  const owner = record[`_ownerid_value${FV}`] ?? record._ownerid_value ?? "";
  const recordBusinessUnit = record[`_owningbusinessunit_value${FV}`] ?? record._owningbusinessunit_value ?? "";
  const userBusinessUnit = String(user[`_businessunitid_value${FV}`] ?? user._businessunitid_value ?? "");

  const reasons: string[] = [];
  if (!readDepth) reasons.push(`None of their security roles (including their teams' roles) give Read on ${table.displayName} at all.`);
  else if (readDepth === "Global") reasons.push(`Their roles give Read on ${table.displayName} across the organization.`);
  else if (readDepth === "Deep") reasons.push(`Their roles give Read on ${table.displayName} in their business unit (${userBusinessUnit}) and the business units under it. The record belongs to ${recordBusinessUnit}.`);
  else if (readDepth === "Local") reasons.push(`Their roles give Read on ${table.displayName} only within their own business unit (${userBusinessUnit}); the record belongs to ${recordBusinessUnit}${sameBusinessUnit ? ", the same one" : ", a different one"}.`);
  else reasons.push(`Their roles give Read on ${table.displayName} only for records they (or their teams) own. The record is owned by ${owner}.`);
  if (canRead && readDepth && !(readDepth === "Global" || (readDepth === "Local" && sameBusinessUnit) || (readDepth === "Basic" && ownedByUser) || readDepth === "Deep")) {
    reasons.push("They can still see it, so it's been shared with them or one of their teams, or a team they belong to owns it.");
  }
  if (!canRead && readDepth && readDepth !== "Global") {
    reasons.push("To give them access: share the record with them or a team they're in, raise the Read level in one of their roles, or move the record to their business unit.");
  }
  return {
    rights,
    canRead,
    readDepth,
    sameBusinessUnit,
    ownedByUser,
    owner,
    recordBusinessUnit,
    userBusinessUnit,
    roles: userRoles.map((r) => r.name).sort(),
    teamRoles: teamRoles.map((r) => `${r.name} (team ${r.team})`).sort(),
    reasons,
  };
}
