import { DataverseClient } from "./dataverse";
import { UserError } from "./errors";

/** Parameter and property types, with their Dataverse type codes. */
export const API_TYPES = {
  Boolean: 0, DateTime: 1, Decimal: 2, Entity: 3, EntityCollection: 4, EntityReference: 5, Float: 6,
  Integer: 7, Money: 8, Picklist: 9, String: 10, StringArray: 11, Guid: 12,
} as const;
export type ApiType = keyof typeof API_TYPES;

export interface ApiField {
  uniquename: string;
  type: ApiType;
  displayname?: string;
  description?: string;
  /** Request parameters only. */
  optional?: boolean;
  /** Table for Entity / EntityReference types (optional). */
  entity?: string;
}

/** A Custom API as a file in the repo: customapis/<uniquename>.json. */
export interface CustomApiDef {
  uniquename: string;
  displayname?: string;
  description?: string;
  binding?: "global" | "entity" | "entitycollection";
  boundEntity?: string;
  isFunction?: boolean;
  isPrivate?: boolean;
  /** Whether other plug-ins can register steps on it. */
  allowedStepType?: "none" | "async" | "sync";
  /** Full type name of the plug-in class that runs it, e.g. Acme.Plugins.CalculateDiscount. */
  plugin?: string;
  requestParameters?: ApiField[];
  responseProperties?: ApiField[];
}

const BINDING = { global: 0, entity: 1, entitycollection: 2 } as const;
const STEP_TYPE = { none: 0, async: 1, sync: 2 } as const;

/** Problems that would make a deploy fail, as readable sentences. */
export function validateDef(def: CustomApiDef): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9]+_\w+$/i.test(def.uniquename ?? "")) problems.push('"uniquename" needs a publisher prefix, like acme_CalculateDiscount.');
  if (def.binding && !(def.binding in BINDING)) problems.push('"binding" is global, entity, or entitycollection.');
  if (def.binding && def.binding !== "global" && !def.boundEntity) problems.push('A bound Custom API needs "boundEntity".');
  if (def.allowedStepType && !(def.allowedStepType in STEP_TYPE)) problems.push('"allowedStepType" is none, async, or sync.');
  const fields = [...(def.requestParameters ?? []).map((f) => ["request parameter", f] as const), ...(def.responseProperties ?? []).map((f) => ["response property", f] as const)];
  for (const [what, f] of fields) {
    if (!/^\w+$/.test(f.uniquename ?? "")) problems.push(`A ${what} needs a "uniquename" of letters, digits, and underscores.`);
    if (!(f.type in API_TYPES)) problems.push(`${what} ${f.uniquename}: "type" must be one of ${Object.keys(API_TYPES).join(", ")}.`);
  }
  const dupes = (list: ApiField[] = []) => list.map((f) => f.uniquename).filter((n, i, a) => a.indexOf(n) !== i);
  for (const d of [...dupes(def.requestParameters), ...dupes(def.responseProperties)]) problems.push(`${d} appears twice.`);
  return problems;
}

const fieldBody = (f: ApiField, request: boolean): Record<string, unknown> => ({
  uniquename: f.uniquename,
  name: f.uniquename,
  displayname: f.displayname ?? f.uniquename,
  description: f.description ?? f.displayname ?? f.uniquename,
  type: API_TYPES[f.type],
  ...(f.entity ? { logicalentityname: f.entity } : {}),
  ...(request ? { isoptional: !!f.optional } : {}),
});

export interface DeployResult {
  created: boolean;
  added: string[];
  /** Fields whose type differs from what's deployed; Dataverse doesn't allow changing it in place. */
  cannotChange: string[];
}

/**
 * Creates the Custom API (with its parameters and properties) or updates the parts
 * Dataverse allows changing: names, description, privacy, the plug-in, and new fields.
 */
