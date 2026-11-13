import * as vscode from "vscode";
import { fetchSteps } from "../core/admin";
import { Client } from "../core/clients";
import { MetadataService } from "../core/metadata";
import { changeCount, loadStep, saveStep, STAGE_LABELS, stepChanges, unregisterStep } from "../core/stepEditing";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, resolveClient, withProgress } from "../ui/context";
import { ColumnChoice, openStepPanel } from "../ui/panels/stepPanel";

/**
 * Edit Step and Unregister Step: the Plugin Registration Tool's Update Step as an
 * editor tab (src/ui/panels/stepPanel.ts; nothing is sent until Save), and its
 * Unregister.
 */

type StepArg = { client?: Client; step?: { id: string; name?: string } } | undefined;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortName = (typeName: string) => typeName.split(/[.+]/).pop() ?? typeName;
const env = (c: Client) => c.envName || c.orgHost;

/** The step from a tree node, or picked from the org's custom steps. */
export async function stepFor(arg: unknown): Promise<{ client: Client; id: string } | undefined> {
  const node = arg as StepArg;
  const client = node?.client ?? (await resolveClient(arg));
  if (!client?.config.org) return undefined;
  if (node?.step?.id) return { client, id: node.step.id };
  const steps = await withProgress(`Loading plug-in steps from ${env(client)}`, () => fetchSteps(dataverseFor(client)));
  if (!steps) return undefined;
  if (!steps.length) {
    void vscode.window.showInformationMessage(`No custom plug-in steps are registered in ${env(client)}.`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    steps.map((s) => ({ label: `${s.message}${s.table ? ` of ${s.table}` : ""}`, description: `${shortName(s.typeName)}, ${s.stage}${s.enabled ? "" : ", off"}`, detail: s.name, id: s.id })),
    { placeHolder: "Which step?", matchOnDescription: true, matchOnDetail: true }
  );
  return pick ? { client, id: pick.id } : undefined;
}

/** A table's columns for the panel's checklists: readable, top-level ones, by display name. */
export async function columnChoices(service: MetadataService, table: string): Promise<ColumnChoice[]> {
  if (!table) return [];
  const columns = await service.columns(table);
  return columns
    .filter((c) => !c.attributeOf && c.readable !== false)
    .map((c) => ({ id: c.logicalName, label: c.displayName || c.logicalName, meta: c.logicalName }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Users whose name or sign-in contains the text, for the run-as box. */
export async function userChoices(client: Client, text: string): Promise<Array<{ id: string; label: string; meta?: string }>> {
  const t = text.trim().replace(/'/g, "''");
  if (!t) return [];
  const users = await dataverseFor(client).getAll<{ systemuserid: string; fullname: string; domainname: string; isdisabled: boolean }>(
    `systemusers?$select=systemuserid,fullname,domainname,isdisabled&$filter=${encodeURIComponent(`contains(fullname,'${t}') or contains(domainname,'${t}')`)}&$top=50`
  );
  return users.map((u) => ({ id: u.systemuserid, label: u.fullname, meta: [u.domainname, u.isdisabled ? "disabled" : ""].filter(Boolean).join(", ") }));
}

export async function editStep(arg: unknown, serviceFor: (c: Client) => MetadataService, onChanged: (c: Client) => void): Promise<void> {
  const target = await stepFor(arg);
  if (!target) return;
  const { client } = target;
  const dv = dataverseFor(client);
  const step = await withProgress("Loading the step", () => loadStep(dv, target.id));
  if (!step) return;
  if (step.managed) {
    void vscode.window.showErrorMessage(`${step.draft.name} came from a managed solution, so only turning it on or off works here. Change it in the development environment.`);
    return;
  }
  const service = serviceFor(client);
  const was = JSON.parse(JSON.stringify(step.draft));
  const result = await openStepPanel(
    "Edit Plug-in Step",
    {
      subtitle: `${step.message}${step.table ? ` of ${step.table}` : ""} · ${shortName(step.typeName)} · ${env(client)}`,
      mode: "edit",
      message: step.message,
      table: step.table,
      typeName: step.typeName,
      draft: { step: JSON.parse(JSON.stringify(step.draft)) },
    },
    was,
    { columns: (table) => columnChoices(service, table), users: (text) => userChoices(client, text) }
  );
  if (!result) return;
  const d = result.step;
  d.name = d.name.trim();
  const changes = stepChanges(was, d);
  if (!changeCount(changes)) {
    void vscode.window.showInformationMessage(`Nothing changed on ${d.name}.`);
    return;
  }
  if (!(await confirmProtected(client, `Change the step ${d.name}`))) return;
  const ok = await withProgress(`Saving ${d.name} in ${env(client)}`, async (ctx) => {
    await saveStep(dv, step, changes, undefined, ctx.log);
    return true;
  });
  onChanged(client);
  if (ok) void vscode.window.showInformationMessage(`Saved ${plural(changeCount(changes), "change")} to ${d.name} in ${env(client)}.`);
}

export async function unregisterStepCommand(arg: unknown, onChanged: (c: Client) => void): Promise<void> {
  const target = await stepFor(arg);
  if (!target) return;
  const { client } = target;
  const dv = dataverseFor(client);
  const step = await withProgress("Loading the step", () => loadStep(dv, target.id));
  if (!step) return;
  if (step.managed) {
    void vscode.window.showErrorMessage(`${step.draft.name} came from a managed solution. Remove it by uninstalling or upgrading that solution.`);
    return;
  }
  const go = "Unregister";
  const detail = [
    `${step.message}${step.table ? ` of ${step.table}` : ""}, ${STAGE_LABELS[step.draft.stage] ?? ""}, ${shortName(step.typeName)}.`,
    step.draft.images.length ? `Its ${plural(step.draft.images.length, "image")} go with it.` : "",
    step.secureConfigId ? "Its secure configuration is deleted too." : "",
    "This can't be undone; register the step again to get it back.",
  ].filter(Boolean).join(" ");
  if ((await vscode.window.showWarningMessage(`Unregister the step ${step.draft.name} from ${env(client)}?`, { modal: true, detail }, go)) !== go) return;
  if (!(await confirmProtected(client, `Unregister ${step.draft.name}`))) return;
  const ok = await withProgress(`Unregistering ${step.draft.name}`, async () => {
    await unregisterStep(dv, step);
    return true;
  });
  onChanged(client);
  if (ok) void vscode.window.showInformationMessage(`Unregistered ${step.draft.name} from ${env(client)}.`);
}
