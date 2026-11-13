import * as vscode from "vscode";
import { Client } from "../core/clients";
import { MetadataService } from "../core/metadata";
import { imageMessageProperty } from "../core/stepEditing";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, reportError, resolveClient, withProgress } from "../ui/context";
import { forgetRegisteredSteps } from "../ui/editor";
import { openStepPanel, StepPanelDraft, targetMessage } from "../ui/panels/stepPanel";
import { columnChoices, userChoices } from "./editStep";

const COMMON_MESSAGES = ["Create", "Update", "Delete", "Assign", "SetState", "SetStateDynamicEntity", "Retrieve", "RetrieveMultiple", "Associate", "Disassociate", "QualifyLead", "Merge"];

export interface StepRequest {
  pluginTypeId: string;
  typeName: string;
  messageId: string;
  message: string;
  filterId?: string;
  table?: string;
  stage: number;
  mode: 0 | 1;
  filtering: string[];
  images: Array<{ kind: "Pre" | "Post"; alias: string; attributes: string[]; /** 0 pre, 1 post, 2 both; the kind's when missing. */ type?: number }>;
  solution?: string;
  /** "<Class>: <message> of <table>" when missing. */
  name?: string;
  description?: string;
  /** 1 when missing. */
  rank?: number;
  configuration?: string;
  runAsId?: string;
  /** Asynchronous steps delete their system job when missing. */
  deleteJobOnSuccess?: boolean;
}

/** Registers a step and its images. Returns the new step's ID. */
export async function registerStep(client: Client, req: StepRequest): Promise<string> {
  const dv = dataverseFor(client);
  const headers: Record<string, string> = req.solution ? { "MSCRM.SolutionUniqueName": req.solution } : {};
  const shortType = req.typeName.split(".").pop();
  const body: Record<string, unknown> = {
    name: req.name?.trim() || `${shortType}: ${req.message}${req.table ? ` of ${req.table}` : ""}`,
    stage: req.stage,
    mode: req.mode,
    rank: req.rank ?? 1,
    supporteddeployment: 0,
    asyncautodelete: req.mode === 1 && (req.deleteJobOnSuccess ?? true),
    "eventhandler_plugintype@odata.bind": `/plugintypes(${req.pluginTypeId})`,
    "sdkmessageid@odata.bind": `/sdkmessages(${req.messageId})`,
  };
  if (req.filterId) body["sdkmessagefilterid@odata.bind"] = `/sdkmessagefilters(${req.filterId})`;
  if (req.filtering.length) body.filteringattributes = req.filtering.join(",");
  if (req.description) body.description = req.description;
  if (req.configuration) body.configuration = req.configuration;
  if (req.runAsId) body["impersonatinguserid@odata.bind"] = `/systemusers(${req.runAsId})`;
  const stepId = await dv.create("sdkmessageprocessingsteps", body, headers);
  for (const img of req.images) {
    await dv.create(
      "sdkmessageprocessingstepimages",
      {
        name: img.alias,
        entityalias: img.alias,
        imagetype: img.type ?? (img.kind === "Pre" ? 0 : 1),
        // Create's post-image comes from the new record's Id, SetState's images from EntityMoniker, everything else from Target.
        messagepropertyname: imageMessageProperty(req.message),
        ...(img.attributes.length ? { attributes: img.attributes.join(",") } : {}),
        "sdkmessageprocessingstepid@odata.bind": `/sdkmessageprocessingsteps(${stepId})`,
      },
      headers
    );
  }
  return stepId;
}

export function registerStepCommands(serviceFor: (c: Client) => MetadataService, onDone: (client: Client) => void): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("lantern.steps.register", async (arg?: unknown) => {
      try {
        await guided(arg, serviceFor, onDone);
      } catch (err) {
        reportError(err);
      }
    }),
  ];
}

