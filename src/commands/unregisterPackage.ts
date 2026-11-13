import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { UserError } from "../core/errors";
import { checkRemovals, listPackages, packageContents, RegisteredAssembly, registeredAssemblies, RegisteredPackage, stepBackup, unregisterPackage } from "../core/pluginRegistration";
import { PluginProject, pluginIdFor } from "../core/solutions";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, resolveClient, withProgress } from "../ui/context";
import { writeStepBackup } from "./plugins";

/**
 * Unregister Plug-in Package: the Plugin Registration Tool's Unregister on a package. The
 * steps on the package's types go first (Dataverse requires it), then the package, which
 * takes its assemblies and types with it. Like Build and Push's removals, anything else that
 * depends on the types stops it before anything is deleted, and the steps are saved to
 * .pull-backup first. Nothing in the code changes.
 */

const env = (c: Client) => c.envName || c.orgHost;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: string[], max = 6) => items.slice(0, max).join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");

type PackageArg = { client?: Client; assembly?: string | RegisteredAssembly; plugin?: PluginProject } | undefined;

/** The package of the row that was clicked: a registered assembly in a package, or a project whose registered assembly is in one. */
async function packageOfRow(client: Client, node: PackageArg, packages: RegisteredPackage[]): Promise<RegisteredPackage | undefined> {
  const byId = (id: string | null | undefined) => (id ? packages.find((p) => p.pluginpackageid.toLowerCase() === id.toLowerCase()) : undefined);
  if (node?.assembly && typeof node.assembly !== "string") return byId(node.assembly._packageid_value);
  const name = typeof node?.assembly === "string" ? node.assembly : node?.plugin?.assembly;
  if (!name) return undefined;
  const registered = await registeredAssemblies(dataverseFor(client), name, pluginIdFor(client, name));
  return byId([registered.byId, ...registered.byName].find((a) => a?._packageid_value)?._packageid_value);
}

export async function unregisterPackageCommand(arg: unknown, onChanged: () => void): Promise<void> {
  const node = arg as PackageArg;
  const client = node?.client ?? (await resolveClient(arg));
  if (!client?.config.org) return;
  const dv = dataverseFor(client);
  const packages = await withProgress(`Loading plug-in packages from ${env(client)}`, () => listPackages(dv));
  if (!packages) return;
  let pkg = await packageOfRow(client, node, packages);
  if (!pkg) {
    if (!packages.length) {
      void vscode.window.showInformationMessage(`No unmanaged plug-in packages are registered in ${env(client)}.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      packages.map((p) => ({ label: p.name || p.uniquename, description: [p.version, p.name && p.name !== p.uniquename ? p.uniquename : ""].filter(Boolean).join(" · "), pkg: p })),
      { title: `Unregister which plug-in package from ${env(client)}?`, matchOnDescription: true }
    );
    if (!pick) return;
    pkg = pick.pkg;
  }
  const chosen = pkg;
  const contents = await withProgress(`Checking what ${chosen.uniquename} contains`, async () => {
    const found = await packageContents(dv, chosen);
    return { ...found, checks: await checkRemovals(dv, found.types) };
  });
  if (!contents) return;
  // The steps are deleted before the package, so whatever would make Dataverse refuse the package has to stop it now.
  const blocked = contents.checks.filter((c) => c.problems.length);
  if (blocked.length) {
    void vscode.window.showErrorMessage(
      `Lantern won't unregister ${chosen.uniquename} from ${env(client)}: ${blocked.map((c) => `${c.type.typename}: ${c.problems.join("; ")}`).join(". ")}. Nothing was changed. Unregister it once nothing else depends on its plug-ins.`
    );
    return;
  }
  if (!(await confirmProtected(client, `unregister the plug-in package ${chosen.uniquename}`))) return;

  const secured = contents.steps.filter((s) => s.secureConfigId).map((s) => s.name);
  const detail = [
    contents.assemblies.length ? `${plural(contents.assemblies.length, "assembly", "assemblies")}: ${list(contents.assemblies.map((a) => a.name))}` : "No assemblies",
    plural(contents.types.length, "plug-in type"),
    contents.steps.length ? `${plural(contents.steps.length, "step")}: ${list(contents.steps.map((s) => s.name))}` : "No steps",
    "The steps are unregistered first (with their images and secure configurations), then the package; Dataverse removes the assemblies and plug-in types with it. Your code doesn't change.",
    contents.steps.length ? "The steps and their images are saved to a file in .pull-backup first." : "",
    secured.length ? `Secure configurations aren't saved (they often hold credentials): ${list(secured)}.` : "",
  ].filter(Boolean).join("\n");
  const go = "Unregister";
  const choice = await vscode.window.showWarningMessage(`Unregister plug-in package ${chosen.name || chosen.uniquename} ${chosen.version} from ${env(client)}?`, { modal: true, detail }, go);
  if (choice !== go) return;

  let backupNote = "";
  if (contents.steps.length) {
    const backup = await withProgress("Saving the steps", () => stepBackup(dv, contents.checks));
    if (!backup) return;
    const file = writeStepBackup(client, chosen.uniquename, { package: chosen.uniquename }, backup);
    backupNote = ` The steps were saved to ${path.relative(client.dir, file)}.`;
  }
  const done = await withProgress(`Unregistering ${chosen.uniquename} from ${env(client)}`, async (ctx) => {
    try {
      await unregisterPackage(dv, contents, ctx.log);
    } catch (err) {
      // After deletes have started, the backup is what the user needs: name it in the error.
      if (!backupNote) throw err;
      throw new UserError(`${err instanceof Error ? err.message : String(err)}${backupNote}`);
    }
    return true;
  });
  if (!done) return;
  // A push that created this package remembered its ID; a later push would look for it.
  for (const [key, id] of Object.entries(client.config.plugins)) if (id.toLowerCase() === chosen.pluginpackageid.toLowerCase()) delete client.config.plugins[key];
  client.save();
  onChanged();
  void vscode.window.showInformationMessage(
    `Unregistered ${chosen.uniquename} from ${env(client)}${contents.assemblies.length ? ` with ${list(contents.assemblies.map((a) => a.name))}` : ""}${contents.steps.length ? ` and ${plural(contents.steps.length, "step")}` : ""}.${backupNote}`
  );
}
