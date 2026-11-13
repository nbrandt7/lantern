import * as vscode from "vscode";
import { Client, normalizeOrg } from "../core/clients";
import { compareEnvironments, comparisonMarkdown } from "../core/compare";
import { MetadataService } from "../core/metadata";
import { COMMON_ENVIRONMENT_NAMES, discoverEnvironments, discoveryHost, suggestEnvironmentName } from "../core/discovery";
import { dataverseFor, discoveryToken, forgetSignIn } from "../ui/auth";
import { EnvironmentPanelState, openEnvironmentPanel } from "../ui/panels/environmentPanel";
import { reportError, resolveClient, withProgress, write } from "../ui/context";
import { TableDocProvider } from "./metadata";
import { DataverseContentProvider } from "./webResources";

export function registerEnvironmentCommands(
  serviceFor: (c: Client) => MetadataService,
  docs: TableDocProvider,
  remote: DataverseContentProvider,
  onChanged: () => void
): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        reportError(err);
      }
    });

  return [
    r("lantern.environments.switch", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client) return;
      if (!client.environments.length) {
        await addEnvironment(client);
        onChanged();
        return;
      }
      const items: Array<vscode.QuickPickItem & { env?: string; add?: boolean }> = client.environments.map((e) => ({
        label: e.name,
        description: [hostOf(e.org), e.protected ? "protected" : "", e.name === client.envName ? "current" : ""].filter(Boolean).join(", "),
        env: e.name,
      }));
      items.push({ label: "$(add) Add Environment…", add: true });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `${client.name} is on ${client.envName}. Switch to…` });
      if (!pick) return;
      if (pick.add) await addEnvironment(client);
      else if (pick.env && pick.env !== client.envName) {
        client.selectEnvironment(pick.env);
        forgetSignIn(client);
        vscode.window.setStatusBarMessage(`$(server-environment) ${client.name} is on ${client.envName} (${client.orgHost})`, 5000);
      }
      onChanged();
    }),

    r("lantern.environments.add", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client) return;
      await addEnvironment(client);
      onChanged();
    }),

    r("lantern.environments.compare", async (arg?: unknown) => {
      const node = arg as { client?: Client; unique?: string } | undefined;
      const client = await resolveClient(arg);
      if (!client) return;
      if (client.environments.length < 2) {
        const add = await vscode.window.showInformationMessage(`${client.name} has ${client.environments.length ? "one environment" : "no environments"}. Add another to compare them.`, "Add Environment");
        if (add) {
          await addEnvironment(client);
          onChanged();
        }
        return;
      }
      const solution =
        node?.unique ??
        (client.config.solutions.length === 1
          ? client.config.solutions[0]
          : await vscode.window.showQuickPick(client.config.solutions, { placeHolder: "Compare which solution?" }));
      if (!solution) return;
      const other = await vscode.window.showQuickPick(
        client.environments.filter((e) => e.name !== client.envName).map((e) => ({ label: e.name, description: hostOf(e.org) })),
        { placeHolder: `Compare ${solution} in ${client.envName} with…` }
      );
      if (!other) return;
      const a = client;
      const b = client.withEnvironment(other.label);
      const result = await withProgress(`Comparing ${solution}: ${a.envName} vs ${b.envName}`, (_ctx, progress) =>
        compareEnvironments(
          { label: a.envName, dv: dataverseFor(a), service: serviceFor(a) },
          { label: b.envName, dv: dataverseFor(b), service: serviceFor(b) },
          solution,
          (message) => progress.report({ message })
        )
      );
      if (!result) return;
      const uri = vscode.Uri.from({ scheme: TableDocProvider.scheme, path: `/${client.name}/compare-${solution}-${a.envName}-${b.envName}.md` });
      docs.set(uri, comparisonMarkdown(result));
      try {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
      } catch {
        await vscode.window.showTextDocument(uri, { preview: true });
      }
      if (!result.webResourceContents.size) return;
      const choice = await vscode.window.showInformationMessage(
        `${result.webResourceContents.size} web resource${result.webResourceContents.size === 1 ? "" : "s"} differ between ${a.envName} and ${b.envName}.`,
        "Diff Web Resources"
      );
      if (!choice) return;
      const names = [...result.webResourceContents.keys()];
      const name = names.length === 1 ? names[0] : await vscode.window.showQuickPick(names, { placeHolder: "Diff which web resource?" });
      if (!name) return;
      const contents = result.webResourceContents.get(name)!;
      const file = /\.[a-z]+$/i.test(name) ? name : `${name}.js`;
      const left = vscode.Uri.from({ scheme: DataverseContentProvider.scheme, path: `/${client.name}/${a.envName}/${file}` });
      const right = vscode.Uri.from({ scheme: DataverseContentProvider.scheme, path: `/${client.name}/${b.envName}/${file}` });
      remote.set(left, contents.a);
      remote.set(right, contents.b);
      await vscode.commands.executeCommand("vscode.diff", left, right, `${name}: ${a.envName} ↔ ${b.envName}`);
    }),
  ];
}