export async function deployCustomApi(dv: DataverseClient, def: CustomApiDef, solution?: string): Promise<DeployResult> {
  const problems = validateDef(def);
  if (problems.length) throw new UserError(problems.join(" "));
  const headers: Record<string, string> = solution ? { "MSCRM.SolutionUniqueName": solution } : {};
  let pluginTypeId: string | undefined;
  if (def.plugin) {
    const types = await dv.getAll<{ plugintypeid: string }>(`plugintypes?$select=plugintypeid&$filter=typename eq '${def.plugin.replace(/'/g, "''")}'`);
    if (!types[0]) throw new UserError(`The plug-in class ${def.plugin} isn't registered yet. Build and push the plug-in, then deploy the Custom API.`);
    pluginTypeId = types[0].plugintypeid;
  }
  const existing = (
    await dv.getAll<{
      customapiid: string;
      CustomAPIRequestParameters?: Array<{ uniquename: string; type: number }>;
      CustomAPIResponseProperties?: Array<{ uniquename: string; type: number }>;
    }>(
      `customapis?$select=customapiid&$filter=uniquename eq '${def.uniquename.replace(/'/g, "''")}'` +
        "&$expand=CustomAPIRequestParameters($select=uniquename,type),CustomAPIResponseProperties($select=uniquename,type)"
    )
  )[0];

  const top: Record<string, unknown> = {
    name: def.uniquename,
    displayname: def.displayname ?? def.uniquename,
    description: def.description ?? def.displayname ?? def.uniquename,
    isprivate: !!def.isPrivate,
    ...(pluginTypeId ? { "PluginTypeId@odata.bind": `/plugintypes(${pluginTypeId})` } : {}),
  };
  if (!existing) {
    await dv.create(
      "customapis",
      {
        ...top,
        uniquename: def.uniquename,
        bindingtype: BINDING[def.binding ?? "global"],
        ...(def.binding && def.binding !== "global" ? { boundentitylogicalname: def.boundEntity } : {}),
        isfunction: !!def.isFunction,
        allowedcustomprocessingsteptype: STEP_TYPE[def.allowedStepType ?? "sync"],
        CustomAPIRequestParameters: (def.requestParameters ?? []).map((f) => fieldBody(f, true)),
        CustomAPIResponseProperties: (def.responseProperties ?? []).map((f) => fieldBody(f, false)),
      },
      headers
    );
    return { created: true, added: [], cannotChange: [] };
  }
  await dv.update(`customapis(${existing.customapiid})`, top);
  const result: DeployResult = { created: false, added: [], cannotChange: [] };
  const sync = async (fields: ApiField[] = [], deployed: Array<{ uniquename: string; type: number }> = [], set: string, request: boolean) => {
    for (const f of fields) {
      const there = deployed.find((d) => d.uniquename.toLowerCase() === f.uniquename.toLowerCase());
      if (!there) {
        await dv.create(set, { ...fieldBody(f, request), "CustomAPIId@odata.bind": `/customapis(${existing.customapiid})` }, headers);
        result.added.push(f.uniquename);
      } else if (there.type !== API_TYPES[f.type]) result.cannotChange.push(f.uniquename);
    }
  };
  await sync(def.requestParameters, existing.CustomAPIRequestParameters, "customapirequestparameters", true);
  await sync(def.responseProperties, existing.CustomAPIResponseProperties, "customapiresponseproperties", false);
  return result;
}

const CS_TYPE: Record<ApiType, string> = {
  Boolean: "bool", DateTime: "DateTime", Decimal: "decimal", Entity: "Entity", EntityCollection: "EntityCollection",
  EntityReference: "EntityReference", Float: "double", Integer: "int", Money: "Money", Picklist: "OptionSetValue",
  String: "string", StringArray: "string[]", Guid: "Guid",
};
const VALUE_TYPES = new Set<ApiType>(["Boolean", "DateTime", "Decimal", "Float", "Integer", "Guid"]);

/** The plug-in class behind a Custom API: reads each request parameter, sets each response property. */
export function csharpHandler(def: CustomApiDef, ns: string, className: string): string {
  const reads = (def.requestParameters ?? []).map((p) => {
    const t = CS_TYPE[p.type];
    const nullable = VALUE_TYPES.has(p.type) ? `${t}?` : t;
    return `            var ${camel(p.uniquename)} = context.InputParameters.Contains("${p.uniquename}") ? (${nullable})context.InputParameters["${p.uniquename}"] : null;`;
  });
  const writes = (def.responseProperties ?? []).map((p) => `            context.OutputParameters["${p.uniquename}"] = default(${CS_TYPE[p.type]}); // TODO`);
  return `using System;
using Microsoft.Xrm.Sdk;

namespace ${ns}
{
    /// <summary>Runs the ${def.uniquename} Custom API${def.displayname ? ` (${def.displayname})` : ""}.</summary>
    public class ${className} : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
${def.binding && def.binding !== "global" ? `\n            var target = (EntityReference)context.InputParameters["Target"];\n` : ""}
${reads.join("\n") || "            // No request parameters."}

            tracing.Trace("${def.uniquename} called");

${writes.join("\n") || "            // No response properties."}
        }
    }
}
`;
}

