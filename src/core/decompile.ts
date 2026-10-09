import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AssemblyReference } from "./assembly";
import { UserError } from "./errors";
import { listFiles } from "./files";
import { Cancellation, run } from "./process";

/**
 * Decompiling with ILSpy's command-line tool (ilspycmd, a .NET global tool) and
 * turning its output into a project that builds and pushes like any other
 * plug-in project.
 */

const toolsDir = () => path.join(os.homedir(), ".dotnet", "tools");

/** A working ilspycmd: the configured path, then PATH, then the .NET global tools folder. */
export async function findIlspy(configured: string): Promise<string | undefined> {
  const candidates = [configured, "ilspycmd", path.join(toolsDir(), process.platform === "win32" ? "ilspycmd.exe" : "ilspycmd")].filter(Boolean);
  for (const cmd of [...new Set(candidates)]) {
    const r = await run(cmd, ["--version"]);
    if (!r.missing && r.code === 0) return cmd;
  }
  return undefined;
}

/** dotnet tool install --global ilspycmd. Returns the tool once it answers. */
export async function installIlspy(dotnet: string, log: (t: string) => void, token?: Cancellation): Promise<string | undefined> {
  log(`> ${dotnet} tool install --global ilspycmd\n`);
  const r = await run(dotnet, ["tool", "install", "--global", "ilspycmd"], { onOutput: log, token });
  if (r.missing) throw new UserError("The .NET SDK (dotnet) isn't installed or isn't on your PATH, so ILSpy can't be installed.");
  if (r.code !== 0 && !/already installed/i.test(r.stdout + r.stderr)) throw new UserError("Installing ilspycmd failed. See the Lantern output for details.");
  return findIlspy("");
}

/** Reference assemblies from the local NuGet cache, so ILSpy can resolve SDK types (better output). */
export function referenceDirs(): string[] {
  const root = process.env.NUGET_PACKAGES || path.join(os.homedir(), ".nuget", "packages");
  const out: string[] = [];
  for (const pkg of ["microsoft.crmsdk.coreassemblies", "microsoft.crmsdk.workflow"]) {
    const dir = path.join(root, pkg);
    if (!fs.existsSync(dir)) continue;
    const versions = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const lib = path.join(dir, v, "lib", "net462");
      if (fs.existsSync(lib)) {
        out.push(lib);
        break;
      }
    }
  }
  return out;
}

/** ilspycmd -p: one .cs file per type, in folders per namespace, plus a project file we replace. */
export async function decompileProject(ilspy: string, dll: string, outDir: string, options: { references?: string[]; log: (t: string) => void; token?: Cancellation }): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const args = ["-p", "-o", outDir, ...(options.references ?? []).flatMap((r) => ["-r", r]), dll];
  options.log(`> ${ilspy} ${args.join(" ")}\n`);
  const r = await run(ilspy, args, { onOutput: options.log, token: options.token });
  if (r.missing) throw new UserError("ilspycmd isn't installed.");
  if (r.code !== 0) throw new UserError(`ILSpy couldn't decompile ${path.basename(dll)}. See the Lantern output for details.`);
  for (const f of fs.readdirSync(outDir)) if (/\.(cs|vb)proj$/i.test(f)) fs.rmSync(path.join(outDir, f));
}

// ---------- the project file ----------

/** Framework assemblies an SDK-style .NET Framework project references without being told. */
const IMPLICIT = new Set(["mscorlib", "system", "system.core", "system.data", "system.drawing", "system.io.compression.filesystem", "system.numerics", "system.runtime.serialization", "system.xml", "system.xml.linq", "netstandard"]);
/** Covered by the Dataverse SDK packages. */
const FROM_SDK_PACKAGES = new Set(["microsoft.xrm.sdk", "microsoft.crm.sdk.proxy", "microsoft.xrm.sdk.workflow", "microsoft.identitymodel"]);

export interface ProjectSetup {
  assembly: string;
  references: AssemblyReference[];
  /** Key file path relative to the project folder. */
  keyFile?: string;
  /** For assemblies that came from a plug-in package: rebuild it as a package. */
  pluginPackage?: { id: string; version: string };
  /** DLLs copied into lib/ (a package's other assemblies). */
  libraries?: string[];
}

