import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DataverseClient } from "./dataverse";

/**
 * Debugging a plug-in step the only way Dataverse allows: record an execution, then replay
 * it locally with a debugger attached. Profiling is a flag on the step (enablepluginprofiler,
 * the Plugin Registration Tool's trace-log profiler; no profiler solution needed). While the
 * org's plug-in trace logging is set to All, each run of the step writes its context to
 * plugintracelog.profile, which the tool's Replay Plug-in Execution takes as a file.
 */

export interface ProfileCapture {
  id: string;
  createdOn: string;
  typeName: string;
  message: string;
  table: string;
  exception: string;
  /** The serialized execution context, as the Plugin Registration Tool saves it. */
  profile: string;
}

/** Turns the step's profiler on or off. Nothing else about the step changes. */
export async function setStepProfiling(dv: DataverseClient, stepId: string, on: boolean): Promise<void> {
  await dv.update(`sdkmessageprocessingsteps(${stepId})`, { enablepluginprofiler: on });
}

/** Captures of the step since a moment, newest first. Trace log rows without a profile are left out. */
export async function fetchProfiles(dv: DataverseClient, stepId: string, since: Date): Promise<ProfileCapture[]> {
  const rows = await dv.getAll<{
    plugintracelogid: string;
    createdon: string;
    typename: string | null;
    messagename: string | null;
    primaryentity: string | null;
    exceptiondetails: string | null;
    profile: string | null;
  }>(
    `plugintracelogs?$select=plugintracelogid,createdon,typename,messagename,primaryentity,exceptiondetails,profile` +
      `&$filter=${encodeURIComponent(`pluginstepid eq ${stepId} and createdon ge ${since.toISOString()}`)}&$orderby=createdon desc&$top=5`
  );
  return rows
    .filter((r) => r.profile && r.profile.trim())
    .map((r) => ({
      id: r.plugintracelogid,
      createdOn: r.createdon,
      typeName: r.typename ?? "",
      message: r.messagename ?? "",
      table: r.primaryentity ?? "",
      exception: r.exceptiondetails ?? "",
      profile: r.profile!,
    }));
}

/** AccountPlugin.Update.account.20261023-141500.profile */
export function profileFileName(capture: ProfileCapture, when = new Date(capture.createdOn)): string {
  const stamp = when.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const short = (capture.typeName.split(",")[0].split(".").pop() || "plugin").replace(/[^\w-]/g, "");
  return [short, capture.message, capture.table, stamp].filter(Boolean).join(".") + ".profile";
}

/**
 * The Plugin Registration Tool, when pac or NuGet has put it on this machine
 * (~/.nuget/packages/microsoft.crmsdk.xrmtooling.pluginregistrationtool/<version>/tools/net48/).
 * The newest version wins.
 */
export function findPluginRegistrationTool(home = os.homedir()): string | undefined {
  const root = path.join(home, ".nuget", "packages", "microsoft.crmsdk.xrmtooling.pluginregistrationtool");
  if (!fs.existsSync(root)) return undefined;
  const versions = fs
    .readdirSync(root)
    .filter((v) => /^\d/.test(v))
    .sort((a, b) => compareVersions(b, a));
  for (const v of versions) {
    for (const sub of ["tools/net48", "tools"]) {
      const exe = path.join(root, v, sub, "PluginRegistration.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** The VS Code debug configuration that attaches to the tool while it replays (the C# extension's .NET Framework debugger). */
export const ATTACH_CONFIGURATION = {
  name: "Lantern: attach to Plugin Registration Tool (replay)",
  type: "clr",
  request: "attach",
  processName: "PluginRegistration",
};

/**
 * launch.json with the attach configuration added, or unchanged when it's there. launch.json
 * allows comments and trailing commas, which are kept out of the way while parsing; a file
 * that still can't be read comes back undefined, so the caller shows the snippet instead.
 * The configuration goes in as text at the top of the "configurations" list, so the file's
 * comments (often configurations commented out to keep) and formatting stay as they were.
 */
export function withAttachConfiguration(launchJson: string | undefined): string | undefined {
  if (!launchJson || !launchJson.trim()) {
    return JSON.stringify({ version: "0.2.0", configurations: [ATTACH_CONFIGURATION] }, null, 2) + "\n";
  }
  let parsed: { version?: string; configurations?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(stripJsonc(launchJson));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const configurations = Array.isArray(parsed.configurations) ? parsed.configurations : [];
  if (configurations.some((c) => c.name === ATTACH_CONFIGURATION.name || (c.type === "clr" && c.request === "attach" && c.processName === "PluginRegistration"))) return launchJson;
  const eol = launchJson.includes("\r\n") ? "\r\n" : "\n";
  const list = Array.isArray(parsed.configurations) ? configurationsList(launchJson) : undefined;
  if (list) {
    const lineStart = launchJson.lastIndexOf("\n", list.start - 1) + 1;
    const outer = /^[ \t]*/.exec(launchJson.slice(lineStart))![0];
    const unit = outer || "  ";
    const entry = eol + outer + unit + JSON.stringify(ATTACH_CONFIGURATION, null, unit).replace(/\n/g, eol + outer + unit);
    if (!list.empty) return launchJson.slice(0, list.start) + entry + "," + launchJson.slice(list.start);
    // An empty list: the "]" goes on a line of its own, or stays after the comments in it.
    const inside = launchJson.slice(list.start, list.end);
    return launchJson.slice(0, list.start) + entry + (inside.trim() ? inside : eol + outer) + launchJson.slice(list.end);
  }
  const out = JSON.stringify({ ...parsed, version: parsed.version ?? "0.2.0", configurations: [...configurations, ATTACH_CONFIGURATION] }, null, 2);
  return out.replace(/\n/g, eol) + eol;
}

/**
 * Where the top-level "configurations" array's items are: just after its "[" to its "]", and
 * whether it has any (comments don't count). Strings and comments are skipped while scanning.
 * Only called on text that parses, so the last string before a "[" one level in is its key.
 */
function configurationsList(text: string): { start: number; end: number; empty: boolean } | undefined {
  let depth = 0;
  let key = "";
  let start = -1;
  let empty = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (start >= 0 && depth === 2 && ch !== "]" && !/\s/.test(ch)) empty = false;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1) key = text.slice(i + 1, j);
      i = j;
    } else if (ch === "{" || ch === "[") {
      if (ch === "[" && depth === 1 && key === "configurations") start = i + 1;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (start >= 0 && depth === 1) return { start, end: i, empty };
    }
  }
  return undefined;
}

/** JSON with comments and trailing commas (what VS Code accepts in launch.json) reduced to plain JSON. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** What to do in the tool once the profile is saved, for the message and the output channel. */
export function replaySteps(o: { orgHost: string; profile: string; dll?: string; launchJson: string | undefined }): string[] {
  return [
    `1. In the Plugin Registration Tool, connect to ${o.orgHost}, then choose Replay Plug-in Execution.`,
    `2. Profile: ${o.profile}`,
    `3. Assembly: ${o.dll ?? "your plug-in's Debug build (bin/Debug/<framework>/<assembly>.dll)"}`,
    `4. In VS Code, set breakpoints in the plug-in class and start "${ATTACH_CONFIGURATION.name}"${o.launchJson ? ` (in ${o.launchJson})` : " (add the configuration to launch.json first)"}.`,
    "5. Back in the tool, Start Plug-in Execution. The replay runs your DLL with the recorded context and stops at your breakpoints.",
  ];
}
