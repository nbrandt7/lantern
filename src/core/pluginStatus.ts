import * as fs from "fs";
import * as path from "path";
import { fetchSteps, StepInfo } from "./admin";
import { Client } from "./clients";
import { CsPluginClass, projectPluginClasses, projectSourceFiles } from "./csharp";
import { DataverseClient } from "./dataverse";
import { RegisteredAssembly } from "./pluginRegistration";
import { PluginProject, pluginIdFor } from "./solutions";

/**
 * One plug-in, two places: the project in the client folder and its
 * registration in the active environment. Classes are matched to registered
 * plug-in types by full type name, the name Dataverse stores.
 */

export interface RegisteredTypeInfo {
  plugintypeid: string;
  typename: string;
  isworkflowactivity: boolean;
  assemblyname: string;
  _pluginassemblyid_value: string;
}

export interface ClassStatus {
  typeName: string;
  /** The class in your code, if it's there. */
  cls?: CsPluginClass;
  /** The registered plug-in type, if there is one. */
  type?: RegisteredTypeInfo;
  kind: "plugin" | "workflow";
  steps: StepInfo[];
}

export interface ProjectStatus {
  /** The registered copy your code corresponds to (same name, same major.minor version when there are several). */
  registered?: RegisteredAssembly;
  /** Other registered assemblies with the same name (side-by-side versions). */
  others: RegisteredAssembly[];
  localVersion: string;
  classes: ClassStatus[];
}

interface OrgPlugins {
  at: number;
  assemblies: RegisteredAssembly[];
  types: RegisteredTypeInfo[];
  steps: StepInfo[];
}

const TTL_MS = 30_000;
const cache = new Map<string, OrgPlugins>();
const inflight = new Map<string, Promise<OrgPlugins>>();
const keyOf = (client: Client) => `${client.name}@${client.orgHost}`;

/** Every custom assembly, plug-in type and step in the org, in three queries, cached briefly. */
export async function orgPlugins(client: Client, dv: DataverseClient, fresh = false): Promise<OrgPlugins> {
  const key = keyOf(client);
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL_MS) return hit;
  const running = inflight.get(key);
  if (running && !fresh) return running;
  const load = (async () => {
    const [assemblies, types, steps] = await Promise.all([
      dv.getAll<RegisteredAssembly>("pluginassemblies?$select=pluginassemblyid,name,version,culture,publickeytoken,isolationmode,ismanaged,_packageid_value&$filter=customizationlevel eq 1&$orderby=name"),
      dv.getAll<RegisteredTypeInfo>("plugintypes?$select=plugintypeid,typename,isworkflowactivity,assemblyname,_pluginassemblyid_value&$filter=customizationlevel eq 1"),
      fetchSteps(dv),
    ]);
    const value = { at: Date.now(), assemblies, types, steps };
    cache.set(key, value);
    return value;
  })();
  inflight.set(key, load);
  try {
    return await load;
  } finally {
    inflight.delete(key);
  }
}

export function forgetOrgPlugins(client?: Client): void {
  if (!client) cache.clear();
  else cache.delete(keyOf(client));
}

/** The version a project builds: AssemblyVersion or Version in the .csproj, else [assembly: AssemblyVersion] in its code. */
export function localVersion(csproj: string): string {
  const xml = fs.readFileSync(csproj, "utf8");
  const fromProject = /<AssemblyVersion>\s*([\d.*]+)\s*<\/AssemblyVersion>/i.exec(xml)?.[1] ?? /<Version>\s*([\d.]+)[^<]*<\/Version>/i.exec(xml)?.[1];
  if (fromProject) return normalizeVersion(fromProject);
  for (const f of projectSourceFiles(csproj)) {
    const m = /\[\s*assembly\s*:\s*(?:System\.Reflection\.)?AssemblyVersion(?:Attribute)?\s*\(\s*"([^"]+)"/.exec(fs.readFileSync(f, "utf8"));
    if (m) return normalizeVersion(m[1]);
  }
  return "1.0.0.0";
}

function normalizeVersion(v: string): string {
  const parts = v.split(".").map((p) => (p === "*" ? "0" : p));
  while (parts.length < 4) parts.push("0");
  return parts.slice(0, 4).join(".");
}

const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");

/** Matches a project's classes to what's registered, class by class. */
export function projectStatus(client: Client, project: PluginProject, org: OrgPlugins): ProjectStatus {
  const same = org.assemblies.filter((a) => a.name.toLowerCase() === project.assembly.toLowerCase());
  const version = localVersion(project.project);
  const savedId = pluginIdFor(client, project.assembly)?.toLowerCase();
  const registered =
    same.find((a) => a.pluginassemblyid.toLowerCase() === savedId) ??
    same.find((a) => majorMinor(a.version) === majorMinor(version)) ??
    [...same].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const types = registered ? org.types.filter((t) => t._pluginassemblyid_value === registered.pluginassemblyid) : [];
  const classes = projectPluginClasses(project.project, client.dir);
  const out: ClassStatus[] = [];
  const stepsOf = (typeName: string) => org.steps.filter((s) => s.assembly.toLowerCase() === project.assembly.toLowerCase() && s.typeName === typeName);
  for (const cls of classes) {
    const type = types.find((t) => t.typename === cls.fullName);
    out.push({ typeName: cls.fullName, cls, type, kind: type ? (type.isworkflowactivity ? "workflow" : "plugin") : cls.pluginKind, steps: type ? stepsOf(type.typename) : [] });
  }
  for (const type of types) {
    if (out.some((c) => c.type === type)) continue;
    out.push({ typeName: type.typename, type, kind: type.isworkflowactivity ? "workflow" : "plugin", steps: stepsOf(type.typename) });
  }
  out.sort((a, b) => a.typeName.localeCompare(b.typeName));
  return { registered, others: same.filter((a) => a !== registered), localVersion: version, classes: out };
}

/** Registered assemblies with no project in the folder (code that only exists in Dataverse, as far as this folder knows). */
export function assembliesWithoutProjects(org: OrgPlugins, projects: PluginProject[]): RegisteredAssembly[] {
  const local = new Set(projects.map((p) => p.assembly.toLowerCase()));
  const seen = new Set<string>();
  return org.assemblies.filter((a) => {
    const name = a.name.toLowerCase();
    if (local.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** The project in the folder that builds an assembly, if any. */
export function projectForAssembly(projects: PluginProject[], assembly: string): PluginProject | undefined {
  return projects.find((p) => p.assembly.toLowerCase() === assembly.toLowerCase());
}

export const relativeTo = (client: Client, file: string) => path.relative(client.dir, file);
