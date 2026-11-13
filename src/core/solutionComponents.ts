import { DataverseClient } from "./dataverse";

/**
 * Adding existing components to a solution and taking them out, as the maker
 * portal's Add existing and Remove from this solution do (AddSolutionComponent,
 * RemoveSolutionComponent). Removing never deletes the component itself.
 */

export type ComponentKind = "table" | "column" | "form" | "flow" | "webResource" | "pluginAssembly" | "pluginPackage" | "step";

/** Fixed solution component types. Plug-in packages' type is per org (solutioncomponentdefinitions). */
const FIXED: Partial<Record<ComponentKind, number>> = { table: 1, column: 2, flow: 29, form: 60, webResource: 61, pluginAssembly: 91, step: 92 };

export const KIND_LABEL: Record<ComponentKind, string> = {
  table: "table",
  column: "column",
  form: "form",
  flow: "cloud flow",
  webResource: "web resource",
  pluginAssembly: "plug-in assembly",
  pluginPackage: "plug-in package",
  step: "plug-in step",
};

export interface ComponentRef {
  kind: ComponentKind;
  /** The component's ID (a table's MetadataId). */
  id: string;
  label: string;
}

export interface SolutionMembership {
  uniqueName: string;
  friendlyName: string;
  managed: boolean;
}

const typeCache = new WeakMap<DataverseClient, Promise<number | undefined>>();

/** The solution component type for a kind of component. */
export async function componentType(dv: DataverseClient, kind: ComponentKind): Promise<number> {
  const fixed = FIXED[kind];
  if (fixed !== undefined) return fixed;
  let lookup = typeCache.get(dv);
  if (!lookup) {
    lookup = dv
      .getAll<{ solutioncomponenttype: number }>("solutioncomponentdefinitions?$select=solutioncomponenttype&$filter=name eq 'pluginpackage'")
      .then((rows) => rows[0]?.solutioncomponenttype);
    typeCache.set(dv, lookup);
  }
  const type = await lookup;
  if (type === undefined) throw new Error("This environment doesn't have plug-in packages as a solution component type.");
  return type;
}

/** The solutions a component is in, leaving out Default and Active (everything is in those). */
export async function solutionsContaining(dv: DataverseClient, ref: ComponentRef): Promise<SolutionMembership[]> {
  const type = await componentType(dv, ref.kind);
  const rows = await dv.getAll<{ solutionid?: { uniquename?: string; friendlyname?: string; ismanaged?: boolean } | null }>(
    `solutioncomponents?$select=solutioncomponentid&$filter=objectid eq ${ref.id} and componenttype eq ${type}&$expand=solutionid($select=uniquename,friendlyname,ismanaged)`
  );
  const out: SolutionMembership[] = [];
  for (const r of rows) {
    const s = r.solutionid;
    if (!s?.uniquename || ["default", "active"].includes(s.uniquename.toLowerCase()) || out.some((o) => o.uniqueName === s.uniquename)) continue;
    out.push({ uniqueName: s.uniquename, friendlyName: s.friendlyname || s.uniquename, managed: s.ismanaged === true });
  }
  return out.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
}

/** Which of these component IDs are in a solution (by its ID), checked 40 at a time. */
export async function idsInSolution(dv: DataverseClient, solutionId: string, kind: ComponentKind, ids: string[]): Promise<Set<string>> {
  const type = await componentType(dv, kind);
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 40) {
    const filter = `_solutionid_value eq ${solutionId} and componenttype eq ${type} and (${ids.slice(i, i + 40).map((id) => `objectid eq ${id}`).join(" or ")})`;
    for (const r of await dv.getAll<{ objectid: string }>(`solutioncomponents?$select=objectid&$filter=${encodeURIComponent(filter)}`)) found.add(r.objectid.toLowerCase());
  }
  return found;
}

export interface AddOptions {
  /** Also add what it needs to import elsewhere (a step's assembly, a flow's connection references). */
  addRequired: boolean;
  /** Tables: only the table itself, not its columns, forms, views and the rest. */
  tableOnly?: boolean;
}

export async function addToSolution(dv: DataverseClient, ref: ComponentRef, solution: string, options: AddOptions): Promise<void> {
  await dv.action("AddSolutionComponent", {
    ComponentId: ref.id,
    ComponentType: await componentType(dv, ref.kind),
    SolutionUniqueName: solution,
    AddRequiredComponents: options.addRequired,
    // A table with DoNotIncludeSubcomponents is added as "table metadata only"; otherwise with all its parts.
    DoNotIncludeSubcomponents: ref.kind === "table" ? options.tableOnly === true : false,
    IncludedComponentSettingsValues: null,
  });
}

export async function removeFromSolution(dv: DataverseClient, ref: ComponentRef, solution: string): Promise<void> {
  // Unlike AddSolutionComponent, the component goes as a solutioncomponent reference whose
  // solutioncomponentid is the component's own ID (the SDK request's ComponentId).
  await dv.action("RemoveSolutionComponent", {
    SolutionComponent: { "@odata.type": "Microsoft.Dynamics.CRM.solutioncomponent", solutioncomponentid: ref.id },
    ComponentType: await componentType(dv, ref.kind),
    SolutionUniqueName: solution,
  });
}
