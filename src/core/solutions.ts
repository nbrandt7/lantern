import * as fs from "fs";
import * as path from "path";
import { findFiles, findUp, isDirectory, isInside, SKIP_DIRS, toPosix } from "./files";
import { Client } from "./clients";

// ---------- solutions ----------

/** Unpacked solution folders: anything with a .cdsproj, or an Other/Solution.xml. */
export function findSolutionFolders(dir: string): string[] {
  const found: string[] = [];
  if (!isDirectory(dir)) return found;
  const walk = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith(".cdsproj"))) {
      found.push(current);
      return;
    }
    if (fs.existsSync(path.join(current, "Other", "Solution.xml"))) {
      found.push(current);
      return;
    }
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(current, e.name));
  };
  walk(dir);
  return found;
}

// ---------- plug-ins ----------

const SDK_REFERENCE = /Microsoft\.CrmSdk\.CoreAssemblies|Microsoft\.Xrm\.Sdk|Microsoft\.PowerPlatform\.Dataverse/;

export interface PluginProject {
  project: string;
  assembly: string;
}

/** .csproj files that reference the Dataverse SDK. */
export function findPluginProjects(dir: string): PluginProject[] {
  return findFiles(dir, (n) => n.toLowerCase().endsWith(".csproj"))
    .filter((p) => SDK_REFERENCE.test(fs.readFileSync(p, "utf8")))
    .map((project) => ({ project, assembly: assemblyNameOf(project) }))
    .sort((a, b) => a.assembly.localeCompare(b.assembly));
}

export function assemblyNameOf(project: string): string {
  const match = fs.readFileSync(project, "utf8").match(/<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/);
  return match ? match[1] : path.basename(project, ".csproj");
}

/** The .csproj that contains a source file. */
export function projectForFile(file: string, stopAt: string): string | undefined {
  const dir = findUp(path.dirname(file), (d) => fs.readdirSync(d).some((n) => n.toLowerCase().endsWith(".csproj")), stopAt);
  if (!dir) return undefined;
  const name = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".csproj"));
  return name ? path.join(dir, name) : undefined;
}

/** Unpacked solutions keep each registered assembly in PluginAssemblies/<AssemblyName>-<guid>/. */
export function pluginIdsFromSolutions(dir: string): Record<string, string> {
  const ids: Record<string, string> = {};
  const pattern = /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const walk = (current: string, underPluginFolder: boolean): void => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const match = underPluginFolder ? e.name.match(pattern) : null;
      if (match) ids[match[1]] = match[2];
      walk(path.join(current, e.name), e.name.toLowerCase() === "pluginassemblies");
    }
  };
  if (isDirectory(dir)) walk(dir, false);
  return ids;
}

export function pluginIdFor(client: Client, assembly: string): string | undefined {
  const known: Record<string, string> = { ...pluginIdsFromSolutions(client.dir), ...client.config.plugins };
  const key = Object.keys(known).find((k) => k.toLowerCase() === assembly.toLowerCase());
  return key ? known[key] : undefined;
}

export interface BuildOutput {
  file: string;
  type: "Nuget" | "Assembly";
}

/**
 * Tests a lower-case file name for this project's package files: "<id>.<version>.nupkg" (or .nuspec),
 * where the id is the PackageId (often with a publisher prefix) or the assembly name. The version has
 * to follow the id, so Contoso.Plugins doesn't take Contoso.Plugins.Extra's package, nor a .symbols.nupkg.
 */
