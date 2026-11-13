import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { fetchSteps, StepInfo } from "../core/admin";
import { Client, excludeLocally } from "../core/clients";
import { DataverseClient } from "../core/dataverse";
import { UserError } from "../core/errors";
import { ATTACH_CONFIGURATION, fetchProfiles, findPluginRegistrationTool, profileFileName, replaySteps, setStepProfiling, withAttachConfiguration } from "../core/pluginDebug";
import { projectForAssembly } from "../core/pluginStatus";
import { run } from "../core/process";
import { findBuildOutput, findPluginProjects } from "../core/solutions";
import { fetchTraceSetting, setTraceSetting } from "../core/traces";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, log, settings, withProgress, workspaceRoots } from "../ui/context";
import { stepFor } from "./editStep";

/**
 * Debug Plug-in Step: profiling on, trace logging to All, a Debug build, the attach
 * configuration in launch.json, then wait for the step to run, save its profile and open
 * the Plugin Registration Tool to replay it. Stop Profiling turns the flag off again.
 */

/** Tests shorten the wait between polls and keep the tool from opening. */
export const timing = { pollMs: 5000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
export const tooling = {
  find: (): string | undefined => findPluginRegistrationTool(),
  open(exe: string): void {
    spawn(exe, [], { detached: true, stdio: "ignore", cwd: path.dirname(exe) }).unref();
  },
  /** pac downloads the tool when it isn't on this machine yet, then opens it. */
  pac(): void {
    void run(settings().pacPath, ["tool", "prt"], { onOutput: (t) => log().append(t) });
  },
};

/** The trace setting an org had before Debug Plug-in Step turned it to All, so Stop Profiling can offer it back. */
const previousTraceSetting = new Map<string, number>();

const env = (c: Client) => c.envName || c.orgHost;
const label = (s: StepInfo) => `${s.message}${s.table ? ` of ${s.table}` : ""}`;

async function stepInfo(dv: DataverseClient, id: string): Promise<StepInfo> {
  const step = (await fetchSteps(dv)).find((s) => s.id === id);
  if (!step) throw new UserError("That step isn't registered any more.");
  return step;
}

/** The folder whose .vscode/launch.json gets the attach configuration: the workspace root holding the client. */
function launchJsonFor(client: Client): string {
  const root = workspaceRoots().find((r) => client.dir === r || client.dir.startsWith(r + path.sep)) ?? client.dir;
  return path.join(root, ".vscode", "launch.json");
}

export async function debugStep(arg: unknown, onChanged: () => void): Promise<void> {
  const target = await stepFor(arg);
  if (!target) return;
  const { client, id } = target;
  const dv = dataverseFor(client);
  const step = await withProgress(`Loading the step from ${env(client)}`, () => stepInfo(dv, id));
  if (!step) return;
  if (!(await confirmProtected(client, `turn profiling on for ${label(step)}`))) return;

  // Profiles are only written while trace logging is All.
  const trace = await withProgress("Checking plug-in trace logging", () => fetchTraceSetting(dv));
  if (!trace) return;
  if (trace.setting !== 2) {
    const turnOn = "Set to All";
    const choice = await vscode.window.showWarningMessage(
      `Plug-in trace logging in ${env(client)} is ${trace.setting === 1 ? "Exceptions only" : "Off"}. Profiles are only captured while it's All (every plug-in in the org then writes trace logs).`,
      { modal: true },
      turnOn
    );
    if (choice !== turnOn) return;
    await setTraceSetting(dv, trace.orgId, 2);
    previousTraceSetting.set(client.orgHost, trace.setting);
  }

  await withProgress(`Turning profiling on for ${label(step)}`, () => setStepProfiling(dv, id, true));
  onChanged();

  // A Debug build, so the replay has symbols for breakpoints.
  const project = projectForAssembly(findPluginProjects(client.dir), step.assembly);
  let dll: string | undefined;
  if (project) {
    const built = await withProgress(`Building ${project.assembly} (Debug)`, async (ctx) => {
      ctx.log(`> dotnet build ${path.relative(client.dir, project.project)} -c Debug\n`);
      const r = await run(settings().dotnetPath, ["build", project.project, "-c", "Debug"], { onOutput: ctx.log, token: ctx.token });
      if (r.missing) throw new UserError("The .NET SDK (dotnet) isn't installed or isn't on your PATH.");
      if (r.code !== 0) throw new UserError(`Build failed for ${project.assembly}. See the Lantern output for the compiler errors.`);
      // Wrapped: a DLL that isn't under bin/Debug is no reason to stop, but undefined would read as a failed build.
      return { output: findBuildOutput(project, "Debug", "Assembly") };
    });
    if (!built) return;
    // findBuildOutput falls back to the .nupkg, which the replay can't load.
    dll = built.output?.type === "Assembly" ? built.output.file : undefined;
    if (!dll) log().appendLine(`Couldn't find ${project.assembly}.dll under bin/Debug; pick the Debug build in the tool's replay dialog.`);
  } else {
    log().appendLine(`No project here builds ${step.assembly}; pick the assembly in the tool's replay dialog.`);
  }

  const launchJson = launchJsonFor(client);
  const current = fs.existsSync(launchJson) ? fs.readFileSync(launchJson, "utf8") : undefined;
  const updated = withAttachConfiguration(current);
  if (updated === undefined) {
    void vscode.window.showWarningMessage(`${path.relative(client.dir, launchJson) || launchJson} couldn't be read, so add this configuration yourself: ${JSON.stringify(ATTACH_CONFIGURATION)}`);
  } else if (updated !== current) {
    fs.mkdirSync(path.dirname(launchJson), { recursive: true });
    fs.writeFileSync(launchJson, updated);
  }

  // Now the step has to run.
  const since = new Date(Date.now() - 60_000);
  const capture = await withProgress(`Waiting for ${label(step)} to run in ${env(client)} — trigger it in the app`, async (ctx) => {
    for (;;) {
      const captures = await fetchProfiles(dv, id, since);
      if (captures.length) return captures[0];
      if (ctx.cancel.isCancellationRequested) return undefined;
      await timing.sleep(timing.pollMs);
      if (ctx.cancel.isCancellationRequested) return undefined;
    }
  });
  if (!capture) {
    void vscode.window.showInformationMessage(`Profiling stays on for ${label(step)}; run Debug Plug-in Step again to wait for a capture, or Stop Profiling to turn it off.`);
    return;
  }

  const profilesDir = path.join(client.dir, ".lantern", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  const profileFile = path.join(profilesDir, profileFileName(capture));
  fs.writeFileSync(profileFile, capture.profile);
  excludeLocally(client.dir);

  const tool = tooling.find();
  if (tool) tooling.open(tool);
  else tooling.pac();

  const steps = replaySteps({ orgHost: client.orgHost, profile: profileFile, dll, launchJson: updated === undefined ? undefined : launchJson });
  log().appendLine(`\nReplay ${label(step)}:\n${steps.join("\n")}\n`);
  const copy = "Copy Profile Path";
  const openLaunch = "Open launch.json";
  const stop = "Stop Profiling";
  const choice = await vscode.window.showInformationMessage(
    `Captured ${label(step)}${capture.exception ? " (it threw)" : ""} and saved the profile. ${tool ? "The Plugin Registration Tool is opening" : "Opening the Plugin Registration Tool with pac"}: connect to ${client.orgHost}, Replay Plug-in Execution with this profile and ${dll ? path.basename(dll) : "your Debug build"}, then attach from VS Code (F5, "${ATTACH_CONFIGURATION.name}") and Start Plug-in Execution. The steps are in the Lantern output.`,
    copy,
    openLaunch,
    stop
  );
  if (choice === copy) await vscode.env.clipboard.writeText(profileFile);
  else if (choice === openLaunch) await vscode.window.showTextDocument(vscode.Uri.file(launchJson));
  else if (choice === stop) await stopProfiling({ client, step: { id } }, onChanged);
}

export async function stopProfiling(arg: unknown, onChanged: () => void): Promise<void> {
  const target = await stepFor(arg);
  if (!target) return;
  const { client, id } = target;
  const dv = dataverseFor(client);
  if (!(await confirmProtected(client, "turn profiling off"))) return;
  const done = await withProgress("Turning profiling off", async () => {
    await setStepProfiling(dv, id, false);
    return true;
  });
  if (!done) return;
  onChanged();
  const before = previousTraceSetting.get(client.orgHost);
  if (before === undefined) {
    void vscode.window.showInformationMessage(`Profiling is off. Plug-in trace logging in ${env(client)} is still All; change it from the Traces filter if you turned it on for this.`);
    return;
  }
  const restore = `Set back to ${before === 1 ? "Exceptions" : "Off"}`;
  const choice = await vscode.window.showInformationMessage(`Profiling is off. Debug Plug-in Step set plug-in trace logging in ${env(client)} to All.`, restore);
  if (choice === restore) {
    const trace = await fetchTraceSetting(dv);
    await setTraceSetting(dv, trace.orgId, before as 0 | 1 | 2);
    previousTraceSetting.delete(client.orgHost);
  }
}

export function registerDebugStep(onChanged: () => void): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("lantern.steps.debug", (arg: unknown) => debugStep(arg, onChanged)),
    vscode.commands.registerCommand("lantern.steps.stopProfiling", (arg: unknown) => stopProfiling(arg, onChanged)),
  ];
}
