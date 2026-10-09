import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AssemblyMetadata, NotAnAssemblyError, readAssembly } from "../core/assembly";
import { Client, excludeLocally } from "../core/clients";
import { findType, projectSourceFiles } from "../core/csharp";
import { DataverseClient } from "../core/dataverse";
import { compareTrees, decompileProject, findIlspy, installIlspy, pluginCsproj, referenceDirs, TreeDifference } from "../core/decompile";
import { UserError } from "../core/errors";
import { isInside } from "../core/files";
import {
  chooseTarget, customAssemblies, downloadAssembly, OrgAssembly, PackageInfo, planUpdate, pushPackage, PushResult, readPackage, registerAssembly,
  RegisteredAssembly, registeredAssemblies, RegisteredPackage, registeredPackage, RegisteredType, registeredTypes, checkRemovals, RemovalCheck, stepBackup, UpdatePlan, updateAssembly,
} from "../core/pluginRegistration";
import { forgetOrgPlugins, localVersion, projectForAssembly } from "../core/pluginStatus";
import { Cancellation, run } from "../core/process";
import { assemblyNameOf, findBuildOutput, findPluginProjects, PluginProject, pluginIdFor, projectForFile } from "../core/solutions";
import { findKeysWithToken, generateKeyFile, readKeyFile, signingKeyOf, useSigningKey } from "../core/strongname";
import { readZip } from "../core/zip";
import { dataverseFor } from "../ui/auth";
import { clientForPath, confirmProtected, resolveClient, settings, withProgress, workspaceRoots } from "../ui/context";
import { forgetRegisteredSteps } from "../ui/editor";

/**
 * Plug-ins end to end, the way the Plugin Registration Tool works under the
 * hood: build, read the DLL, register or update the assembly through the Web
 * API, and register plug-in types for new classes. Also: get the source of a
 * registered assembly (decompiled), and compare what's deployed with your code.
 */

const env = (client: Client) => client.envName || client.orgHost;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const rel = (client: Client, file: string) => path.relative(client.dir, file) || ".";

type Changed = (client: Client) => void;

// ---------- Build and Push ----------

export async function pushPlugin(arg: unknown, onChanged: Changed = () => undefined): Promise<void> {
  const target = await resolvePluginTarget(arg);
  if (!target) return;
  const { client, projects } = target;
  if (!client.config.org) {
    void vscode.window.showWarningMessage(`Set the org URL for ${client.name} first.`);
    return;
  }
  if (!(await confirmProtected(client, `Push ${projects.length === 1 ? projects[0].assembly : plural(projects.length, "plug-in")}`))) return;

  const summaries: string[] = [];
  const newPlugins: Array<{ assembly: string; typeName: string }> = [];
  try {
    for (const p of projects) {
      const r = await pushProject(client, p);
      if (!r) break;
      summaries.push(r.summary);
      newPlugins.push(...r.newPlugins.map((typeName) => ({ assembly: r.assembly, typeName })));
    }
  } finally {
    forgetOrgPlugins(client);
    forgetRegisteredSteps();
    onChanged(client);
  }
  if (!summaries.length) return;
  const button = newPlugins.length ? "Register Step…" : undefined;
  const choice = await vscode.window.showInformationMessage(summaries.join(" "), ...(button ? [button] : []));
  if (button && choice === button) {
    await vscode.commands.executeCommand("lantern.steps.register", {
      client,
      assembly: newPlugins[0].assembly,
      typeName: newPlugins.length === 1 ? newPlugins[0].typeName : undefined,
    });
  }
}

type Inspected =
  | { kind: "assembly"; content: Buffer; meta: AssemblyMetadata; target?: RegisteredAssembly; types: RegisteredType[]; plan: UpdatePlan }
  | { kind: "package"; content: Buffer; pkg: PackageInfo; existing?: RegisteredPackage };

interface Pushed {
  assembly: string;
  summary: string;
  newPlugins: string[];
}