/** Names that go into the project file come from the downloaded DLL, so they're checked and escaped. */
const SAFE_NAME = /^[A-Za-z0-9_][\w.-]*$/;
const xmlEscape = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function pluginCsproj(s: ProjectSetup): { xml: string; unresolved: string[] } {
  if (!SAFE_NAME.test(s.assembly)) throw new UserError(`The assembly name "${s.assembly}" can't be used as a project name.`);
  const usesWorkflow = s.references.some((r) => r.name.toLowerCase() === "microsoft.xrm.sdk.workflow");
  const libs = new Set((s.libraries ?? []).map((l) => path.basename(l, ".dll").toLowerCase()));
  const framework: string[] = [];
  const unresolved: string[] = [];
  for (const r of s.references) {
    if (!SAFE_NAME.test(r.name)) {
      unresolved.push(JSON.stringify(r.name));
      continue;
    }
    const lower = r.name.toLowerCase();
    if (IMPLICIT.has(lower) || FROM_SDK_PACKAGES.has(lower) || libs.has(lower)) continue;
    if (lower.startsWith("system.") || lower === "microsoft.csharp" || lower === "presentationcore" || lower === "windowsbase") framework.push(r.name);
    else unresolved.push(r.name);
  }
  const props = [
    "<TargetFramework>net462</TargetFramework>",
    `<AssemblyName>${s.assembly}</AssemblyName>`,
    `<RootNamespace>${s.assembly}</RootNamespace>`,
    "<LangVersion>latest</LangVersion>",
    "<!-- The decompiled Properties/AssemblyInfo.cs already sets the version and other assembly attributes. -->",
    "<GenerateAssemblyInfo>false</GenerateAssemblyInfo>",
    "<GenerateTargetFrameworkAttribute>false</GenerateTargetFrameworkAttribute>",
    "<NoWarn>$(NoWarn);CS0618;CS0612</NoWarn>",
  ];
  if (s.keyFile) props.push("<SignAssembly>true</SignAssembly>", `<AssemblyOriginatorKeyFile>${xmlEscape(s.keyFile.split(path.sep).join("\\"))}</AssemblyOriginatorKeyFile>`);
  if (s.pluginPackage) props.push(`<PackageId>${xmlEscape(s.pluginPackage.id)}</PackageId>`, `<Version>${xmlEscape(s.pluginPackage.version)}</Version>`);
  const packages = [
    '<PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2.*" />',
    ...(usesWorkflow ? ['<PackageReference Include="Microsoft.CrmSdk.Workflow" Version="9.0.2.*" />'] : []),
    ...(s.pluginPackage ? ['<PackageReference Include="Microsoft.PowerApps.MSBuild.Plugin" Version="1.*" PrivateAssets="All" />'] : []),
    '<PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="All" />',
  ];
  const refs = [
    ...framework.map((f) => `<Reference Include="${f}" />`),
    ...(s.libraries ?? []).filter((l) => SAFE_NAME.test(path.basename(l))).map((l) => `<Reference Include="${path.basename(l, ".dll")}">\n      <HintPath>lib\\${path.basename(l)}</HintPath>\n    </Reference>`),
  ];
  const group = (items: string[]) => (items.length ? `  <ItemGroup>\n${items.map((i) => `    ${i}`).join("\n")}\n  </ItemGroup>\n` : "");
  // "--" can't appear inside an XML comment, so a crafted name can't close it early.
  const note = unresolved.length ? `  <!-- Lantern couldn't find these references; add them before building: ${xmlEscape(unresolved.join(", ")).replace(/-{2,}/g, "-")} -->\n` : "";
  const xml = `<Project Sdk="Microsoft.NET.Sdk">\n  <!-- Decompiled from Dataverse by Lantern. Comments and local variable names from the original source aren't recoverable. -->\n  <PropertyGroup>\n${props.map((p) => `    ${p}`).join("\n")}\n  </PropertyGroup>\n${group(packages)}${group(refs)}${note}</Project>\n`;
  return { xml, unresolved };
}

// ---------- comparing ----------

export interface TreeDifference {
  file: string;
  status: "changed" | "onlyDeployed" | "onlyLocal";
}

/** Decompiled source trees compared file by file (project files and line endings ignored). */
export function compareTrees(deployed: string, local: string): TreeDifference[] {
  const relevant = (dir: string) => new Set(listFiles(dir).filter((f) => !/\.(cs|vb)proj$/i.test(f)));
  const a = relevant(deployed);
  const b = relevant(local);
  const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
  const out: TreeDifference[] = [];
  for (const f of a) {
    if (!b.has(f)) out.push({ file: f, status: "onlyDeployed" });
    else if (read(deployed, f) !== read(local, f)) out.push({ file: f, status: "changed" });
  }
  for (const f of b) if (!a.has(f)) out.push({ file: f, status: "onlyLocal" });
  return out.sort((x, y) => x.file.localeCompare(y.file));
}