/** One page for the plug-in class, message, table, stage, mode, filtering columns and images, with columns picked from metadata. */
async function guided(arg: unknown, serviceFor: (c: Client) => MetadataService, onDone: (client: Client) => void): Promise<void> {
  const node = arg as { client?: Client; assembly?: string; typeName?: string; typeId?: string; status?: { type?: { plugintypeid: string } } } | undefined;
  const client = await resolveClient(arg);
  if (!client?.config.org) return;
  const dv = dataverseFor(client);
  const service = serviceFor(client);
  const env = client.envName || client.orgHost;

  const loaded = await withProgress("Loading plug-in types and tables", async () => ({
    types: await dv.getAll<{ plugintypeid: string; typename: string; assemblyname: string }>(
      "plugintypes?$select=plugintypeid,typename,assemblyname&$filter=customizationlevel eq 1&$orderby=typename"
    ),
    tables: await service.tables(),
    inSolution: new Set(await service.solutionTables(client.config.solutions).catch(() => [] as string[])),
  }));
  if (!loaded) return;
  const inAssembly = node?.assembly ? loaded.types.filter((t) => t.assemblyname === node.assembly) : loaded.types;
  if (!inAssembly.length) {
    void vscode.window.showWarningMessage("No custom plug-in types are registered. Push the assembly first (Build and Push Plug-in).");
    return;
  }
  // From a class's CodeLens: that class, if it's registered (pushed) yet. By ID when the caller knows it (Build and Push, the
  // tree): two registered versions of an assembly have types with the same name, and only one is the class that was meant.
  const typeId = (node?.typeId ?? node?.status?.type?.plugintypeid)?.toLowerCase();
  const known =
    (typeId ? inAssembly.find((t) => t.plugintypeid.toLowerCase() === typeId) : undefined) ??
    (node?.typeName ? inAssembly.find((t) => t.typename === node.typeName || t.typename.split(".").pop() === node.typeName) : undefined);
  if (node?.typeName && !known) {
    void vscode.window.showWarningMessage(`${node.typeName} isn't registered in ${client.orgHost} yet. Build and push the plug-in first.`);
    return;
  }

  const lookups = { messageId: "", filterId: undefined as string | undefined };
  const result = await openStepPanel(
    "Register Plug-in Step",
    {
      subtitle: `A new step in ${env}${node?.assembly ? ` for ${node.assembly}` : ""}`,
      mode: "register",
      message: "",
      table: "",
      typeName: "",
      classes: inAssembly.map((t) => ({ id: t.plugintypeid, typeName: t.typename, assembly: t.assemblyname })),
      messages: COMMON_MESSAGES,
      tables: loaded.tables
        .map((t) => ({ id: t.logicalName, label: t.displayName || t.logicalName, meta: `${t.logicalName}${loaded.inSolution.has(t.logicalName) ? " · in your solution" : ""}` }))
        .sort((a, b) => Number(loaded.inSolution.has(b.id)) - Number(loaded.inSolution.has(a.id)) || a.label.localeCompare(b.label)),
      solutions: client.config.solutions,
      draft: {
        step: { name: "", description: "", stage: 40, mode: 0, rank: 1, filtering: [], deleteJobOnSuccess: true, configuration: "", secureConfig: { stored: false }, images: [] },
        target: { pluginTypeId: known?.plugintypeid ?? "", typeName: known?.typename ?? "", message: "", table: "", solution: client.config.solutions.length === 1 ? client.config.solutions[0] : "", nameAuto: true },
      },
    },
    undefined,
    {
      columns: (table) => columnChoices(service, table),
      users: (text) => userChoices(client, text),
      submit: async (d: StepPanelDraft) => {
        const t = d.target!;
        const message = targetMessage(t);
        const messages = await dv.getAll<{ sdkmessageid: string }>(`sdkmessages?$select=sdkmessageid&$filter=name eq '${message.replace(/'/g, "''")}'`);
        if (!messages[0]) return `There's no message named ${message}.`;
        lookups.messageId = messages[0].sdkmessageid;
        lookups.filterId = undefined;
        if (t.table) {
          const filters = await dv.getAll<{ sdkmessagefilterid: string }>(
            `sdkmessagefilters?$select=sdkmessagefilterid&$filter=_sdkmessageid_value eq ${messages[0].sdkmessageid} and primaryobjecttypecode eq '${t.table.replace(/'/g, "''")}'`
          );
          if (!filters[0]) return `${message} isn't available for ${t.table}.`;
          lookups.filterId = filters[0].sdkmessagefilterid;
        }
        return undefined;
      },
    }
  );
  if (!result) return;
  const t = result.target!;
  const d = result.step;
  const message = targetMessage(t);
  const table = t.table || undefined;
  const live = d.images.filter((i) => !i.removed);
  const summary = `${t.typeName.split(".").pop()}: ${message}${table ? ` of ${table}` : ""}, ${d.stage === 10 ? "pre-validation" : d.stage === 20 ? "pre-operation" : "post-operation"}, ${d.mode ? "asynchronous" : "synchronous"}` +
    `${d.filtering.length ? `, when ${d.filtering.join(", ")} change` : ""}${live.length ? `, ${live.map((i) => `${i.type === 1 ? "post" : i.type === 2 ? "pre- and post" : "pre"}-image ${i.alias.trim()}`).join(" and ")}` : ""}`;
  if (!(await confirmProtected(client, "Register a plug-in step"))) return;
  const id = await withProgress("Registering the step", () =>
    registerStep(client, {
      pluginTypeId: t.pluginTypeId,
      typeName: t.typeName,
      messageId: lookups.messageId,
      message,
      filterId: lookups.filterId,
      table,
      stage: d.stage,
      mode: d.mode === 1 ? 1 : 0,
      filtering: message.toLowerCase() === "update" && table ? d.filtering : [],
      images: live.map((i) => ({ kind: i.type === 1 ? ("Post" as const) : ("Pre" as const), alias: i.alias.trim(), attributes: i.columns, type: i.type })),
      solution: t.solution || undefined,
      name: d.name,
      description: d.description.trim() || undefined,
      rank: d.rank,
      configuration: d.configuration || undefined,
      runAsId: d.runAs?.id,
      deleteJobOnSuccess: d.deleteJobOnSuccess,
    })
  );
  if (!id) return;
  forgetRegisteredSteps();
  onDone(client);
  void vscode.window.showInformationMessage(`Registered ${summary}. Right-click it under Plug-ins > Steps to check it against the class's code.`);
}