async function pushProject(client: Client, p: PluginProject): Promise<Pushed | undefined> {
  const dv = dataverseFor(client);
  let ins = await inspect(client, dv, p);
  if (!ins) return undefined;
  if (ins.kind === "package") return pushPackageFlow(client, dv, ins);

  // A new major/minor version is answered first (it decides which registration the key has to match),
  // then a missing or wrong key is fixed by pointing the project at a key and building again.
  let separate = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (separate) ins = { ...ins, target: undefined, types: [], plan: planUpdate(ins.meta, undefined, []) };
    const kinds = ins.plan.blockers.map((b) => b.kind);
    // Problems that only concern the registered copy go away with a separate registration.
    if (!separate && kinds.includes("version") && kinds.every((k) => k === "version" || k === "token" || k === "unsigned" || k === "culture")) {
      const button = "Register as Separate Assembly";
      const choice = await vscode.window.showWarningMessage(
        ins.plan.blockers.find((b) => b.kind === "version")!.message,
        { modal: true, detail: "You can register this build next to the old one (the old one keeps its steps), or change the version back so it updates in place." },
        button
      );
      if (choice !== button) return undefined;
      separate = true;
      continue;
    }
    const fix = await fixSigning(client, p, ins);
    if (fix === "stop") return undefined;
    if (fix === "ok") break;
    const rebuilt = await inspect(client, dv, p);
    if (!rebuilt) return undefined;
    if (rebuilt.kind === "package") return pushPackageFlow(client, dv, rebuilt);
    ins = rebuilt;
  }
  if (separate) ins = { ...ins, target: undefined, types: [], plan: planUpdate(ins.meta, undefined, []) };
  const { meta, content, target, plan } = ins;
  if (plan.blockers.length) {
    void vscode.window.showErrorMessage(plan.blockers.map((b) => b.message).join(" "));
    return undefined;
  }

  if (!target) {
    const solution = await pickSolution(client, `${meta.name} ${meta.version}`);
    if (solution === undefined) return undefined;
    const result = await withProgress(`Registering ${meta.name} in ${env(client)}`, (ctx) => registerAssembly(dv, meta, content, { solution: solution || undefined, log: ctx.log }));
    if (!result) return undefined;
    client.config.plugins[meta.name] = result.assemblyId;
    client.save();
    return {
      assembly: meta.name,
      summary: `Registered ${meta.name} ${meta.version} in ${env(client)} with ${plural(result.newTypes.length, "class", "classes")}${solution ? ` (in ${solution})` : ""}.`,
      newPlugins: pluginTypes(result),
    };
  }

  let removals: RemovalCheck[] = [];
  let backupNote = "";
  if (plan.missing.length) {
    const checks = await withProgress("Checking what depends on the removed classes", () => checkRemovals(dv, plan.missing));
    if (!checks) return undefined;
    const one = plan.missing.length === 1;
    const lead = `${meta.name}.dll no longer has ${one ? "a class that's" : `${plan.missing.length} classes that are`} registered in ${env(client)}. Dataverse won't take the update until ${one ? "it's" : "they're"} unregistered.`;
    const blocked = checks.filter((c) => c.problems.length);
    if (blocked.length) {
      void vscode.window.showErrorMessage(
        `${lead} Lantern won't unregister ${blocked.map((c) => `${c.type.typename}: ${c.problems.join("; ")}`).join(". ")}. Nothing was changed. Put the class back, or unregister it in the Plugin Registration Tool once nothing depends on it.`
      );
      return undefined;
    }
    const total = checks.reduce((n, c) => n + c.steps.length, 0);
    const list = checks.map((c) => `${c.type.typename}${c.steps.length ? `: ${c.steps.map((st) => st.name).join(", ")}` : " (no steps)"}`);
    const secured = checks.flatMap((c) => c.steps.filter((st) => st.secureConfigId).map((st) => st.name));
    const notes = [
      total ? "The steps and their images are saved to a file in .pull-backup first." : "",
      secured.length ? `Secure configurations aren't saved (they often hold credentials) and are removed with their steps: ${secured.join(", ")}.` : "",
    ].filter(Boolean);
    const button = `Unregister ${one ? "It" : "Them"}${total ? ` and ${plural(total, "Step")}` : ""}`;
    const choice = await vscode.window.showWarningMessage(
      lead,
      { modal: true, detail: [list.join("\n"), ...notes].join("\n\n") },
      button
    );
    if (choice !== button) return undefined;
    if (total) {
      const backup = await withProgress("Saving the steps", () => stepBackup(dv, checks));
      if (!backup) return undefined;
      const dir = path.join(client.dir, ".pull-backup");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `unregistered-steps-${meta.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      fs.writeFileSync(file, JSON.stringify({ environment: client.config.org, assembly: meta.name, steps: backup }, null, 2));
      excludeLocally(client.dir);
      backupNote = ` The steps were saved to ${rel(client, file)}.`;
    }
    removals = checks;
  }

  const registered = target;
  const result = await withProgress(`Pushing ${meta.name} ${meta.version} to ${env(client)}`, async (ctx) => {
    try {
      return await updateAssembly(dv, meta, content, registered, plan, { removals, log: ctx.log });
    } catch (err) {
      // After deletes have started, the backup is what the user needs: name it in the error.
      if (!backupNote) throw err;
      throw new UserError(`${err instanceof Error ? err.message : String(err)}${backupNote}`);
    }
  });
  if (!result) return undefined;
  const parts = [`Pushed ${meta.name} ${meta.version} to ${env(client)}.`];
  if (result.newTypes.length) parts.push(`Registered ${result.newTypes.map((t) => shortName(t.typeName)).join(", ")}.`);
  if (result.removedTypes.length) {
    parts.push(`Unregistered ${result.removedTypes.map(shortName).join(", ")}${result.removedSteps ? ` and ${plural(result.removedSteps, "step")}` : ""}.${backupNote}`);
  }
  return { assembly: meta.name, summary: parts.join(" "), newPlugins: pluginTypes(result) };
}

const shortName = (typeName: string) => typeName.split(/[.+]/).pop() ?? typeName;
const pluginTypes = (r: PushResult) => r.newTypes.filter((t) => t.kind === "plugin").map((t) => t.typeName);

async function build(ctx: { log: (t: string) => void; token?: Cancellation }, client: Client, p: PluginProject, configuration: string): Promise<void> {
  ctx.log(`> dotnet build ${rel(client, p.project)} -c ${configuration}\n`);
  const r = await run(settings().dotnetPath, ["build", p.project, "-c", configuration], { onOutput: ctx.log, token: ctx.token });
  if (r.missing) throw new UserError("The .NET SDK (dotnet) isn't installed or isn't on your PATH.");
  if (r.code !== 0) throw new UserError(`Build failed for ${p.assembly}. See the Lantern output for the compiler errors.`);
}

async function inspect(client: Client, dv: DataverseClient, p: PluginProject): Promise<Inspected | undefined> {
  const configuration = settings().buildConfiguration;
  return withProgress(`Building ${p.assembly}`, async (ctx, progress) => {
    progress.report({ message: `dotnet build (${configuration})...` });
    await build(ctx, client, p, configuration);
    const output = findBuildOutput(p, configuration);
    if (!output) throw new UserError(`Couldn't find the built ${p.assembly}.dll or .nupkg under bin/${configuration}.`);
    const content = fs.readFileSync(output.file);
    progress.report({ message: `checking ${env(client)}...` });
    if (output.type === "Nuget") {
      const pkg = readPackage(content);
      return { kind: "package", content, pkg, existing: await registeredPackage(dv, pkg, pluginIdFor(client, pkg.id) ?? pluginIdFor(client, p.assembly)) };
    }
    let meta: AssemblyMetadata;
    try {
      meta = readAssembly(content);
    } catch (err) {
      if (err instanceof NotAnAssemblyError) throw new UserError(`${path.basename(output.file)} can't be read: ${err.message}`);
      throw err;
    }
    ctx.log(`${meta.name} ${meta.version}, ${meta.publicKeyToken ? `public key token ${meta.publicKeyToken}` : "not signed"}: ${meta.pluginClasses.map((c) => c.typeName).join(", ") || "no plug-in classes"}\n`);
    const target = chooseTarget(meta, await registeredAssemblies(dv, meta.name, pluginIdFor(client, meta.name)));
    const types = target ? await registeredTypes(dv, target.pluginassemblyid) : [];
    return { kind: "assembly", content, meta, target, types, plan: planUpdate(meta, target, types) };
  });
}

