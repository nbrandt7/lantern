import { Client } from "../core/clients";
import { RegisteredAssembly } from "../core/pluginRegistration";
import { orgPlugins, projectStatus } from "../core/pluginStatus";
import { ColumnMeta, TableMeta } from "../core/metadata";
import { ComponentRef } from "../core/solutionComponents";
import { PluginProject } from "../core/solutions";
import { dataverseFor } from "./auth";

/**
 * The solution component behind a tree node: a plug-in project or registered
 * assembly (its package when it's in one), a step, a web resource, a cloud flow,
 * a table, or a column. `solution` is set when the node sits under a solution.
 */
export interface NodeComponent {
  client: Client;
  ref: ComponentRef;
  solution?: string;
  /** For a column: its table, which has to be in a solution before the column can be. */
  table?: TableMeta;
}

type AnyNode = {
  kind?: string;
  client?: Client;
  plugin?: PluginProject;
  assembly?: RegisteredAssembly | string;
  step?: { id: string; message: string; table: string; typeName: string };
  resource?: { id: string; name: string };
  flow?: { id: string; name: string };
  table?: TableMeta;
  column?: ColumnMeta;
  unique?: string;
  solution?: string;
  contextValue?: string;
};

const assemblyRef = (a: RegisteredAssembly): ComponentRef =>
  a._packageid_value ? { kind: "pluginPackage", id: a._packageid_value, label: `${a.name}'s plug-in package` } : { kind: "pluginAssembly", id: a.pluginassemblyid, label: a.name };

/** silent: never ask anyone to sign in (for tooltips). */
export async function componentFor(arg: unknown, options: { silent?: boolean } = {}): Promise<NodeComponent | undefined> {
  const n = arg as AnyNode | undefined;
  const client = n?.client;
  if (!n || !client) return undefined;
  switch (n.kind) {
    case "plugin":
    case "hint": {
      if (!n.plugin || (n.kind === "hint" && n.contextValue !== "pluginRegistration")) return undefined;
      const registered = projectStatus(client, n.plugin, await orgPlugins(client, dataverseFor(client, { silent: options.silent }))).registered;
      return registered ? { client, ref: assemblyRef(registered) } : undefined;
    }
    case "remoteAssembly":
      return n.assembly && typeof n.assembly === "object" ? { client, ref: assemblyRef(n.assembly) } : undefined;
    case "step":
      return n.step ? { client, ref: { kind: "step", id: n.step.id, label: `${n.step.message}${n.step.table ? ` of ${n.step.table}` : ""} (${n.step.typeName.split(".").pop()})` } } : undefined;
    case "webResource":
      return n.resource ? { client, ref: { kind: "webResource", id: n.resource.id, label: n.resource.name }, solution: n.unique } : undefined;
    case "flow":
      return n.flow ? { client, ref: { kind: "flow", id: n.flow.id, label: n.flow.name }, solution: n.unique } : undefined;
    case "table":
      return n.table?.metadataId ? { client, ref: { kind: "table", id: n.table.metadataId, label: n.table.displayName || n.table.logicalName }, solution: n.solution } : undefined;
    case "column":
      return n.column?.metadataId && n.table
        ? { client, ref: { kind: "column", id: n.column.metadataId, label: `${n.column.displayName || n.column.logicalName} (${n.table.logicalName}.${n.column.logicalName})` }, table: n.table, solution: n.solution }
        : undefined;
    default:
      return undefined;
  }
}
