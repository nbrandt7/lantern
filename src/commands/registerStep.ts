import * as vscode from "vscode";
import { Client } from "../core/clients";
import { MetadataService } from "../core/metadata";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, reportError, resolveClient, withProgress } from "../ui/context";
import { pickTable } from "./metadata";
import { forgetRegisteredSteps } from "../ui/editor";

const COMMON_MESSAGES = ["Create", "Update", "Delete", "Assign", "SetState", "SetStateDynamicEntity", "Retrieve", "RetrieveMultiple", "Associate", "Disassociate", "QualifyLead", "Merge"];
const STAGES = [
  { label: "Pre-validation", description: "before security checks, outside the transaction", value: 10 },
  { label: "Pre-operation", description: "inside the transaction, before the change is saved; change Target here", value: 20 },
  { label: "Post-operation", description: "after the change is saved", value: 40 },
];

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
  images: Array<{ kind: "Pre" | "Post"; alias: string; attributes: string[] }>;
  solution?: string;
}

/** Registers a step and its images. Returns the new step's ID. */
export async function registerStep(client: Client, req: StepRequest): Promise<string> {
  const dv = dataverseFor(client);
  const headers: Record<string, string> = req.solution ? { "MSCRM.SolutionUniqueName": req.solution } : {};
  const shortType = req.typeName.split(".").pop();
  const body: Record<string, unknown> = {
    name: `${shortType}: ${req.message}${req.table ? ` of ${req.table}` : ""}`,
    stage: req.stage,
    mode: req.mode,
    rank: 1,
    supporteddeployment: 0,
    asyncautodelete: req.mode === 1,
    "eventhandler_plugintype@odata.bind": `/plugintypes(${req.pluginTypeId})`,
    "sdkmessageid@odata.bind": `/sdkmessages(${req.messageId})`,
  };
  if (req.filterId) body["sdkmessagefilterid@odata.bind"] = `/sdkmessagefilters(${req.filterId})`;
  if (req.filtering.length) body.filteringattributes = req.filtering.join(",");
  const stepId = await dv.create("sdkmessageprocessingsteps", body, headers);
  for (const img of req.images) {
    await dv.create(
      "sdkmessageprocessingstepimages",
      {
        name: img.alias,
        entityalias: img.alias,
        imagetype: img.kind === "Pre" ? 0 : 1,
        // Create's post-image comes from the new record's Id; everything else from Target.
        messagepropertyname: req.message === "Create" ? "Id" : "Target",
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

/** Message, table, stage, mode, filtering columns, and images, with columns picked from metadata. */
async function guided(arg: unknown, serviceFor: (c: Client) => MetadataService, onDone: (client: Client) => void): Promise<void> {
  const node = arg as { client?: Client; assembly?: string; typeName?: string } | undefined;
  const client = node?.client ?? (await resolveClient(arg));
  if (!client?.config.org) return;
  const dv = dataverseFor(client);

  const types = await withProgress("Loading plug-in types", () =>
    dv.getAll<{ plugintypeid: string; typename: string; assemblyname: string }>(
      "plugintypes?$select=plugintypeid,typename,assemblyname&$filter=customizationlevel eq 1&$orderby=typename"
    )
  );
  if (!types) return;
  const inAssembly = node?.assembly ? types.filter((t) => t.assemblyname === node.assembly) : types;
  if (!inAssembly.length) {
    void vscode.window.showWarningMessage("No custom plug-in types are registered. Push the assembly first (Build and Push Plug-in).");
    return;
  }
  const items = inAssembly.map((t) => ({ label: t.typename.split(".").pop() ?? t.typename, description: t.typename, detail: t.assemblyname, t }));
  // From a class's CodeLens: that class, if it's registered (pushed) yet.
  const known = node?.typeName ? items.find((i) => i.t.typename === node.typeName || i.label === node.typeName) : undefined;
  if (node?.typeName && !known) {
    void vscode.window.showWarningMessage(`${node.typeName} isn't registered in ${client.orgHost} yet. Build and push the plug-in first.`);
    return;
  }
  const type = known ?? (await vscode.window.showQuickPick(items, { placeHolder: "Which plug-in class should the step run?" }));
  if (!type) return;

  let message = await vscode.window.showQuickPick([...COMMON_MESSAGES, "Other…"], { placeHolder: "Which message (event)?" });
  if (!message) return;
  if (message === "Other…") {
    message = await vscode.window.showInputBox({ prompt: "Message name, e.g. a custom API or action name" });
    if (!message) return;
  }
  const messages = await dv.getAll<{ sdkmessageid: string }>(`sdkmessages?$select=sdkmessageid&$filter=name eq '${message.replace(/'/g, "''")}'`);
  if (!messages[0]) {
    void vscode.window.showWarningMessage(`There's no message named ${message}.`);
    return;
  }

  const service = serviceFor(client);
  const table = await pickTable(client, service, `${message} of which table? (Esc for none)`);
  let filterId: string | undefined;
  if (table) {
    const filters = await dv.getAll<{ sdkmessagefilterid: string }>(
      `sdkmessagefilters?$select=sdkmessagefilterid&$filter=_sdkmessageid_value eq ${messages[0].sdkmessageid} and primaryobjecttypecode eq '${table.logicalName}'`
    );
    if (!filters[0]) {
      void vscode.window.showWarningMessage(`${message} isn't available for ${table.logicalName}.`);
      return;
    }
    filterId = filters[0].sdkmessagefilterid;
  }

  const stage = await vscode.window.showQuickPick(STAGES, { placeHolder: "When should it run?" });
  if (!stage) return;
  let mode: 0 | 1 = 0;
  if (stage.value === 40) {
    const m = await vscode.window.showQuickPick(
      [
        { label: "Synchronous", description: "the user waits; errors block the save", value: 0 as const },
        { label: "Asynchronous", description: "runs in the background as a system job", value: 1 as const },
      ],
      { placeHolder: "Run synchronously or in the background?" }
    );
    if (!m) return;
    mode = m.value;
  }

  const columns = table ? (await service.columns(table.logicalName)).filter((c) => !c.attributeOf && c.readable !== false) : [];
  let filtering: string[] = [];
  if (message === "Update" && table) {
    const picks = await vscode.window.showQuickPick(
      columns.map((c) => ({ label: c.displayName || c.logicalName, description: c.logicalName })),
      { canPickMany: true, placeHolder: "Run only when these columns change (pick none to run on any change)", matchOnDescription: true }
    );
    if (picks === undefined) return;
    filtering = picks.map((p: { description: string }) => p.description);
  }

  const images: StepRequest["images"] = [];
  if (table && (message !== "Create" || stage.value === 40)) {
    const kinds = await vscode.window.showQuickPick(
      [
        ...(message !== "Create" ? [{ label: "Pre-image", description: "the row as it was before", image: "Pre" as const }] : []),
        ...(stage.value === 40 && message !== "Delete" ? [{ label: "Post-image", description: "the row as it is after", image: "Post" as const }] : []),
      ],
      { canPickMany: true, placeHolder: "Add images? (pick none to skip)" }
    );
    if (kinds === undefined) return;
    for (const k of kinds) {
      const alias = await vscode.window.showInputBox({ prompt: `${k.image}-image alias (what your code reads)`, value: `${k.image}Image` });
      if (!alias) return;
      const cols = await vscode.window.showQuickPick(
        columns.map((c) => ({ label: c.displayName || c.logicalName, description: c.logicalName })),
        { canPickMany: true, placeHolder: `Columns in the ${k.image.toLowerCase()}-image (pick none for all columns)`, matchOnDescription: true }
      );
      if (cols === undefined) return;
      images.push({ kind: k.image, alias, attributes: cols.map((c: { description: string }) => c.description) });
    }
  }

  let solution: string | undefined;
  if (client.config.solutions.length) {
    const s = await vscode.window.showQuickPick([...client.config.solutions, "(don't add to a solution)"], { placeHolder: "Add the step to which solution?" });
    if (s === undefined) return;
    solution = s.startsWith("(") ? undefined : s;
  }

  const summary = `${type.label}: ${message}${table ? ` of ${table.logicalName}` : ""}, ${stage.label}, ${mode ? "asynchronous" : "synchronous"}` +
    `${filtering.length ? `, when ${filtering.join(", ")} change` : ""}${images.length ? `, ${images.map((i) => `${i.kind.toLowerCase()}-image ${i.alias}`).join(" and ")}` : ""}`;
  const ok = await vscode.window.showInformationMessage(`Register ${summary}?`, { modal: true }, "Register Step");
  if (ok !== "Register Step" || !(await confirmProtected(client, "Register a plug-in step"))) return;
  const id = await withProgress("Registering the step", () =>
    registerStep(client, {
      pluginTypeId: type.t.plugintypeid,
      typeName: type.t.typename,
      messageId: messages[0].sdkmessageid,
      message,
      filterId,
      table: table?.logicalName,
      stage: stage.value,
      mode,
      filtering,
      images,
      solution,
    })
  );
  if (!id) return;
  forgetRegisteredSteps();
  onDone(client);
  void vscode.window.showInformationMessage(`Registered ${summary}. Right-click it under Plug-ins > Steps to check it against the class's code.`);
}