async function pushPackageFlow(client: Client, dv: DataverseClient, ins: Extract<Inspected, { kind: "package" }>): Promise<Pushed | undefined> {
  const { pkg, existing, content } = ins;
  if (existing?.ismanaged) {
    void vscode.window.showErrorMessage(`The ${pkg.id} package in ${env(client)} came from a managed solution, so it can't be updated here.`);
    return undefined;
  }
  let solution: string | undefined;
  if (!existing) {
    solution = await pickSolution(client, `package ${pkg.id} ${pkg.version}`);
    if (solution === undefined) return undefined;
  }
  const result = await withProgress(`${existing ? "Pushing" : "Registering"} ${pkg.id} ${pkg.version}`, () => pushPackage(dv, pkg, content, existing, { solution: solution || undefined }));
  if (!result) return undefined;
  if (result.created) {
    client.config.plugins[pkg.id] = result.id;
    client.save();
  }
  return {
    assembly: pkg.id,
    summary: `${result.created ? "Registered" : "Pushed"} plug-in package ${pkg.id} ${pkg.version} ${result.created ? "in" : "to"} ${env(client)}. Dataverse registers the classes inside it.`,
    newPlugins: [],
  };
}

async function pickSolution(client: Client, what: string): Promise<string | undefined> {
  const items = [
    ...client.config.solutions.map((s) => ({ label: s, description: "add it to this solution", solution: s })),
    { label: "Don't add to a solution", description: "", solution: "" },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Register ${what} in ${env(client)}. Add it to which solution?` });
  return pick?.solution;
}

/** "ok" when signing is fine, "rebuild" after pointing the project at a key, "stop" to give up. */
async function fixSigning(client: Client, p: PluginProject, ins: Extract<Inspected, { kind: "assembly" }>): Promise<"ok" | "rebuild" | "stop"> {
  const blocker = ins.plan.blockers.find((b) => b.kind === "unsigned" || b.kind === "token");
  if (!blocker) return "ok";
  const wanted = ins.target?.publickeytoken?.toLowerCase() || undefined;
  // Registered unsigned but this build is signed: that's a project setting to undo, not a key to find.
  if (blocker.kind === "token" && !wanted) return "ok";
  if (wanted) {
    const current = signingKeyOf(p.project);
    const found = findKeysWithToken([client.dir, ...workspaceRoots()], wanted).filter((f) => f !== current);
    const detail = found.length
      ? `Found a key file with the registered assembly's public key token (${wanted}): ${rel(client, found[0])}`
      : `Lantern looked for a .snk with public key token ${wanted} in your folders and didn't find one. Dataverse doesn't keep the key, and the DLL only has the public half. If nobody has it, change the first or second part of the version and push again to register this build as a separate assembly.`;
    const choice = await vscode.window.showWarningMessage(blocker.message, { modal: true, detail }, ...(found.length ? ["Use Original Key", "Choose Key File…"] : ["Choose Key File…"]));
    if (choice === "Use Original Key") {
      useSigningKey(p.project, found[0]);
      return "rebuild";
    }
    if (choice === "Choose Key File…") {
      const key = await pickKeyFile(wanted);
      if (!key) return "stop";
      useSigningKey(p.project, keepWithProject(client, key, path.dirname(p.project)));
      return "rebuild";
    }
    return "stop";
  }
  const choice = await vscode.window.showWarningMessage(
    blocker.message,
    { modal: true, detail: "Lantern can create a key file next to the project and turn on signing. Commit the .snk with the project: every later update has to be signed with the same key." },
    "Create Signing Key",
    "Choose Key File…"
  );
  if (choice === "Create Signing Key") {
    const keyFile = path.join(path.dirname(p.project), `${p.assembly}.snk`);
    if (fs.existsSync(keyFile)) {
      let usable = false;
      try {
        usable = readKeyFile(fs.readFileSync(keyFile)).hasPrivateKey;
      } catch {
        // not a key
      }
      if (!usable) throw new UserError(`${rel(client, keyFile)} already exists and isn't a key pair. Move it out of the way and try again.`);
    } else {
      fs.writeFileSync(keyFile, generateKeyFile());
    }
    useSigningKey(p.project, keyFile);
    return "rebuild";
  }
  if (choice === "Choose Key File…") {
    const key = await pickKeyFile();
    if (!key) return "stop";
    useSigningKey(p.project, keepWithProject(client, key, path.dirname(p.project)));
    return "rebuild";
  }
  return "stop";
}

