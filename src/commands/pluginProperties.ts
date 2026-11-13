import * as crypto from "crypto";
import * as vscode from "vscode";
import { AssemblyMetadata } from "../core/assembly";
import { Client } from "../core/clients";
import {
  AssemblyDetails, customAssemblies, defaultGroupName, ISOLATION_SANDBOX, PackageInfo, packageUniqueName, RegisteredAssembly,
  RegistrationChanges, registrationProps, saveRegistration, TypeProps, typeProps,
} from "../core/pluginRegistration";
import { forgetOrgPlugins, orgPlugins, projectStatus } from "../core/pluginStatus";
import { PluginProject } from "../core/solutions";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, resolveClient, withProgress } from "../ui/context";
import { forgetRegisteredSteps } from "../ui/editor";
import { openRegistrationPanel, RegistrationDraft, RegistrationType } from "../ui/panels/registrationPanel";

/**
 * The Plugin Registration Tool's property panes as an editor tab (src/ui/panels/
 * registrationPanel.ts): the assembly or package and its classes on the left, the
 * selected one's properties on the right, and nothing is sent until Register or
 * Save. Used when registering something new and to edit what's already registered.
 */

export const REGISTER = "$(check) Register";
export const SAVE = "$(check) Save";
export const BACK = "$(arrow-left) Back";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env = (client: Client) => client.envName || client.orgHost;
const shortName = (typeName: string) => typeName.split(/[.+]/).pop() ?? typeName;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type TypeDraft = RegistrationType;

export interface SheetItem extends vscode.QuickPickItem {
  run?: () => Promise<unknown>;
  accept?: true;
}

/** A quick-pick property sheet: shows the items until one that accepts is picked (true) or the picker is dismissed (false). */
export async function sheet(title: string, placeHolder: string, items: () => SheetItem[]): Promise<boolean> {
  for (;;) {
    const pick = await vscode.window.showQuickPick(items(), { title, placeHolder, ignoreFocusOut: true, matchOnDescription: true });
    if (!pick) return false;
    if (pick.accept) return true;
    await pick.run?.();
  }
}

/** One text property in an input box, with its length and rule checked as you type. */
export async function editText(title: string, value: string, opts: { max: number; required?: string; prompt?: string; validate?: (v: string) => string | undefined }): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({
    title,
    value,
    prompt: opts.prompt,
    ignoreFocusOut: true,
    validateInput: (s: string) => {
      const t = s.trim();
      if (!t && opts.required) return opts.required;
      if (t.length > opts.max) return `Use at most ${opts.max} characters.`;
      return t ? opts.validate?.(t) : undefined;
    },
  });
  return v === undefined ? undefined : v.trim();
}

const trimmed = (d: RegistrationDraft): RegistrationDraft => ({
  ...d,
  description: d.description?.trim(),
  packageName: d.packageName?.trim(),
  pkg: d.pkg ? { name: d.pkg.name.trim(), uniqueName: d.pkg.uniqueName.trim() } : undefined,
  types: d.types.map((t) => ({ ...t, name: t.name.trim(), friendlyName: t.friendlyName.trim(), description: t.description.trim(), workflowGroup: t.workflowGroup.trim() })),
});

// ---------- registering ----------

/** Description, isolation mode, and each class's names before the first registration. Undefined: cancelled. */
export async function askAssemblyDetails(meta: AssemblyMetadata, where: string): Promise<AssemblyDetails | undefined> {
  const draft: RegistrationDraft = {
    description: "",
    isolationMode: ISOLATION_SANDBOX,
    types: meta.pluginClasses.map((c) => ({
      typeName: c.typeName,
      workflow: c.kind === "workflow",
      name: c.typeName,
      friendlyName: "",
      description: "",
      workflowGroup: c.kind === "workflow" ? defaultGroupName(meta.name, meta.version) : "",
    })),
  };
  const result = await openRegistrationPanel("Register Plug-in Assembly", {
    subtitle: `${meta.name} ${meta.version} in ${where}. The defaults are the Plugin Registration Tool's.`,
    mode: "register",
    what: { name: meta.name, version: meta.version, kind: "assembly" },
    draft,
  });
  if (!result) return undefined;
  const d = trimmed(result);
  return {
    description: d.description || undefined,
    isolationMode: d.isolationMode,
    types: Object.fromEntries(d.types.map((t) => [t.typeName, {
      name: t.name,
      friendlyName: t.friendlyName || undefined,
      description: t.description || undefined,
      workflowGroup: t.workflowGroup || undefined,
    }])),
  };
}