function packageFileTest(p: PluginProject, extension: ".nupkg" | ".nuspec"): (lowerName: string) => boolean {
  const packageId = fs.readFileSync(p.project, "utf8").match(/<PackageId>\s*([^<]+?)\s*<\/PackageId>/i)?.[1].toLowerCase();
  const ids = [p.assembly.toLowerCase(), ...(packageId ? [packageId] : [])];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(${ids.map(escape).join("|")})\\.\\d+(\\.\\d+)*([-+][\\w.-]*)?${escape(extension)}$`);
  return (n) => re.test(n);
}

/** The newest build outputs of a plug-in project: its .nupkg (plug-in package) and its assembly .dll, whichever exist. */
export function findBuildOutputs(p: PluginProject, configuration: string): { nupkg?: string; dll?: string } {
  const bin = path.join(path.dirname(p.project), "bin", configuration);
  const lower = p.assembly.toLowerCase();
  const newest = (test: (name: string) => boolean) =>
    findAll(bin, test).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] as string | undefined;
  return {
    nupkg: newest(packageFileTest(p, ".nupkg")),
    dll: newest((n) => n === `${lower}.dll`),
  };
}

/** The project makes its .nupkg when it builds: a plug-in package project (Microsoft.PowerApps.MSBuild.Plugin), or GeneratePackageOnBuild. */
export function packsOnBuild(p: PluginProject): boolean {
  const text = fs.readFileSync(p.project, "utf8");
  return /Microsoft\.PowerApps\.MSBuild\.Plugin/i.test(text) || /<GeneratePackageOnBuild>\s*true\s*</i.test(text);
}

/**
 * Deletes the .nupkg (and the .nuspec it was made from) that the last build of a package project left.
 * The plug-in package targets add the DLL to the package from the publish folder, which NuGet doesn't
 * count as an input, so an incremental build that recompiles the DLL keeps the old package as "up to
 * date". With the package gone, the build has to make a new one. Returns the files deleted; a file that
 * can't be deleted (open elsewhere) is left, and the check after the build catches a stale one.
 */
export function clearBuiltPackages(p: PluginProject, configuration: string): string[] {
  if (!packsOnBuild(p)) return [];
  const dir = path.dirname(p.project);
  const stale = [
    ...findAll(path.join(dir, "bin", configuration), packageFileTest(p, ".nupkg")),
    ...findAll(path.join(dir, "obj", configuration), packageFileTest(p, ".nuspec")),
  ];
  return stale.filter((file) => {
    try {
      fs.rmSync(file);
      return true;
    } catch {
      return false;
    }
  });
}

/** One build output: the preferred kind when the project built both, else whichever it built. */
export function findBuildOutput(p: PluginProject, configuration: string, prefer: BuildOutput["type"] = "Nuget"): BuildOutput | undefined {
  const { nupkg, dll } = findBuildOutputs(p, configuration);
  const asPackage = nupkg ? { file: nupkg, type: "Nuget" as const } : undefined;
  const asAssembly = dll ? { file: dll, type: "Assembly" as const } : undefined;
  return prefer === "Assembly" ? asAssembly ?? asPackage : asPackage ?? asAssembly;
}

function findAll(folder: string, test: (lowerName: string) => boolean): string[] {
  const out: string[] = [];
  if (!isDirectory(folder)) return out;
  const walk = (current: string): void => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (test(e.name.toLowerCase())) out.push(full);
    }
  };
  walk(folder);
  return out;
}

// ---------- web resources ----------

const WEB_RESOURCE_TYPES: Record<string, number> = {
  ".htm": 1, ".html": 1, ".css": 2, ".js": 3, ".xml": 4, ".png": 5, ".jpg": 6, ".jpeg": 6,
  ".gif": 7, ".xap": 8, ".xsl": 9, ".xslt": 9, ".ico": 10, ".svg": 11, ".resx": 12,
};

/**
 * Type from the file extension or, for web resources named without one
 * (e.g. "cr36f_AccountFormOnLoad"), from the solution's <file>.data.xml.
 */
export function webResourceType(file: string): number | undefined {
  const byExtension = WEB_RESOURCE_TYPES[path.extname(file).toLowerCase()];
  if (byExtension) return byExtension;
  const dataXml = `${file}.data.xml`;
  if (!fs.existsSync(dataXml)) return undefined;
  const match = fs.readFileSync(dataXml, "utf8").match(/<WebResourceType>\s*(\d+)\s*<\/WebResourceType>/i);
  return match ? Number(match[1]) : undefined;
}

const LANGUAGE_BY_TYPE: Record<number, string> = { 1: "html", 2: "css", 3: "javascript", 4: "xml", 9: "xml", 11: "xml", 12: "xml" };

/** VS Code language for a web resource with no file extension, so it gets the right highlighting and IntelliSense. */
export function languageForExtensionless(file: string): string | undefined {
  if (path.extname(file)) return undefined;
  const type = webResourceType(file);
  return type ? LANGUAGE_BY_TYPE[type] : undefined;
}

export function isTextWebResource(file: string): boolean {
  return [1, 2, 3, 4, 9, 11, 12].includes(webResourceType(file) ?? 0);
}

/** A file that could be a web resource: right extension, inside a client, not in tooling or build folders. */
export function isWebResourceCandidate(file: string, client: Client): boolean {
  if (!webResourceType(file)) return false;
  const rel = path.relative(client.dir, file);
  if (rel.startsWith("..")) return false;
  // A configured root can be named like build output ("dist"); only the folders below it are checked.
  const root = client.config.webResourceRoots.map((r) => path.join(client.dir, r)).find((r) => isInside(file, r));
  if (path.relative(root ?? client.dir, file).split(path.sep).some((p) => SKIP_DIRS.has(p))) return false;
  const base = path.basename(file).toLowerCase();
  if (base.endsWith(".data.xml") || base === "solution.xml" || base === "customizations.xml") return false;
  return true;
}

/**
 * Every web resource candidate in a client. The walk skips build folders, so a configured root
 * named like one ("dist") is walked on its own as well.
 */
export function webResourceFiles(client: Client): string[] {
  const roots = [client.dir, ...client.config.webResourceRoots.map((r) => path.join(client.dir, r))];
  const files = new Set<string>();
  for (const root of roots) for (const f of findFiles(root, (_n, full) => isWebResourceCandidate(full, client))) files.add(f);
  return [...files];
}

/**
 * Web resource unique name for a local file, from (in order):
 *  1. the solution's <file>.data.xml, which records the exact name
 *  2. a folder listed in .lantern/config.json "webResourceRoots"
 *  3. the path after a "WebResources" folder
 *  4. the path from the first publisher-prefix folder (e.g. "acme_/scripts/x.js")
 * Returns a guess flagged as such when only 4 applies, so the caller can confirm it.
 */
export function resolveWebResourceName(file: string, client: Client): { name: string; certain: boolean } | undefined {
  const dataXml = `${file}.data.xml`;
  if (fs.existsSync(dataXml)) {
    const match = fs.readFileSync(dataXml, "utf8").match(/<Name>([^<]+)<\/Name>/);
    if (match) return { name: match[1].trim(), certain: true };
  }
  for (const root of client.config.webResourceRoots) {
    const rel = path.relative(path.join(client.dir, root), file);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return { name: toPosix(rel), certain: true };
  }
  const parts = toPosix(path.relative(client.dir, file)).split("/");
  const wr = parts.findIndex((p) => p.toLowerCase() === "webresources");
  if (wr >= 0 && wr < parts.length - 1) return { name: parts.slice(wr + 1).join("/"), certain: true };
  const prefix = parts.findIndex((p) => /^[a-z][a-z0-9]{1,7}_$/i.test(p));
  if (prefix >= 0 && prefix < parts.length - 1) return { name: parts.slice(prefix).join("/"), certain: false };
  return undefined;
}