/** A .snk the user picks, checked: a full key pair, and the wanted token if there is one. */
async function pickKeyFile(wantedToken?: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "Strong-name key": ["snk"] }, openLabel: "Use Key" });
  const file = picked?.[0]?.fsPath;
  if (!file) return undefined;
  let key;
  try {
    key = readKeyFile(fs.readFileSync(file));
  } catch {
    void vscode.window.showErrorMessage(`${path.basename(file)} isn't a strong-name key file.`);
    return undefined;
  }
  if (!key.hasPrivateKey) {
    void vscode.window.showErrorMessage(`${path.basename(file)} only has the public key. Signing needs the key pair (the file "sn -k" makes).`);
    return undefined;
  }
  if (wantedToken && key.token !== wantedToken) {
    void vscode.window.showErrorMessage(`${path.basename(file)} has public key token ${key.token}, but the registered assembly was signed with ${wantedToken}.`);
    return undefined;
  }
  return file;
}

/**
 * Keys outside the client folder are copied next to the project, so the project
 * builds for everyone. A different file with the same name is never overwritten
 * or reused; the copy gets a new name.
 */
function keepWithProject(client: Client, key: string, projectDir: string): string {
  if (isInside(key, client.dir)) return key;
  const bytes = fs.readFileSync(key);
  const ext = path.extname(key);
  const base = path.basename(key, ext);
  fs.mkdirSync(projectDir, { recursive: true });
  for (let n = 0; ; n++) {
    const copy = path.join(projectDir, `${base}${n ? `-${n}` : ""}${ext}`);
    if (fs.existsSync(copy)) {
      if (fs.readFileSync(copy).equals(bytes)) return copy;
      continue;
    }
    fs.writeFileSync(copy, bytes);
    void vscode.window.showInformationMessage(
      `Copied ${path.basename(key)} to ${rel(client, copy)} so the project builds for everyone. It's a private key: commit it only if your team keeps signing keys in the repo.`
    );
    return copy;
  }
}

