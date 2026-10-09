import { DataverseClient } from "./dataverse";

export interface TraceLog {
  id: string;
  typeName: string;
  message: string;
  table: string;
  mode: "Synchronous" | "Asynchronous";
  depth: number;
  operation: string;
  createdOn: string;
  durationMs: number;
  correlationId: string;
  trace: string;
  exception: string;
}

export interface TraceFilter {
  errorsOnly: boolean;
  /** Only traces newer than this many hours (0 = no limit). */
  hours: number;
  /** Plug-in type name contains this text. */
  typeName: string;
}

export const DEFAULT_FILTER: TraceFilter = { errorsOnly: false, hours: 24, typeName: "" };

interface RawTrace {
  plugintracelogid: string;
  typename: string | null;
  messagename: string | null;
  primaryentity: string | null;
  mode: number | null;
  depth: number | null;
  operationtype: number | null;
  createdon: string;
  performanceexecutionduration: number | null;
  correlationid: string | null;
  messageblock: string | null;
  exceptiondetails: string | null;
}

const OPERATION: Record<number, string> = { 0: "Unknown", 1: "Plug-in", 2: "Workflow activity" };

export async function fetchTraces(dv: DataverseClient, filter: TraceFilter, top = 100): Promise<TraceLog[]> {
  const clauses: string[] = [];
  if (filter.hours > 0) clauses.push(`createdon ge ${new Date(Date.now() - filter.hours * 3600_000).toISOString()}`);
  if (filter.typeName.trim()) clauses.push(`contains(typename,'${filter.typeName.trim().replace(/'/g, "''")}')`);
  const where = clauses.length ? `&$filter=${encodeURIComponent(clauses.join(" and "))}` : "";
  // Exception text is a memo column, which the Web API can't filter on, so "errors only" is applied here.
  const fetchTop = filter.errorsOnly ? Math.min(top * 5, 500) : top;
  const rows = await dv.getJson<{ value: RawTrace[] }>(
    "plugintracelogs?$select=plugintracelogid,typename,messagename,primaryentity,mode,depth,operationtype,createdon," +
      `performanceexecutionduration,correlationid,messageblock,exceptiondetails&$orderby=createdon desc&$top=${fetchTop}${where}`
  );
  return rows.value
    .map((r): TraceLog => ({
      id: r.plugintracelogid,
      typeName: r.typename ?? "",
      message: r.messagename ?? "",
      table: r.primaryentity ?? "",
      mode: r.mode === 1 ? "Asynchronous" : "Synchronous",
      depth: r.depth ?? 0,
      operation: OPERATION[r.operationtype ?? 0] ?? "Unknown",
      createdOn: r.createdon,
      durationMs: r.performanceexecutionduration ?? 0,
      correlationId: r.correlationid ?? "",
      trace: r.messageblock ?? "",
      exception: r.exceptiondetails ?? "",
    }))
    .filter((t) => !filter.errorsOnly || t.exception.trim())
    .slice(0, top);
}

/** 0 = off, 1 = exceptions only, 2 = all. Returns the organization ID too, for changing it. */
export async function fetchTraceSetting(dv: DataverseClient): Promise<{ orgId: string; setting: number }> {
  const r = await dv.getJson<{ value: Array<{ organizationid: string; plugintracelogsetting: number }> }>(
    "organizations?$select=organizationid,plugintracelogsetting"
  );
  const org = r.value[0];
  return { orgId: org?.organizationid ?? "", setting: org?.plugintracelogsetting ?? 0 };
}

export async function setTraceSetting(dv: DataverseClient, orgId: string, setting: 0 | 1 | 2): Promise<void> {
  await dv.update(`organizations(${orgId})`, { plugintracelogsetting: setting });
}

/** Short type name: "Acme.Plugins.AccountPostUpdate, Acme.Plugins, Version=..." -> "AccountPostUpdate". */
export function shortTypeName(typeName: string): string {
  const full = typeName.split(",")[0].trim();
  return full.split(".").pop() || full;
}

export function formatTrace(t: TraceLog): string {
  const lines = [
    t.typeName.split(",")[0].trim(),
    "",
    `Message:      ${t.message}${t.table ? ` on ${t.table}` : ""}`,
    `Mode:         ${t.mode}, depth ${t.depth}, ${t.operation.toLowerCase()}`,
    `Started:      ${new Date(t.createdOn).toLocaleString()}`,
    `Duration:     ${t.durationMs} ms`,
    `Correlation:  ${t.correlationId}`,
    "",
    "Trace",
    "-----",
    t.trace.trim() || "(no trace output; call ITracingService.Trace in the plug-in to add some)",
  ];
  if (t.exception.trim()) lines.push("", "Exception", "---------", t.exception.trim());
  return lines.join("\n") + "\n";
}