/** The new package's name and unique name (which has to start with the publisher's prefix). Undefined: cancelled. */
export async function askPackageDetails(pkg: PackageInfo, prefix: string, where: string): Promise<{ name: string; uniqueName: string } | undefined> {
  const result = await openRegistrationPanel("Register Plug-in Package", {
    subtitle: `${pkg.id} ${pkg.version} in ${where}. Dataverse registers the classes inside the package.`,
    mode: "register",
    what: { name: pkg.id, version: pkg.version, kind: "package" },
    prefix,
    draft: { pkg: { name: pkg.id, uniqueName: packageUniqueName(pkg.id, prefix) }, types: [] },
  });
  return result?.pkg ? trimmed(result).pkg : undefined;
}

// ---------- editing what's registered ----------

function typeDraft(t: TypeProps): TypeDraft {
  return {
    id: t.plugintypeid,
    typeName: t.typename,
    workflow: t.isworkflowactivity,
    name: t.name ?? t.typename,
    friendlyName: t.friendlyname && !GUID.test(t.friendlyname) ? t.friendlyname : "",
    description: t.description ?? "",
    workflowGroup: t.workflowactivitygroupname ?? "",
  };
}

function typePatch(now: TypeDraft, was: TypeDraft): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (now.name !== was.name) p.name = now.name;
  if (now.friendlyName !== was.friendlyName) p.friendlyname = now.friendlyName || crypto.randomUUID();
  if (now.description !== was.description) p.description = now.description || null;
  if (now.workflow && now.workflowGroup !== was.workflowGroup) p.workflowactivitygroupname = now.workflowGroup;
  return p;
}

function changesOf(now: RegistrationDraft, was: RegistrationDraft, ids: { assembly: string; pkg?: string }): RegistrationChanges {
  const assembly: Record<string, unknown> = {};
  if (now.description !== was.description) assembly.description = now.description || null;
  if (now.isolationMode !== undefined && now.isolationMode !== was.isolationMode) assembly.isolationmode = now.isolationMode;
  const pkg: Record<string, unknown> = {};
  if (ids.pkg && now.packageName !== was.packageName) pkg.name = now.packageName;
  return {
    assembly: { id: ids.assembly, patch: assembly },
    pkg: ids.pkg ? { id: ids.pkg, patch: pkg } : undefined,
    types: now.types.map((t, i) => ({ id: t.id!, typeName: t.typeName, patch: typePatch(t, was.types[i]) })),
  };
}

const countChanges = (c: RegistrationChanges) =>
  Object.keys(c.assembly?.patch ?? {}).length + Object.keys(c.pkg?.patch ?? {}).length + c.types.reduce((n, t) => n + Object.keys(t.patch).length, 0);

/**
 * Edit Registration: from an assembly (a project or a registered assembly) its
 * description, isolation mode, package name and every class; from a class, that
 * class's names, description and workflow group.
 */