/** A plug-in node, a .csproj or .cs file, or a client (then pick its projects). */
export async function resolvePluginTarget(arg: unknown, single = false): Promise<{ client: Client; projects: PluginProject[] } | undefined> {
  const node = arg as { plugin?: PluginProject; client?: Client; fsPath?: string } | undefined;
  if (node?.plugin && node.client) return { client: node.client, projects: [node.plugin] };

  // From a tree node (a client or the Plug-ins group), pick from that client's projects, not the open file's.
  const file = node?.fsPath ?? (node?.client ? undefined : vscode.window.activeTextEditor?.document.uri.fsPath);
  if (file && /\.(csproj|cs)$/i.test(file)) {
    const client = clientForPath(file);
    const project = file.toLowerCase().endsWith(".csproj") ? file : client ? projectForFile(file, client.dir) : undefined;
    if (client && project) return { client, projects: [{ project, assembly: assemblyNameOf(project) }] };
  }

  const client = await resolveClient(arg);
  if (!client) return undefined;
  const all = findPluginProjects(client.dir);
  if (!all.length) {
    void vscode.window.showWarningMessage(`No plug-in projects (.csproj referencing the Dataverse SDK) found in ${client.name}.`);
    return undefined;
  }
  if (all.length === 1) return { client, projects: all };
  const items = all.map((p) => ({ label: p.assembly, description: rel(client, path.dirname(p.project)), picked: !single, p }));
  if (single) {
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Which plug-in project?" });
    return pick ? { client, projects: [pick.p] } : undefined;
  }
  const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: "Which plug-in projects?" });
  if (!picks?.length) return undefined;
  return { client, projects: picks.map((x: { p: PluginProject }) => x.p) };
}

// ---------- ILSpy ----------

async function ensureIlspy(): Promise<string | undefined> {
  const found = await findIlspy(settings().ilspyPath);
  if (found) return found;
  const button = "Install ILSpy";
  const choice = await vscode.window.showInformationMessage(
    "Decompiling uses ILSpy's command-line tool (ilspycmd, MIT licensed), which isn't installed. Lantern can install it with: dotnet tool install --global ilspycmd",
    button
  );
  if (choice !== button) return undefined;
  return withProgress("Installing ilspycmd", async (ctx) => {
    const installed = await installIlspy(settings().dotnetPath, ctx.log, ctx.token);
    if (!installed) throw new UserError("ilspycmd was installed, but Lantern can't run it yet. Restart VS Code, or set lantern.ilspyPath to the ilspycmd in your .dotnet/tools folder.");
    return installed;
  });
}

