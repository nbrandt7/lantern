import { DataverseClient } from "./dataverse";
import { TableMeta } from "./metadata";

/** Dataverse solution component types (the componenttype choice). */
export const COMPONENT_TYPE: Record<number, string> = {
  1: "Table", 2: "Column", 3: "Relationship", 9: "Choice", 10: "Relationship", 14: "Key", 20: "Security role",
  24: "Form", 26: "View", 29: "Process", 31: "Report", 36: "Email template", 59: "Chart", 60: "Form", 61: "Web resource",
  62: "Site map", 63: "Connection role", 65: "Hierarchy rule", 66: "Custom control", 70: "Column security profile",
  80: "Model-driven app", 90: "Plug-in type", 91: "Plug-in assembly", 92: "Plug-in step", 93: "Plug-in step image",
  95: "Service endpoint", 300: "Canvas app", 371: "Connector", 372: "Connector", 380: "Environment variable",
  381: "Environment variable value",
};

/** Component types this report can start from. */
export const TYPE = { table: 1, column: 2, form: 60, webResource: 61, step: 92, envVar: 380, view: 26, process: 29 } as const;

export interface Dependency {
  type: number;
  typeLabel: string;
  id: string;
  name: string;
  /** Extra context, like the table a form or view belongs to. */
  detail?: string;
}

interface RawDependency {
  dependentcomponentobjectid: string;
  dependentcomponenttype: number;
  dependentcomponentparentid?: string | null;
  requiredcomponentobjectid: string;
  requiredcomponenttype: number;
  requiredcomponentparentid?: string | null;
}

/**
 * What depends on a component (would break if it changed or was deleted) and what it
 * depends on, from Dataverse's own dependency tracking. Code isn't tracked there.
 */
export async function fetchDependencies(
  dv: DataverseClient,
  objectId: string,
  componentType: number,
  tables: TableMeta[]
): Promise<{ usedBy: Dependency[]; uses: Dependency[] }> {
  const call = (fn: string) =>
    dv.getAll<RawDependency>(`${fn}(ObjectId=@p1,ComponentType=@p2)?@p1=${objectId}&@p2=${componentType}`).catch(() => [] as RawDependency[]);
  const [dependents, required] = await Promise.all([call("RetrieveDependentComponents"), call("RetrieveRequiredComponents")]);
  const resolver = new NameResolver(dv, tables);
  const resolve = (rows: Array<{ id: string; type: number; parent?: string | null }>) =>
    Promise.all(dedupe(rows).map((r) => resolver.resolve(r.type, r.id, r.parent ?? undefined)));
  const [usedBy, uses] = await Promise.all([
    resolve(dependents.map((d) => ({ id: d.dependentcomponentobjectid, type: d.dependentcomponenttype, parent: d.dependentcomponentparentid }))),
    resolve(required.map((d) => ({ id: d.requiredcomponentobjectid, type: d.requiredcomponenttype, parent: d.requiredcomponentparentid }))),
  ]);
  const sort = (list: Dependency[]) => list.sort((a, b) => a.typeLabel.localeCompare(b.typeLabel) || a.name.localeCompare(b.name));
  return { usedBy: sort(usedBy), uses: sort(uses) };
}

function dedupe<T extends { id: string; type: number }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.type}|${r.id.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Turns component IDs into names, one small lookup per component. */
class NameResolver {
  private readonly byMetadataId: Map<string, TableMeta>;

  constructor(private readonly dv: DataverseClient, tables: TableMeta[]) {
    this.byMetadataId = new Map(tables.map((t) => [t.metadataId.toLowerCase(), t]));
  }

  async resolve(type: number, id: string, parent?: string): Promise<Dependency> {
    const typeLabel = COMPONENT_TYPE[type] ?? `Component type ${type}`;
    const base: Dependency = { type, typeLabel, id, name: id };
    const get = <T>(path: string) => this.dv.getJson<T>(path).catch(() => undefined);
    const table = (metadataId?: string) => (metadataId ? this.byMetadataId.get(metadataId.toLowerCase()) : undefined);
    switch (type) {
      case 1: {
        const t = table(id);
        return t ? { ...base, name: t.displayName, detail: t.logicalName } : base;
      }
      case 2: {
        const t = table(parent);
        const r = t ? await get<{ LogicalName: string; DisplayName?: { UserLocalizedLabel?: { Label?: string } } }>(
          `EntityDefinitions(${t.metadataId})/Attributes(${id})?$select=LogicalName,DisplayName`
        ) : undefined;
        return r ? { ...base, name: r.DisplayName?.UserLocalizedLabel?.Label || r.LogicalName, detail: `${t!.logicalName}.${r.LogicalName}` } : base;
      }
      case 24:
      case 60: {
        const r = await get<{ name: string; objecttypecode: string }>(`systemforms(${id})?$select=name,objecttypecode`);
        return r ? { ...base, name: r.name, detail: r.objecttypecode } : base;
      }
      case 26: {
        const r = await get<{ name: string; returnedtypecode: string }>(`savedqueries(${id})?$select=name,returnedtypecode`);
        return r ? { ...base, name: r.name, detail: r.returnedtypecode } : base;
      }
      default: {
        const lookup = SIMPLE[type];
        if (!lookup) return base;
        const r = await get<Record<string, string>>(`${lookup[0]}(${id})?$select=${lookup[1]}`);
        return r?.[lookup[1]] ? { ...base, name: r[lookup[1]] } : base;
      }
    }
  }
}

/** Entity set and name column for component types that only need a name. */
const SIMPLE: Record<number, [string, string]> = {
  20: ["roles", "name"],
  29: ["workflows", "name"],
  31: ["reports", "name"],
  36: ["templates", "title"],
  59: ["savedqueryvisualizations", "name"],
  61: ["webresourceset", "name"],
  62: ["sitemaps", "sitemapname"],
  66: ["customcontrols", "name"],
  80: ["appmodules", "name"],
  90: ["plugintypes", "typename"],
  91: ["pluginassemblies", "name"],
  92: ["sdkmessageprocessingsteps", "name"],
  300: ["canvasapps", "name"],
  380: ["environmentvariabledefinitions", "schemaname"],
};