function hostOf(org: string): string {
  try {
    return new URL(org).host;
  } catch {
    return org;
  }
}

/**
 * Adds an environment, from one page (src/ui/panels/environmentPanel.ts): the
 * environments the account can open (Global Discovery Service) on the left, the
 * name, org URL and protection on the right. A client with a single org first
 * gets that org named on the same page, so it becomes one of the environments
 * instead of being replaced.
 */
async function addEnvironment(client: Client): Promise<void> {
  client.reload();
  const c = client.config;
  const known = new Set(c.environments.map((e) => hostOf(e.org).toLowerCase()));
  if (!c.environments.length && c.org) known.add(client.orgHost.toLowerCase());
  const resource = discoveryHost(client.config.org);
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Finding the environments you can open…" }, async () => {
    try {
      const token = await discoveryToken(client, resource);
      return token ? await discoverEnvironments(resource, token) : undefined;
    } catch (err) {
      write(`Couldn't list environments from ${resource}: ${err instanceof Error ? err.message : String(err)}
`);
      return undefined;
    }
  });
  const candidates = (found ?? []).filter((e) => !known.has(hostOf(e.url).toLowerCase()));
  const urlName = client.orgHost.split(".")[0];
  const current = !c.environments.length && c.org ? { host: client.orgHost, suggested: suggestEnvironmentName(urlName), from: urlName } : undefined;
  const state: EnvironmentPanelState = {
    subtitle: `${client.name}${c.environments.length ? ` has ${c.environments.map((e) => e.name).join(", ")}` : current ? ` uses ${client.orgHost}` : ""}`,
    client: client.name,
    current,
    found: candidates.map((e) => ({
      id: normalizeOrg(e.url),
      label: e.friendlyName,
      host: hostOf(e.url),
      meta: [e.region, e.version ? `version ${e.version}` : ""].filter(Boolean).join(" · "),
      disabled: e.state !== 0,
      suggested: suggestEnvironmentName(e.friendlyName, e.uniqueName, e.urlName),
    })),
    discoveryFailed: found === undefined,
    taken: c.environments.map((e) => e.name),
    names: COMMON_ENVIRONMENT_NAMES,
    draft: { currentName: current?.suggested ?? "", source: candidates.length ? "" : "custom", url: "", name: "", protected: false, nameAuto: true, protectedAuto: true },
  };
  if (!current) delete state.draft.currentName;
  const result = await openEnvironmentPanel(state, [...known]);
  if (!result) return;
  // Re-read before writing: anything that reloaded the client while the page was open (a refresh,
  // a connection check) replaced client.config, so edits to the old object would never be saved.
  client.reload();
  const cfg = client.config;
  const currentName = result.currentName?.trim();
  if (current && currentName && !cfg.environments.some((e) => e.name === currentName)) {
    cfg.environments.push({ name: currentName, org: cfg.org });
    cfg.environment = currentName;
  }
  const org = normalizeOrg(result.url.trim());
  const name = result.name.trim();
  cfg.environments.push({ name, org, ...(result.protected ? { protected: true } : {}) });
  if (!cfg.environment) cfg.environment = cfg.environments[0].name;
  client.save();
  if (!client.environments.some((e) => e.name === name)) throw new Error(`${name} wasn't saved to ${client.configFile}.`);
  void vscode.window.showInformationMessage(`Added ${name} to ${client.name}. Switch environments from the Tenant view or the status bar.`);
}