// ---------- Get Source ----------

export async function getPluginSource(arg: unknown, onChanged: Changed = () => undefined): Promise<void> {
  const node = arg as { client?: Client; assembly?: string | OrgAssembly } | undefined;
  const client = node?.client ?? (await resolveClient(arg));
  if (!client?.config.org) return;
  const dv = dataverseFor(client);
  const all = await withProgress(`Loading plug-in assemblies from ${env(client)}`, () => customAssemblies(dv));
  if (!all) return;
  if (!all.length) {
    void vscode.window.showInformationMessage(`No custom plug-in assemblies are registered in ${env(client)}.`);
    return;
  }
  const projects = findPluginProjects(client.dir);
  const wantedName = typeof node?.assembly === "string" ? node.assembly : node?.assembly?.name;
  const candidates = wantedName ? all.filter((a) => a.name.toLowerCase() === wantedName.toLowerCase()) : all;
  if (!candidates.length) {
    void vscode.window.showWarningMessage(`${wantedName} isn't registered in ${env(client)}.`);
    return;
  }
  const chosen = candidates.length === 1
    ? candidates[0]
    : (await vscode.window.showQuickPick(
        candidates.map((a) => {
          const local = projectForAssembly(projects, a.name);
          return {
            label: a.name,
            description: [a.version, a.ismanaged ? "managed" : "", a.packageName ? `in package ${a.packageName}` : ""].filter(Boolean).join(", "),
            detail: local ? `Already in your folder: ${rel(client, path.dirname(local.project))}` : undefined,
            a,
          };
        }),
        { placeHolder: `Which assembly from ${env(client)}?` }
      ))?.a;
  if (!chosen) return;

  // Already in the repo: that project is the source. Compare instead of making a second copy.
  const local = projectForAssembly(projects, chosen.name);
  if (local) {
    const compare = "Compare Deployed with Local";
    const choice = await vscode.window.showInformationMessage(
      `${chosen.name} is already in your folder at ${rel(client, path.dirname(local.project))}. Lantern won't make a second copy.`,
      compare,
      "Open Project"
    );
    if (choice === compare) await compareDeployed({ client, plugin: local });
    else if (choice === "Open Project") await vscode.window.showTextDocument(vscode.Uri.file(local.project));
    return;
  }

  if (chosen.ismanaged) {
    const go = "Decompile Anyway";
    const choice = await vscode.window.showWarningMessage(
      `${chosen.name} came from a managed solution. If it's a vendor's product, its license may not allow decompiling it.`,
      { modal: true },
      go
    );
    if (choice !== go) return;
  }

  const base = projects.length ? path.dirname(path.dirname(projects[0].project)) : path.join(client.dir, "Plugins");
  const suggestion = path.relative(client.dir, path.join(base, chosen.name));
  const folder = await vscode.window.showInputBox({
    title: `Where should the source of ${chosen.name} go?`,
    prompt: `Folder relative to ${client.name}/. It becomes the plug-in project for ${chosen.name}.`,
    value: suggestion,
    ignoreFocusOut: true,
    validateInput: (v: string) => {
      if (!v.trim()) return "Enter a folder.";
      const full = path.resolve(client.dir, v.trim());
      if (!isInside(full, client.dir)) return `Pick a folder inside ${client.name}.`;
      if (fs.existsSync(full) && fs.readdirSync(full).length) return "That folder isn't empty.";
      // Inside another project, that project's build would pick up the decompiled classes too.
      for (let dir = path.dirname(full); isInside(dir, client.dir); dir = path.dirname(dir)) {
        const project = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => /\.(cs|vb)proj$/i.test(n)) : undefined;
        if (project) return `That's inside the ${project} project. Pick a folder outside it.`;
        if (dir === client.dir) break;
      }
      return undefined;
    },
  });
  if (!folder) return;
  const target = path.resolve(client.dir, folder.trim());

  const token = chosen.publickeytoken?.toLowerCase() || undefined;
  let keyFile = token ? findKeysWithToken([client.dir, ...workspaceRoots()], token)[0] : undefined;
  if (token && !keyFile && !chosen._packageid_value) {
    const pick = "Choose Key File…";
    const choice = await vscode.window.showWarningMessage(
      `The signing key for ${chosen.name} (public key token ${token}) isn't in your folders, and Dataverse doesn't keep it.`,
      { modal: true, detail: "Without the original .snk, a rebuilt DLL can't update the registered assembly in place. Choose it if someone on the team has it, or continue and add it later (Build and Push will ask for it)." },
      pick,
      "Continue Without Key"
    );
    if (!choice) return;
    if (choice === pick) {
      keyFile = await pickKeyFile(token);
      if (!keyFile) return;
    }
  }

  const ilspy = await ensureIlspy();
  if (!ilspy) return;

  const done = await withProgress(`Getting the source of ${chosen.name} from ${env(client)}`, async (ctx, progress) => {
    progress.report({ message: "downloading..." });
    const { dll, dependencies } = await downloadAssembly(dv, chosen);
    const meta = readAssembly(dll);
    // The name becomes file and project names; it comes from the org, so it's checked first.
    if (!/^[A-Za-z0-9_][\w.-]*$/.test(meta.name)) throw new UserError(`The assembly name "${meta.name}" can't be used as a file name.`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-src-"));
    try {
      const dllPath = path.join(work, `${meta.name}.dll`);
      fs.writeFileSync(dllPath, dll);
      const deps = path.join(work, "deps");
      fs.mkdirSync(deps);
      for (const d of dependencies) fs.writeFileSync(path.join(deps, d.name), d.data);
      progress.report({ message: "decompiling..." });
      await decompileProject(ilspy, dllPath, target, { references: [...referenceDirs(), ...(dependencies.length ? [deps] : [])], log: ctx.log, token: ctx.token });
      if (dependencies.length) {
        fs.mkdirSync(path.join(target, "lib"), { recursive: true });
        for (const d of dependencies) fs.writeFileSync(path.join(target, "lib", d.name), d.data);
      }
      const key = keyFile ? keepWithProject(client, keyFile, target) : undefined;
      const pkg = chosen._packageid_value ? await packageInfo(dv, chosen._packageid_value) : undefined;
      const { xml, unresolved } = pluginCsproj({
        assembly: meta.name,
        references: meta.references,
        keyFile: key ? path.relative(target, key) : undefined,
        pluginPackage: pkg,
        libraries: dependencies.map((d) => d.name),
      });
      const csproj = path.join(target, `${meta.name}.csproj`);
      fs.writeFileSync(csproj, xml);
      if (pkg) client.config.plugins[pkg.id] = chosen._packageid_value!;
      else client.config.plugins[meta.name] = chosen.pluginassemblyid;
      client.save();
      return { meta, csproj, unresolved, signed: !!key, pkg };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
  if (!done) return;
  forgetOrgPlugins(client);
  onChanged(client);

  const first = done.meta.pluginClasses[0];
  const decl = first ? findType(first.typeName, projectSourceFiles(done.csproj)) : undefined;
  if (decl) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(decl.file));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(decl.line, decl.column, decl.line, decl.column + shortName(decl.name).length), preview: false });
  }
  const notes = [
    `Decompiled ${done.meta.name} ${done.meta.version} into ${rel(client, target)} (${plural(done.meta.pluginClasses.length, "plug-in class", "plug-in classes")}). Comments and local variable names from the original aren't recoverable.`,
    done.pkg
      ? `It builds as the ${done.pkg.id} plug-in package.`
      : done.signed
        ? "It's signed with the original key, so Build and Push updates the registered assembly in place."
        : token
          ? "It has no signing key yet; Build and Push will ask for the original .snk."
          : "",
    done.unresolved.length ? `Add these references before building: ${done.unresolved.join(", ")}.` : "",
  ];
  void vscode.window.showInformationMessage(notes.filter(Boolean).join(" "));
}

