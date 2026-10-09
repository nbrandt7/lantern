import * as vscode from "vscode";
import { Client, normalizeOrg } from "../core/clients";
import { compareEnvironments, comparisonMarkdown } from "../core/compare";
import { MetadataService } from "../core/metadata";
import { dataverseFor, forgetSignIn } from "../ui/auth";
import { reportError, resolveClient, withProgress } from "../ui/context";
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
        client.config.environment = pick.env;
        client.save();
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
      const client = node?.client ?? (await resolveClient(arg));
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
 * Adds an environment. A client with a single org first gets that org named (DEV by
 * default), so it becomes one of the environments instead of being replaced.
 */
async function addEnvironment(client: Client): Promise<void> {
  client.reload();
  const c = client.config;
  if (!c.environments.length && c.org) {
    const first = await vscode.window.showInputBox({
      title: `Name the current org (${client.orgHost})`,
      prompt: "Environments are named like DEV, TEST, UAT, PROD",
      value: "DEV",
      ignoreFocusOut: true,
    });
    if (!first) return;
    c.environments.push({ name: first.trim(), org: c.org });
    c.environment = first.trim();
  }
  const name = await vscode.window.showInputBox({
    title: "New environment: name",
    prompt: "Like TEST, UAT, or PROD",
    ignoreFocusOut: true,
    validateInput: (v: string) => (!v.trim() ? "Enter a name." : c.environments.some((e) => e.name.toLowerCase() === v.trim().toLowerCase()) ? "That name is taken." : undefined),
  });
  if (!name) return;
  const org = await vscode.window.showInputBox({
    title: `New environment: ${name.trim()} org URL`,
    placeHolder: "https://contoso-test.crm.dynamics.com",
    ignoreFocusOut: true,
    validateInput: (v: string) => (/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}/i.test(v.trim()) ? undefined : "Enter the org URL."),
  });
  if (!org) return;
  const looksProd = /prod|live/i.test(name);
  const protect = await vscode.window.showQuickPick(
    [
      { label: "Ask before changes", description: "Confirm before pushes, imports, publishing, and data changes", value: true },
      { label: "No extra confirmation", value: false },
    ].sort((x, y) => (looksProd ? Number(y.value) - Number(x.value) : Number(x.value) - Number(y.value))),
    { placeHolder: `Protect ${name.trim()}?` }
  );
  if (!protect) return;
  c.environments.push({ name: name.trim(), org: normalizeOrg(org), ...(protect.value ? { protected: true } : {}) });
  if (!c.environment) c.environment = c.environments[0].name;
  client.save();
  void vscode.window.showInformationMessage(`Added ${name.trim()} to ${client.name}. Switch environments from the status bar or the client's menu.`);
}