const TS_TYPE: Record<ApiType, string> = {
  Boolean: "boolean", DateTime: "Date | string", Decimal: "number", Entity: "Record<string, unknown>", EntityCollection: "Array<Record<string, unknown>>",
  EntityReference: "{ entityType: string; id: string }", Float: "number", Integer: "number", Money: "number", Picklist: "number",
  String: "string", StringArray: "string[]", Guid: "string",
};
const EDM: Record<ApiType, [string, number]> = {
  Boolean: ["Edm.Boolean", 1], DateTime: ["Edm.DateTimeOffset", 1], Decimal: ["Edm.Decimal", 1], Entity: ["mscrm.crmbaseentity", 5],
  EntityCollection: ["Collection(mscrm.crmbaseentity)", 4], EntityReference: ["mscrm.crmbaseentity", 5], Float: ["Edm.Double", 1],
  Integer: ["Edm.Int32", 1], Money: ["Edm.Decimal", 1], Picklist: ["Edm.Int32", 1], String: ["Edm.String", 1],
  StringArray: ["Collection(Edm.String)", 4], Guid: ["Edm.Guid", 1],
};

/** A typed TypeScript function that calls the Custom API through Xrm.WebApi.online.execute. */
export function typescriptClient(def: CustomApiDef): string {
  const name = def.uniquename.replace(/^[a-z0-9]+_/i, "");
  const req = def.requestParameters ?? [];
  const res = def.responseProperties ?? [];
  const bound = def.binding && def.binding !== "global";
  const params = req.map((p) => `  ${p.uniquename}${p.optional ? "?" : ""}: ${TS_TYPE[p.type]};`).join("\n");
  const props = res.map((p) => `  ${p.uniquename}: ${TS_TYPE[p.type]};`).join("\n");
  const types = req
    .map((p) => {
      const [typeName, kind] = p.type === "EntityReference" && p.entity ? [`mscrm.${p.entity}`, 5] : EDM[p.type];
      return `        ${p.uniquename}: { typeName: "${typeName}", structuralProperty: ${kind} },`;
    })
    .join("\n");
  return `// Generated by Lantern from customapis/${def.uniquename}.json. Regenerate after changing the definition.

export interface ${name}Request {
${params || "  // No request parameters."}
}

export interface ${name}Response {
${props || "  // No response properties."}
}

/** Calls the ${def.uniquename} Custom API${def.displayname ? ` (${def.displayname})` : ""}. */
export async function ${camel(name)}(${bound ? `target: { entityType: string; id: string }, ` : ""}request: ${name}Request${req.length ? "" : " = {}"}): Promise<${name}Response> {
  const call = {
    ...request,
${bound ? "    entity: target,\n" : ""}    getMetadata: () => ({
      boundParameter: ${bound ? '"entity"' : "null"},
      parameterTypes: {
${bound ? `        entity: { typeName: "mscrm.${def.boundEntity}", structuralProperty: 5 },\n` : ""}${types}
      },
      operationType: ${def.isFunction ? 1 : 0},
      operationName: "${def.uniquename}",
    }),
  };
  const response = await Xrm.WebApi.online.execute(call);
  if (!response.ok) throw new Error(\`${def.uniquename} failed: \${response.status} \${response.statusText}\`);
  return ${res.length ? "(await response.json()) as " + name + "Response" : `{} as ${name}Response`};
}
`;
}

const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function newDefinition(uniquename: string, displayname: string, binding: CustomApiDef["binding"], boundEntity: string | undefined, isFunction: boolean): CustomApiDef {
  return {
    uniquename,
    displayname,
    description: "",
    binding,
    ...(binding !== "global" ? { boundEntity } : {}),
    isFunction,
    isPrivate: false,
    allowedStepType: "sync",
    plugin: "",
    requestParameters: [{ uniquename: "Input", type: "String", optional: false }],
    responseProperties: [{ uniquename: "Output", type: "String" }],
  };
}