async function packageInfo(dv: DataverseClient, id: string): Promise<{ id: string; version: string }> {
  const row = await dv.getJson<{ uniquename: string; version: string }>(`pluginpackages(${id})?$select=uniquename,version`);
  return { id: row.uniquename, version: row.version };
}

// ---------- Compare deployed with local ----------

export async function compareDeployed(arg: unknown): Promise<void> {
  const node = arg as { client?: Client; plugin?: PluginProject; typeName?: string } | undefined;
  const target = await resolvePluginTarget(arg, true);
  if (!target) return;
  const { client } = target;
  const p = target.projects[0];
  if (!client.config.org) return;
  const ilspy = await ensureIlspy();
  if (!ilspy) return;
  const dv = dataverseFor(client);
  const configuration = settings().buildConfiguration;

  const result = await withProgress(`Comparing ${p.assembly} in ${env(client)} with your code`, async (ctx, progress) => {
    const registered = await registeredAssemblies(dv, p.assembly, pluginIdFor(client, p.assembly));
    const version = localVersion(p.project);
    const sameLine = (a: RegisteredAssembly) => a.version.split(".").slice(0, 2).join(".") === version.split(".").slice(0, 2).join(".");
    const deployedRow = registered.byId ?? registered.byName.find(sameLine) ?? registered.byName[0];
    if (!deployedRow) throw new UserError(`${p.assembly} isn't registered in ${env(client)}.`);
    progress.report({ message: "building yours..." });
    await build(ctx, client, p, configuration);
    const output = findBuildOutput(p, configuration);
    if (!output) throw new UserError(`Couldn't find the built ${p.assembly} under bin/${configuration}.`);
    const localDll = output.type === "Nuget" ? dllFromPackage(fs.readFileSync(output.file), p.assembly) : fs.readFileSync(output.file);
    progress.report({ message: "downloading the deployed one..." });
    const deployed = await downloadAssembly(dv, { ...deployedRow });
    const dir = path.join(os.tmpdir(), "lantern-compare", `${client.name}-${p.assembly}`.replace(/[^\w.-]/g, "_"));
    fs.rmSync(dir, { recursive: true, force: true });
    const deployedDir = path.join(dir, env(client).replace(/[^\w.-]/g, "_"));
    const localDir = path.join(dir, "your build");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deployed.dll"), deployed.dll);
    fs.writeFileSync(path.join(dir, "local.dll"), localDll);
    progress.report({ message: "decompiling both..." });
    const references = referenceDirs();
    await decompileProject(ilspy, path.join(dir, "deployed.dll"), deployedDir, { references, log: ctx.log, token: ctx.token });
    await decompileProject(ilspy, path.join(dir, "local.dll"), localDir, { references, log: ctx.log, token: ctx.token });
    return {
      differences: compareTrees(deployedDir, localDir),
      deployedDir,
      localDir,
      deployedVersion: readAssembly(deployed.dll).version,
      localVersion: readAssembly(localDll).version,
    };
  });
  if (!result) return;
  const { differences, deployedDir, localDir } = result;
  const versions = result.deployedVersion === result.localVersion ? `version ${result.localVersion}` : `${env(client)} has ${result.deployedVersion}, your build is ${result.localVersion}`;
  const code = differences.filter((d) => !/AssemblyInfo\.cs$/i.test(d.file));
  if (!code.length) {
    void vscode.window.showInformationMessage(`${env(client)} is running the same ${p.assembly} code as your build (${versions}). Both sides were decompiled, so comments and formatting aren't part of the comparison.`);
    return;
  }
  const open = (d: TreeDifference) => {
    const left = vscode.Uri.file(path.join(deployedDir, d.file));
    const right = vscode.Uri.file(path.join(localDir, d.file));
    if (d.status === "changed") return vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(d.file)}: ${env(client)} ↔ your build`);
    return vscode.window.showTextDocument(d.status === "onlyDeployed" ? left : right, { preview: true });
  };
  // From a class: go straight to its file when it changed.
  const short = node?.typeName ? shortName(node.typeName) : undefined;
  const forClass = short ? code.find((d) => path.basename(d.file, ".cs") === short) : undefined;
  if (forClass) {
    await open(forClass);
    return;
  }
  const label = { changed: "changed", onlyDeployed: `only in ${env(client)}`, onlyLocal: "only in your build" };
  const pick = await vscode.window.showQuickPick(
    code.map((d) => ({ label: d.file.split(path.sep).join("/"), description: label[d.status], d })),
    { placeHolder: `${plural(code.length, "file")} differ (${versions}). Pick one to see the difference.` }
  );
  if (pick) await open(pick.d);
}

function dllFromPackage(nupkg: Buffer, assembly: string): Buffer {
  const entry = readZip(nupkg).find((e) => e.name.toLowerCase().endsWith(`/${assembly.toLowerCase()}.dll`));
  if (!entry) throw new UserError(`${assembly}.dll isn't in the built package.`);
  return entry.data;
}
