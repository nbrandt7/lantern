import * as crypto from "crypto";
import { AssemblyMetadata, PluginClass, readAssembly } from "./assembly";
import { DataverseClient } from "./dataverse";
import { COMPONENT_TYPE } from "./dependencies";
import { readZip } from "./zip";

/**
 * Registers and updates plug-in assemblies through the Web API the way the
 * Plugin Registration Tool does: the DLL goes into pluginassembly.content, and
 * every plug-in or workflow class gets a plugintype row. Updates keep the
 * registered assembly and its steps; only its content changes.
 */

export const ISOLATION_NONE = 1;
export const ISOLATION_SANDBOX = 2;
export const SOURCE_DATABASE = 0;

export interface RegisteredAssembly {
  pluginassemblyid: string;
  name: string;
  version: string;
  culture: string | null;
  publickeytoken: string | null;
  isolationmode: number;
  ismanaged: boolean;
  _packageid_value?: string | null;
}

export interface RegisteredType {
  plugintypeid: string;
  typename: string;
  isworkflowactivity: boolean;
  workflowactivitygroupname: string | null;
}

export interface StepRef {
  id: string;
  name: string;
}

const ASSEMBLY_COLUMNS = "pluginassemblyid,name,version,culture,publickeytoken,isolationmode,ismanaged,_packageid_value";
const q = (s: string) => s.replace(/'/g, "''");

/** The registered assembly to update: the saved ID if it's in this org, otherwise by name. */
export async function registeredAssemblies(dv: DataverseClient, name: string, savedId?: string): Promise<{ byId?: RegisteredAssembly; byName: RegisteredAssembly[] }> {
  const byName = await dv.getAll<RegisteredAssembly>(`pluginassemblies?$select=${ASSEMBLY_COLUMNS}&$filter=name eq '${q(name)}'`);
  let byId = savedId ? byName.find((a) => a.pluginassemblyid.toLowerCase() === savedId.toLowerCase()) : undefined;
  if (savedId && !byId) {
    byId = (await dv.getAll<RegisteredAssembly>(`pluginassemblies?$select=${ASSEMBLY_COLUMNS}&$filter=pluginassemblyid eq ${savedId}`))[0];
  }
  return { byId, byName };
}

export async function registeredTypes(dv: DataverseClient, assemblyId: string): Promise<RegisteredType[]> {
  return dv.getAll<RegisteredType>(
    `plugintypes?$select=plugintypeid,typename,isworkflowactivity,workflowactivitygroupname&$filter=_pluginassemblyid_value eq ${assemblyId}`
  );
}

export interface StepRow extends StepRef {
  ismanaged: boolean;
  secureConfigId?: string;
}

export async function stepsOf(dv: DataverseClient, pluginTypeId: string): Promise<StepRow[]> {
  const rows = await dv.getAll<{ sdkmessageprocessingstepid: string; name: string; ismanaged?: boolean; _sdkmessageprocessingstepsecureconfigid_value?: string | null }>(
    `sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,ismanaged,_sdkmessageprocessingstepsecureconfigid_value&$filter=_plugintypeid_value eq ${pluginTypeId}`
  );
  return rows.map((r) => ({ id: r.sdkmessageprocessingstepid, name: r.name, ismanaged: r.ismanaged === true, secureConfigId: r._sdkmessageprocessingstepsecureconfigid_value ?? undefined }));
}

export interface RemovalCheck {
  type: Pick<RegisteredType, "plugintypeid" | "typename">;
  steps: StepRow[];
  /** Why Lantern won't unregister this type. Empty means it's safe to remove with its steps. */
  problems: string[];
}

/**
 * Before unregistering types (the build no longer has them, or their package is
 * going): their steps, and anything else that depends on them (custom APIs,
 * processes using a workflow activity, data providers). Managed steps, other
 * dependents, or a failed check all block, so nothing is deleted that Dataverse
 * or the user would need back.
 */
export async function checkRemovals(dv: DataverseClient, missing: Array<RemovalCheck["type"]>): Promise<RemovalCheck[]> {
  const out: RemovalCheck[] = [];
  for (const type of missing) {
    const steps = await stepsOf(dv, type.plugintypeid);
    const problems: string[] = [];
    const managed = steps.filter((st) => st.ismanaged);
    if (managed.length) problems.push(`${managed.length === 1 ? "a step" : `${managed.length} steps`} from a managed solution (${managed.map((st) => st.name).join(", ")})`);
    try {
      const deps = await dv.getAll<{ dependentcomponenttype: number; dependentcomponentobjectid?: string }>(
        `RetrieveDependenciesForDelete(ObjectId=@p1,ComponentType=@p2)?@p1=${type.plugintypeid}&@p2=90`
      );
      // Steps are deleted first, so they don't block; but only the steps Lantern found and will delete.
      const known = new Set(steps.map((st) => st.id.toLowerCase()));
      const unknownSteps = deps.filter((d) => d.dependentcomponenttype === 92 && !known.has((d.dependentcomponentobjectid ?? "").toLowerCase()));
      if (unknownSteps.length) problems.push(`Dataverse reports ${unknownSteps.length === 1 ? "a step" : `${unknownSteps.length} steps`} on it that Lantern can't list`);
      const others = deps.filter((d) => d.dependentcomponenttype !== 92 && d.dependentcomponenttype !== 93);
      if (others.length) {
        const kinds = [...new Set(others.map((d) => COMPONENT_TYPE[d.dependentcomponenttype] ?? `component type ${d.dependentcomponenttype}`))];
        problems.push(`${others.length === 1 ? "another component depends" : `${others.length} other components depend`} on it (${kinds.join(", ")})`);
      }
    } catch (err) {
      problems.push(`Lantern couldn't check what depends on it (${err instanceof Error ? err.message : String(err)})`);
    }
    out.push({ type, steps, problems });
  }
  return out;
}

/** Full rows of the steps (and their images) about to be unregistered, so they can be recreated. */
export async function stepBackup(dv: DataverseClient, checks: RemovalCheck[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const c of checks) {
    for (const st of c.steps) {
      const step = await dv.getJson<Record<string, unknown>>(`sdkmessageprocessingsteps(${st.id})`);
      const images = await dv.getAll<Record<string, unknown>>(`sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${st.id}`);
      out.push({ pluginType: c.type.typename, step, images });
    }
  }
  return out;
}

/** "AcmePlugins (1.0.0.0)", the Plugin Registration Tool's default group for workflow activities. */
export function defaultGroupName(assembly: string, version: string): string {
  return `${assembly} (${version})`;
}

const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");

/**
 * The registered copy this build would update. Only a copy with the same
 * major.minor version can take the update; among those, the one signed with the
 * same key wins, then the saved ID, then the same culture. With no copy on the
 * same version line, the saved ID or the only copy is returned so the version
 * check can explain.
 */
export function chooseTarget(meta: AssemblyMetadata, found: { byId?: RegisteredAssembly; byName: RegisteredAssembly[] }): RegisteredAssembly | undefined {
  const all = [...found.byName];
  if (found.byId && !all.some((a) => a.pluginassemblyid === found.byId!.pluginassemblyid)) all.push(found.byId);
  const token = (meta.publicKeyToken ?? "").toLowerCase();
  const sameLine = all.filter((a) => majorMinor(a.version) === majorMinor(meta.version));
  if (sameLine.length) {
    const score = (a: RegisteredAssembly) =>
      ((a.publickeytoken ?? "").toLowerCase() === token ? 4 : 0) +
      (a.pluginassemblyid === found.byId?.pluginassemblyid ? 2 : 0) +
      ((a.culture || "neutral").toLowerCase() === meta.culture.toLowerCase() ? 1 : 0);
    return [...sameLine].sort((a, b) => score(b) - score(a))[0];
  }
  if (found.byId) return found.byId;
  return all.length === 1 ? all[0] : undefined;
}

export interface UpdatePlan {
  /** Reasons Dataverse would refuse this update. Nothing is sent when there are any. */
  blockers: Array<{ kind: "unsigned" | "delaySigned" | "name" | "version" | "token" | "culture" | "managed" | "package" | "empty"; message: string }>;
  newClasses: PluginClass[];
  /** Registered types the new build no longer has. Dataverse refuses the update until they're unregistered. */
  missing: RegisteredType[];
  groupRenames: Array<{ id: string; name: string }>;
}

/** What an update would do, and anything that stops it, before anything is sent. */
export function planUpdate(meta: AssemblyMetadata, target: RegisteredAssembly | undefined, types: RegisteredType[]): UpdatePlan {
  const blockers: UpdatePlan["blockers"] = [];
  const hasPlugins = meta.pluginClasses.some((c) => c.kind === "plugin");
  if (hasPlugins && !meta.publicKeyToken) {
    blockers.push({ kind: "unsigned", message: `${meta.name}.dll isn't signed. Dataverse only accepts plug-in assemblies with a strong name (a .snk key).` });
  }
  if (meta.publicKeyToken && !meta.signed) {
    blockers.push({
      kind: "delaySigned",
      message: `${meta.name}.dll has a public key but no signature (delay-signed or public-signed). Dataverse needs it fully signed: sign with the key pair (.snk) and turn off DelaySign and PublicSign.`,
    });
  }
  if (!meta.pluginClasses.length) {
    blockers.push({ kind: "empty", message: `${meta.name}.dll has no public classes that implement IPlugin or derive from CodeActivity, so there's nothing to register.` });
  }
  if (!target) {
    return { blockers, newClasses: meta.pluginClasses, missing: [], groupRenames: [] };
  }
  if (target._packageid_value) {
    blockers.push({ kind: "package", message: `${target.name} is registered as part of a plug-in package. Build the package (.nupkg) and push that instead.` });
  }
  if (target.ismanaged) {
    blockers.push({ kind: "managed", message: `${target.name} in this environment came from a managed solution, so it can't be updated here. Update it in the development environment and ship a new solution version.` });
  }
  if (target.name !== meta.name) {
    blockers.push({ kind: "name", message: `The registered assembly is named ${target.name}, but this build is ${meta.name}.` });
  }
  if (majorMinor(target.version) !== majorMinor(meta.version)) {
    blockers.push({
      kind: "version",
      message: `The registered ${target.name} is version ${target.version} and this build is ${meta.version}. Dataverse only accepts changes to the last two parts of the version when updating an assembly.`,
    });
  }
  const registeredToken = (target.publickeytoken ?? "").toLowerCase();
  const buildToken = (meta.publicKeyToken ?? "").toLowerCase();
  if (registeredToken !== buildToken && !blockers.some((b) => b.kind === "unsigned")) {
    blockers.push({
      kind: "token",
      message: !buildToken
        ? `This build isn't signed, but the registered ${target.name} is (public key token ${registeredToken}). Dataverse only accepts an update signed with the original key.`
        : !registeredToken
          ? `This build is signed (public key token ${buildToken}), but the registered ${target.name} isn't. Dataverse won't accept a change of signing as an update.`
          : `This build is signed with a different key (public key token ${buildToken}) than the registered ${target.name} (${registeredToken}). Dataverse only accepts an update signed with the original key.`,
    });
  }
  const registeredCulture = (target.culture || "neutral").toLowerCase();
  if (registeredCulture !== meta.culture.toLowerCase()) {
    blockers.push({ kind: "culture", message: `The registered ${target.name} has culture ${registeredCulture}; this build has ${meta.culture}.` });
  }

  const byName = new Map(types.map((t) => [t.typename.toLowerCase(), t]));
  const newClasses = meta.pluginClasses.filter((c) => !byName.has(c.typeName.toLowerCase()));
  // Classes whose base class is in another assembly can't be classified from this DLL alone.
  // If they're registered, keep them: never offer to unregister something that may still be a plug-in.
  const inBuild = new Set([...meta.pluginClasses.map((c) => c.typeName), ...meta.unresolvedBases.map((u) => u.typeName)].map((n) => n.toLowerCase()));
  const missing = types.filter((t) => !inBuild.has(t.typename.toLowerCase()));
  const oldGroup = defaultGroupName(target.name, target.version);
  const newGroup = defaultGroupName(meta.name, meta.version);
  const groupRenames = oldGroup === newGroup
    ? []
    : types.filter((t) => t.isworkflowactivity && t.workflowactivitygroupname === oldGroup && inBuild.has(t.typename.toLowerCase())).map((t) => ({ id: t.plugintypeid, name: newGroup }));
  return { blockers, newClasses, missing, groupRenames };
}

export interface PushResult {
  assemblyId: string;
  created: boolean;
  newTypes: Array<{ id: string; typeName: string; kind: PluginClass["kind"] }>;
  removedTypes: string[];
  removedSteps: number;
}

/** What the Plugin Registration Tool lets you set on a plug-in type. Empty fields fall back to its defaults. */
export interface TypeDetails {
  name?: string;
  friendlyName?: string;
  description?: string;
  workflowGroup?: string;
}

/** What the Plugin Registration Tool lets you set when registering an assembly. */
export interface AssemblyDetails {
  description?: string;
  isolationMode?: number;
  /** By full type name. */
  types?: Record<string, TypeDetails>;
}

function typeBody(meta: AssemblyMetadata, c: PluginClass, assemblyId: string, details: TypeDetails = {}): Record<string, unknown> {
  return {
    typename: c.typeName,
    name: details.name || c.typeName,
    // The Plugin Registration Tool's default: a GUID, so the tree shows the type name.
    friendlyname: details.friendlyName || crypto.randomUUID(),
    ...(details.description ? { description: details.description } : {}),
    ...(c.kind === "workflow" ? { workflowactivitygroupname: details.workflowGroup || defaultGroupName(meta.name, meta.version) } : {}),
    "pluginassemblyid@odata.bind": `/pluginassemblies(${assemblyId})`,
  };
}

/** First registration: the assembly (sandboxed unless chosen otherwise, stored in the database) and a type for each class. */
export async function registerAssembly(
  dv: DataverseClient,
  meta: AssemblyMetadata,
  content: Buffer,
  options: { solution?: string; details?: AssemblyDetails; log?: (line: string) => void } = {}
): Promise<PushResult> {
  const headers: Record<string, string> = options.solution ? { "MSCRM.SolutionUniqueName": options.solution } : {};
  const details = options.details ?? {};
  const assemblyId = await dv.create(
    "pluginassemblies",
    {
      name: meta.name,
      version: meta.version,
      culture: meta.culture,
      publickeytoken: meta.publicKeyToken ?? null,
      isolationmode: details.isolationMode ?? ISOLATION_SANDBOX,
      sourcetype: SOURCE_DATABASE,
      ...(details.description ? { description: details.description } : {}),
      content: content.toString("base64"),
    },
    headers
  );
  options.log?.(`Registered ${meta.name} ${meta.version} (${assemblyId})\n`);
  const newTypes: PushResult["newTypes"] = [];
  for (const c of meta.pluginClasses) {
    // Like the Plugin Registration Tool: only the assembly goes into the solution; its types come with it.
    const id = await dv.create("plugintypes", typeBody(meta, c, assemblyId, details.types?.[c.typeName]));
    options.log?.(`Registered ${c.kind === "workflow" ? "workflow activity" : "plug-in"} ${c.typeName}\n`);
    newTypes.push({ id, typeName: c.typeName, kind: c.kind });
  }
  return { assemblyId, created: true, newTypes, removedTypes: [], removedSteps: 0 };
}

/**
 * Updates a registered assembly in place: unregisters types the build no longer
 * has (with their steps, only when allowed), replaces the content, then
 * registers types for new classes.
 */
export async function updateAssembly(
  dv: DataverseClient,
  meta: AssemblyMetadata,
  content: Buffer,
  target: RegisteredAssembly,
  plan: UpdatePlan,
  options: { removals?: RemovalCheck[]; log?: (line: string) => void }
): Promise<PushResult> {
  if (plan.blockers.length) throw new Error(plan.blockers.map((b) => b.message).join(" "));
  const missingIds = new Set(plan.missing.map((t) => t.plugintypeid));
  // Only types the plan says are gone, and only ones the checks cleared.
  const removals = (options.removals ?? []).filter((r) => !r.problems.length && missingIds.has(r.type.plugintypeid));
  const covered = new Set(removals.map((r) => r.type.plugintypeid));
  if (plan.missing.some((t) => !covered.has(t.plugintypeid))) throw new Error("Registered types are missing from the build and weren't cleared for removal.");
  let removedSteps = 0;
  for (const r of removals) {
    for (const step of r.steps) {
      await dv.remove(`sdkmessageprocessingsteps(${step.id})`);
      options.log?.(`Unregistered step ${step.name}\n`);
      removedSteps++;
      if (step.secureConfigId) {
        // The Plugin Registration Tool removes these too; they often hold credentials.
        try {
          await dv.remove(`sdkmessageprocessingstepsecureconfigs(${step.secureConfigId})`);
        } catch (err) {
          options.log?.(`Couldn't remove the secure configuration of ${step.name}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
    await dv.remove(`plugintypes(${r.type.plugintypeid})`);
    options.log?.(`Unregistered ${r.type.typename}\n`);
  }
  await dv.update(`pluginassemblies(${target.pluginassemblyid})`, {
    name: meta.name,
    version: meta.version,
    culture: meta.culture,
    publickeytoken: meta.publicKeyToken ?? null,
    sourcetype: SOURCE_DATABASE,
    content: content.toString("base64"),
  });
  options.log?.(`Updated ${meta.name} ${target.version} -> ${meta.version}\n`);
  const newTypes: PushResult["newTypes"] = [];
  for (const c of plan.newClasses) {
    const id = await dv.create("plugintypes", typeBody(meta, c, target.pluginassemblyid));
    options.log?.(`Registered ${c.kind === "workflow" ? "workflow activity" : "plug-in"} ${c.typeName}\n`);
    newTypes.push({ id, typeName: c.typeName, kind: c.kind });
  }
  for (const r of plan.groupRenames) await dv.update(`plugintypes(${r.id})`, { workflowactivitygroupname: r.name });
  return { assemblyId: target.pluginassemblyid, created: false, newTypes, removedTypes: plan.missing.map((t) => t.typename), removedSteps };
}

// ---------- plug-in packages ----------

export interface PackageInfo {
  id: string;
  version: string;
}

/** The package ID and version from the .nuspec inside a .nupkg. */
export function readPackage(nupkg: Buffer): PackageInfo {
  const nuspec = readZip(nupkg).find((e) => /^[^/]+\.nuspec$/i.test(e.name));
  if (!nuspec) throw new Error("The .nupkg has no .nuspec.");
  const xml = nuspec.data.toString("utf8");
  const id = xml.match(/<id>\s*([^<]+?)\s*<\/id>/i)?.[1];
  const version = xml.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1];
  if (!id || !version) throw new Error("The .nuspec has no id or version.");
  return { id, version };
}

/** An assembly's DLL inside a .nupkg (lib/<framework>/<assembly>.dll), or undefined when it isn't there. */
export function assemblyInPackage(nupkg: Buffer, assembly: string): Buffer | undefined {
  return readZip(nupkg).find((e) => e.name.toLowerCase().endsWith(`/${assembly.toLowerCase()}.dll`))?.data;
}

/** An assembly's version, for messages; never throws. */
export function versionOf(dll: Buffer): string {
  try {
    return readAssembly(dll).version;
  } catch {
    return "an unreadable version";
  }
}

/**
 * Why the .nupkg found after a build isn't that build's package, or undefined when it is: the DLL
 * inside has to be the DLL the build made (built, from bin; undefined when there's none to compare).
 * A build writes its package after the DLL, and the copies of the DLL in bin and the publish folder
 * keep its time, so a package older than the DLL wasn't made from it. That holds for a version that
 * never changes (1.0.0.0) too, and doesn't depend on the clock. A package packed after the DLL with
 * the same version is accepted even when the bytes differ (a packaging step may change the DLL).
 */
export function stalePackageReason(
  pkg: { name: string; content: Buffer; writtenAt: number },
  built: { content: Buffer; writtenAt: number } | undefined,
  assembly: string
): string | undefined {
  if (!built) return undefined;
  const packaged = assemblyInPackage(pkg.content, assembly);
  if (!packaged) return `${assembly}.dll isn't in ${pkg.name}.`;
  if (packaged.equals(built.content)) return undefined;
  const inside = versionOf(packaged);
  const made = versionOf(built.content);
  const packedAfter = pkg.writtenAt >= built.writtenAt;
  if (packedAfter && inside === made) return undefined;
  if (packedAfter) return `${pkg.name} holds ${assembly} ${inside}, but the build made ${made}.`;
  const holds = inside === made ? `an older build of ${assembly} (also ${inside})` : `${assembly} ${inside}`;
  return `${pkg.name} (${new Date(pkg.writtenAt).toLocaleString()}) is older than the ${assembly}.dll this build made (${made}) and holds ${holds}: the build didn't pack the new DLL.`;
}

/**
 * The version of an assembly when the registered package already holds this exact build of it (the same
 * DLL), else undefined. Only a matching version costs the download of the package's content.
 */
export async function deployedInPackage(dv: DataverseClient, packageId: string, assembly: string, dll: Buffer): Promise<string | undefined> {
  const version = versionOf(dll);
  const rows = await dv.getAll<{ name: string; version: string }>(`pluginassemblies?$select=name,version&$filter=_packageid_value eq ${packageId}`);
  if (!rows.some((r) => r.name.toLowerCase() === assembly.toLowerCase() && r.version === version)) return undefined;
  const row = await dv.getJson<{ content?: string | null }>(`pluginpackages(${packageId})?$select=content`);
  const deployed = row.content ? assemblyInPackage(Buffer.from(row.content, "base64"), assembly) : undefined;
  return deployed?.equals(dll) ? version : undefined;
}

export interface RegisteredPackage {
  pluginpackageid: string;
  name?: string | null;
  uniquename: string;
  version: string;
  ismanaged: boolean;
}

/**
 * Whether a registered package is the one with this package ID. The Plugin Registration
 * Tool registers package "Contoso.Plugins" as uniquename "contoso_Contoso.Plugins" (the
 * publisher's prefix), so both spellings count, and so does a name equal to the ID.
 */
export function isPackageFor(row: Pick<RegisteredPackage, "uniquename" | "name">, packageId: string): boolean {
  const id = packageId.toLowerCase();
  const unique = row.uniquename.toLowerCase();
  if (unique === id || (row.name ?? "").toLowerCase() === id) return true;
  return unique.endsWith(`_${id}`) && /^[a-z0-9]+$/.test(unique.slice(0, unique.length - id.length - 1));
}

export async function registeredPackage(dv: DataverseClient, pkg: PackageInfo, savedId?: string): Promise<RegisteredPackage | undefined> {
  const columns = "pluginpackageid,name,uniquename,version,ismanaged";
  if (savedId) {
    const byId = await dv.getAll<RegisteredPackage>(`pluginpackages?$select=${columns}&$filter=pluginpackageid eq ${savedId}`);
    // A saved ID only counts when it's the same package; an old ID must never receive another package's content.
    if (byId[0] && isPackageFor(byId[0], pkg.id)) return byId[0];
  }
  const id = q(pkg.id);
  const rows = await dv.getAll<RegisteredPackage>(`pluginpackages?$select=${columns}&$filter=uniquename eq '${id}' or endswith(uniquename,'_${id}') or name eq '${id}'`);
  return rows.find((r) => isPackageFor(r, pkg.id));
}

/** The customization prefix of a solution's publisher; with no solution, the Default solution's publisher (where Dataverse puts the component). */
export async function publisherPrefix(dv: DataverseClient, solution?: string): Promise<string | undefined> {
  const rows = await dv.getAll<{ publisherid?: { customizationprefix?: string | null } | null }>(
    `solutions?$select=uniquename&$filter=uniquename eq '${q(solution || "Default")}'&$expand=publisherid($select=customizationprefix)`
  );
  return rows[0]?.publisherid?.customizationprefix || undefined;
}

/** Dataverse requires a package's unique name to start with a publisher prefix: "contoso_" + the package ID, unless the ID already has it. */
export function packageUniqueName(packageId: string, prefix: string): string {
  return packageId.toLowerCase().startsWith(`${prefix.toLowerCase()}_`) ? packageId : `${prefix}_${packageId}`;
}

/** Creates or updates a plug-in package. Dataverse registers the assemblies and types inside it itself. */
export async function pushPackage(
  dv: DataverseClient,
  pkg: PackageInfo,
  content: Buffer,
  existing: RegisteredPackage | undefined,
  options: { solution?: string; name?: string; uniqueName?: string } = {}
): Promise<{ id: string; created: boolean; uniqueName: string }> {
  if (existing) {
    await dv.update(`pluginpackages(${existing.pluginpackageid})`, {
      content: content.toString("base64"),
      ...(existing.version !== pkg.version ? { version: pkg.version } : {}),
    });
    return { id: existing.pluginpackageid, created: false, uniqueName: existing.uniquename };
  }
  const uniqueName = options.uniqueName || pkg.id;
  const id = await dv.create(
    "pluginpackages",
    { name: options.name || pkg.id, uniquename: uniqueName, version: pkg.version, content: content.toString("base64") },
    options.solution ? { "MSCRM.SolutionUniqueName": options.solution } : {}
  );
  return { id, created: true, uniqueName };
}

// ---------- editing a registration ----------

export interface AssemblyProps {
  pluginassemblyid: string;
  name: string;
  version: string;
  description: string | null;
  isolationmode: number;
  ismanaged: boolean;
  _packageid_value?: string | null;
}

export interface TypeProps {
  plugintypeid: string;
  typename: string;
  name: string | null;
  friendlyname: string | null;
  description: string | null;
  workflowactivitygroupname: string | null;
  isworkflowactivity: boolean;
  ismanaged: boolean;
  _pluginassemblyid_value: string;
}

export interface PackageProps {
  pluginpackageid: string;
  name: string | null;
  uniquename: string;
  version: string;
  ismanaged: boolean;
}

const TYPE_PROPS = "plugintypeid,typename,name,friendlyname,description,workflowactivitygroupname,isworkflowactivity,ismanaged,_pluginassemblyid_value";

/** An assembly's editable properties, its types', and its package's when it's in one. */
export async function registrationProps(dv: DataverseClient, assemblyId: string): Promise<{ assembly: AssemblyProps; types: TypeProps[]; pkg?: PackageProps }> {
  const assembly = await dv.getJson<AssemblyProps>(`pluginassemblies(${assemblyId})?$select=pluginassemblyid,name,version,description,isolationmode,ismanaged,_packageid_value`);
  const types = await dv.getAll<TypeProps>(`plugintypes?$select=${TYPE_PROPS}&$filter=_pluginassemblyid_value eq ${assemblyId}&$orderby=typename`);
  const pkg = assembly._packageid_value
    ? await dv.getJson<PackageProps>(`pluginpackages(${assembly._packageid_value})?$select=pluginpackageid,name,uniquename,version,ismanaged`)
    : undefined;
  return { assembly, types, pkg };
}

export async function typeProps(dv: DataverseClient, typeId: string): Promise<TypeProps> {
  return dv.getJson<TypeProps>(`plugintypes(${typeId})?$select=${TYPE_PROPS}`);
}

export interface RegistrationChanges {
  assembly?: { id: string; patch: Record<string, unknown> };
  pkg?: { id: string; patch: Record<string, unknown> };
  types: Array<{ id: string; typeName: string; patch: Record<string, unknown> }>;
}

/** Saves edited properties: one update per row that changed. */
export async function saveRegistration(dv: DataverseClient, changes: RegistrationChanges, log?: (line: string) => void): Promise<number> {
  let n = 0;
  if (changes.pkg && Object.keys(changes.pkg.patch).length) {
    await dv.update(`pluginpackages(${changes.pkg.id})`, changes.pkg.patch);
    log?.(`Updated the package: ${Object.keys(changes.pkg.patch).join(", ")}\n`);
    n++;
  }
  if (changes.assembly && Object.keys(changes.assembly.patch).length) {
    await dv.update(`pluginassemblies(${changes.assembly.id})`, changes.assembly.patch);
    log?.(`Updated the assembly: ${Object.keys(changes.assembly.patch).join(", ")}\n`);
    n++;
  }
  for (const t of changes.types) {
    if (!Object.keys(t.patch).length) continue;
    await dv.update(`plugintypes(${t.id})`, t.patch);
    log?.(`Updated ${t.typeName}: ${Object.keys(t.patch).join(", ")}\n`);
    n++;
  }
  return n;
}

// ---------- downloading ----------

export interface OrgAssembly extends RegisteredAssembly {
  packageName?: string;
}

/** Custom assemblies in the org (Microsoft's are hidden), for picking one to download. */
export async function customAssemblies(dv: DataverseClient): Promise<OrgAssembly[]> {
  const rows = await dv.getAll<RegisteredAssembly & { "_packageid_value@OData.Community.Display.V1.FormattedValue"?: string }>(
    `pluginassemblies?$select=${ASSEMBLY_COLUMNS}&$filter=customizationlevel eq 1&$orderby=name`,
    { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' }
  );
  return rows.map((r) => ({ ...r, packageName: r._packageid_value ? r["_packageid_value@OData.Community.Display.V1.FormattedValue"] ?? "a plug-in package" : undefined }));
}

/** The DLL bytes of a registered assembly. Assemblies inside a plug-in package come out of the package's .nupkg. */
export async function downloadAssembly(dv: DataverseClient, a: OrgAssembly): Promise<{ dll: Buffer; dependencies: Array<{ name: string; data: Buffer }> }> {
  if (a._packageid_value) {
    const pkg = await dv.getJson<{ content?: string | null }>(`pluginpackages(${a._packageid_value})?$select=content`);
    if (!pkg.content) throw new Error(`Dataverse returned no content for the package that contains ${a.name}.`);
    const dlls = readZip(Buffer.from(pkg.content, "base64")).filter((e) => /^lib\/[^/]+\/[^/]+\.dll$/i.test(e.name));
    const main = dlls.find((e) => e.name.split("/").pop()!.toLowerCase() === `${a.name.toLowerCase()}.dll`);
    if (!main) throw new Error(`${a.name}.dll isn't in its package.`);
    // Names come from the package in Dataverse and become file names, so only plain DLL names are kept.
    const dependencies = dlls
      .filter((e) => e !== main)
      .map((e) => ({ name: e.name.split("/").pop()!, data: e.data }))
      .filter((d) => /^[A-Za-z0-9_][\w.-]*\.dll$/i.test(d.name));
    return { dll: main.data, dependencies };
  }
  const row = await dv.getJson<{ content?: string | null }>(`pluginassemblies(${a.pluginassemblyid})?$select=content`);
  if (!row.content) throw new Error(`Dataverse returned no content for ${a.name}. It may be registered on disk or in the GAC (on-premises), where Dataverse doesn't keep a copy.`);
  return { dll: Buffer.from(row.content, "base64"), dependencies: [] };
}

// ---------- unregistering a package ----------

export interface PackageContents {
  pkg: RegisteredPackage;
  assemblies: RegisteredAssembly[];
  types: Array<{ plugintypeid: string; typename: string; _pluginassemblyid_value: string }>;
  steps: Array<{ id: string; name: string; secureConfigId: string | null }>;
}

/** The org's unmanaged plug-in packages, by name. */
export async function listPackages(dv: DataverseClient): Promise<RegisteredPackage[]> {
  return dv.getAll<RegisteredPackage>("pluginpackages?$select=pluginpackageid,name,uniquename,version,ismanaged&$filter=ismanaged eq false&$orderby=name");
}

/** What unregistering the package deletes: its assemblies, their plug-in types, and every step on those types. */
export async function packageContents(dv: DataverseClient, pkg: RegisteredPackage): Promise<PackageContents> {
  const assemblies = await dv.getAll<RegisteredAssembly>(`pluginassemblies?$select=${ASSEMBLY_COLUMNS}&$filter=_packageid_value eq ${pkg.pluginpackageid}`);
  const types: PackageContents["types"] = [];
  for (const a of assemblies) {
    types.push(...(await dv.getAll<PackageContents["types"][number]>(`plugintypes?$select=plugintypeid,typename,_pluginassemblyid_value&$filter=_pluginassemblyid_value eq ${a.pluginassemblyid}`)));
  }
  const steps: PackageContents["steps"] = [];
  for (const t of types) {
    const rows = await dv.getAll<{ sdkmessageprocessingstepid: string; name: string; _sdkmessageprocessingstepsecureconfigid_value: string | null }>(
      `sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,_sdkmessageprocessingstepsecureconfigid_value&$filter=_plugintypeid_value eq ${t.plugintypeid}`
    );
    steps.push(...rows.map((r) => ({ id: r.sdkmessageprocessingstepid, name: r.name, secureConfigId: r._sdkmessageprocessingstepsecureconfigid_value })));
  }
  return { pkg, assemblies, types, steps };
}

/**
 * Deletes the package. Dataverse removes its assemblies and plug-in types with it, but refuses
 * while any of their steps exist, so the steps go first (their images go with them; secure
 * configurations are removed too, as the Plugin Registration Tool does). Run checkRemovals on
 * its types first: once the steps are gone, anything else that stops the package delete
 * leaves them gone.
 */
export async function unregisterPackage(dv: DataverseClient, c: PackageContents, log?: (line: string) => void): Promise<void> {
  for (const step of c.steps) {
    await dv.remove(`sdkmessageprocessingsteps(${step.id})`);
    log?.(`Unregistered step ${step.name}\n`);
    if (step.secureConfigId) {
      try {
        await dv.remove(`sdkmessageprocessingstepsecureconfigs(${step.secureConfigId})`);
      } catch (err) {
        log?.(`Couldn't remove the secure configuration of ${step.name}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  await dv.remove(`pluginpackages(${c.pkg.pluginpackageid})`);
  log?.(`Unregistered package ${c.pkg.uniquename}${c.assemblies.length ? ` with ${c.assemblies.map((a) => a.name).join(", ")}` : ""}\n`);
}