export async function editRegistration(arg: unknown, onChanged: (client: Client) => void = () => undefined): Promise<void> {
  const node = arg as { client?: Client; plugin?: PluginProject; assembly?: string | RegisteredAssembly; status?: { type?: { plugintypeid: string } } } | undefined;
  const client = node?.client ?? (await resolveClient(arg));
  if (!client) return;
  if (!client.config.org) {
    void vscode.window.showWarningMessage(`Set the org URL for ${client.name} first.`);
    return;
  }
  const dv = dataverseFor(client);
  const where = env(client);

  const typeId = node?.status?.type?.plugintypeid;
  if (typeId) {
    await editType(client, typeId, onChanged);
    return;
  }

  let assemblyId: string | undefined;
  if (node?.assembly && typeof node.assembly === "object") {
    assemblyId = node.assembly.pluginassemblyid;
  } else if (node?.plugin) {
    const plugin = node.plugin;
    const st = await withProgress(`Looking up ${plugin.assembly} in ${where}`, async () => projectStatus(client, plugin, await orgPlugins(client, dv, true)));
    if (!st) return;
    if (!st.registered) {
      void vscode.window.showInformationMessage(`${plugin.assembly} isn't registered in ${where} yet. Build and Push registers it, and lets you name it first.`);
      return;
    }
    assemblyId = st.registered.pluginassemblyid;
  } else {
    const all = await withProgress(`Loading plug-in assemblies from ${where}`, () => customAssemblies(dv));
    if (!all) return;
    const wanted = typeof node?.assembly === "string" ? node.assembly.toLowerCase() : undefined;
    const candidates = wanted ? all.filter((a) => a.name.toLowerCase() === wanted) : all;
    if (!candidates.length) {
      void vscode.window.showInformationMessage(wanted ? `${node?.assembly} isn't registered in ${where}.` : `No custom plug-in assemblies are registered in ${where}.`);
      return;
    }
    const pick = candidates.length === 1
      ? { a: candidates[0] }
      : await vscode.window.showQuickPick(
          candidates.map((a) => ({ label: a.name, description: [a.version, a.ismanaged ? "managed" : "", a.packageName ? `in package ${a.packageName}` : ""].filter(Boolean).join(", "), a })),
          { placeHolder: `Edit which assembly in ${where}?` }
        );
    if (!pick) return;
    assemblyId = pick.a.pluginassemblyid;
  }

  const props = await withProgress(`Loading the registration from ${where}`, () => registrationProps(dv, assemblyId!));
  if (!props) return;
  const { assembly, types, pkg } = props;
  if (assembly.ismanaged || pkg?.ismanaged) {
    void vscode.window.showErrorMessage(`${assembly.name} in ${where} came from a managed solution, so it can't be changed here.`);
    return;
  }
  const draft: RegistrationDraft = {
    description: assembly.description ?? "",
    // In a plug-in package the package decides how the assembly runs, so there's no isolation mode to set.
    isolationMode: pkg ? undefined : assembly.isolationmode,
    packageName: pkg ? pkg.name ?? pkg.uniquename : undefined,
    types: types.filter((t) => !t.ismanaged).map(typeDraft),
  };
  const was: RegistrationDraft = JSON.parse(JSON.stringify(draft));
  const ids = { assembly: assembly.pluginassemblyid, pkg: pkg?.pluginpackageid };
  const result = await openRegistrationPanel(
    "Edit Plug-in Registration",
    {
      subtitle: `${assembly.name} ${assembly.version} in ${where}${pkg ? ` (package ${pkg.uniquename})` : ""}`,
      mode: "edit",
      what: { name: assembly.name, version: assembly.version, kind: "assembly" },
      draft,
    },
    (d) => countChanges(changesOf(trimmed(d), was, ids))
  );
  if (!result) return;
  await save(client, assembly.name, changesOf(trimmed(result), was, ids), onChanged);
}

async function editType(client: Client, typeId: string, onChanged: (client: Client) => void): Promise<void> {
  const dv = dataverseFor(client);
  const where = env(client);
  const type = await withProgress(`Loading the plug-in from ${where}`, () => typeProps(dv, typeId));
  if (!type) return;
  if (type.ismanaged) {
    void vscode.window.showErrorMessage(`${type.typename} in ${where} came from a managed solution, so it can't be changed here.`);
    return;
  }
  const was = typeDraft(type);
  const changes = (d: RegistrationDraft): RegistrationChanges => ({ types: [{ id: type.plugintypeid, typeName: type.typename, patch: typePatch(trimmed(d).types[0], was) }] });
  const result = await openRegistrationPanel(
    "Edit Plug-in Registration",
    {
      subtitle: `${type.typename} in ${where}`,
      mode: "edit",
      what: { name: shortName(type.typename), version: "", kind: "assembly" },
      draft: { types: [{ ...was }] },
    },
    (d) => countChanges(changes(d))
  );
  if (!result) return;
  await save(client, shortName(type.typename), changes(result), onChanged);
}

async function save(client: Client, what: string, changes: RegistrationChanges, onChanged: (client: Client) => void): Promise<void> {
  if (!countChanges(changes)) {
    void vscode.window.showInformationMessage(`Nothing changed on ${what}.`);
    return;
  }
  if (!(await confirmProtected(client, `Change the registration of ${what}`))) return;
  const saved = await withProgress(`Saving ${what} in ${env(client)}`, (ctx) => saveRegistration(dataverseFor(client), changes, ctx.log));
  forgetOrgPlugins(client);
  forgetRegisteredSteps();
  onChanged(client);
  if (saved === undefined) return;
  void vscode.window.showInformationMessage(`Saved ${plural(countChanges(changes), "change")} to ${what} in ${env(client)}.`);
}
