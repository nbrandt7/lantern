import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_JOB_FILTER, EnvVarInfo, fetchSolutionWebResources, SolutionWebResource, fetchEnvironment, fetchEnvVars, fetchJobs, fetchSteps, JobFilter, JobInfo, StepInfo } from "../core/admin";
import { Client } from "../core/clients";
import { fetchSolutionFlows, SolutionFlow } from "../core/flows";
import { currentBranch } from "../core/git";
import { HistoryEntry, QueryHistory } from "../core/history";
import { findPagesSites, findPcfControls, PcfControl } from "../commands/pcfPages";
import * as fs from "fs";
import { MetadataService, TableMeta } from "../core/metadata";
import { findPluginProjects, findSolutionFolders, PluginProject, solutionNameOf } from "../core/solutions";
import { RegisteredAssembly } from "../core/pluginRegistration";
import { assembliesWithoutProjects, ClassStatus, forgetOrgPlugins, orgPlugins, projectStatus } from "../core/pluginStatus";
import { projectPluginClasses } from "../core/csharp";
import { accountInUse, dataverseFor } from "./auth";
import { scanAll } from "./context";
import { MetaNode, MetadataTree } from "./metadataTree";
import { TraceNode, TraceTree } from "./traceTree";

export type Section = "tables" | "steps" | "traces" | "jobs" | "envvars" | "environment";

export type LocalNode =
  | { kind: "client"; client: Client; branch: string }
  | { kind: "unconfigured"; dir: string }
  /** "plugins" holds Projects ("pluginProjects"), Steps and Traces. */
  | { kind: "group"; client: Client; group: "solutions" | "plugins" | "pluginProjects" | "queries" | "pcf" | "pages" }
  | { kind: "pcfControl"; client: Client; control: PcfControl }
  | { kind: "pagesSite"; client: Client; dir: string }
  | { kind: "savedQuery"; client: Client; file: string }
  | { kind: "recentQueries"; client: Client }
  | { kind: "recentQuery"; client: Client; entry: HistoryEntry }
  /** A solution: listed in .lantern/config.json, pulled into the folder, or both. */
  | { kind: "solution"; client: Client; unique: string; folder?: string; configured: boolean }
  | { kind: "solutionPart"; client: Client; unique: string; part: "tables" | "webresources" | "flows" }
  | { kind: "flow"; client: Client; unique: string; flow: SolutionFlow }
  | { kind: "webResource"; client: Client; unique: string; resource: SolutionWebResource }
  | { kind: "plugin"; client: Client; plugin: PluginProject }
  | { kind: "hint"; client: Client; text: string; command?: vscode.Command; icon?: string; tooltip?: string }
  /** A plug-in class: in your code, registered in the active environment, or both. */
  | { kind: "pluginClass"; client: Client; plugin?: PluginProject; assembly: string; typeName: string; status: ClassStatus; assemblyRegistered: boolean; remote?: boolean }
  /** A registered assembly with no project in the client folder. */
  | { kind: "remoteAssembly"; client: Client; assembly: RegisteredAssembly }
  | { kind: "section"; client: Client; section: Section }
  | { kind: "stepAssembly"; client: Client; assembly: string; steps: StepInfo[] }
  | { kind: "step"; client: Client; step: StepInfo }
  | { kind: "job"; client: Client; job: JobInfo }
  | { kind: "envvar"; client: Client; variable: EnvVarInfo }
  | { kind: "envDetail"; client: Client; label: string; value: string; icon: string; link?: string; children?: string[]; commandId?: string };

export type TreeNode = LocalNode | MetaNode | TraceNode;

const META_KINDS = new Set(["tableGroup", "table", "columns", "column", "option", "forms", "form", "events", "event", "handler", "header", "tab", "control"]);
/** Metadata nodes are drawn by MetadataTree. A form section ("section" with a tab) is metadata; a client section isn't. */
const isMeta = (n: TreeNode): n is MetaNode => META_KINDS.has(n.kind) || (n.kind === "section" && "tab" in n);

/** Steps and traces sit under Plug-ins; the rest directly under the client. */
const PLUGIN_SECTIONS = new Set<Section>(["steps", "traces"]);

const SECTIONS: Record<Section, { label: string; icon: string }> = {
  tables: { label: "All tables", icon: "table" },
  steps: { label: "Steps", icon: "zap" },
  traces: { label: "Traces", icon: "pulse" },
  jobs: { label: "System jobs", icon: "server-process" },
  envvars: { label: "Environment variables", icon: "symbol-constant" },
  environment: { label: "Environment", icon: "info" },
};

/**
 * One tree for everything about a client: its local folder (solutions, plug-in
 * projects) and its Dataverse org (tables, plug-in steps, traces, system jobs,
 * environment variables, environment details). Org sections load when expanded.
 */
export class WorkspaceTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  jobFilter: JobFilter = { ...DEFAULT_JOB_FILTER };
  /** Section nodes keep their identity across refreshes so a single section can be reloaded. */
  private readonly sections = new Map<string, Extract<LocalNode, { kind: "section" }>>();
  /** Loaded section contents. Kept until that section is refreshed, so redrawing the tree never refetches. */
  private readonly loaded = new Map<string, TreeNode[]>();
  /**
   * The same object for the same node across refreshes (clients, groups, plug-in projects and
   * classes), with its parent, so the view can reveal a node (TreeView.reveal goes by identity).
   */
  private readonly stable = new Map<string, TreeNode>();
  private readonly parents = new WeakMap<object, TreeNode>();

  private keep<T extends TreeNode>(key: string, node: T, parent?: TreeNode): T {
    const prior = this.stable.get(key);
    const out = (prior && prior.kind === node.kind ? Object.assign(prior, node) : node) as T;
    this.stable.set(key, out);
    if (parent) this.parents.set(out, parent);
    return out;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.parents.get(node);
  }

  constructor(
    private readonly serviceFor: (c: Client) => MetadataService,
    readonly metadata: MetadataTree,
    readonly traces: TraceTree,
    private readonly history?: QueryHistory
  ) {
    traces.onRefresh = () => this.reloadSections("traces");
    metadata.onDidChangeTreeData((n) => this.changed.fire(n));
  }

  /** Redraws the tree, or reloads one node (a section reloads from Dataverse). */
  refresh(node?: TreeNode): void {
    if (!node) for (const key of this.loaded.keys()) if (key.includes("|flows|")) this.loaded.delete(key);
    if (node && node.kind === "section" && !("tab" in node)) this.loaded.delete(sectionKey(node.client, node.section));
    if (node && (node.kind === "solution" || node.kind === "solutionPart")) {
      this.loaded.delete(`${clientKey(node.client)}|webresources|${node.unique.toLowerCase()}`);
      this.loaded.delete(`${clientKey(node.client)}|flows|${node.unique.toLowerCase()}`);
      this.serviceFor(node.client).forget("solution-tables/");
    }
    if (node && node.kind === "client") for (const k of [...this.loaded.keys()]) if (k.startsWith(`${node.client.name}@`)) this.loaded.delete(k);
    if (node && (node.kind === "client" || node.kind === "plugin" || node.kind === "remoteAssembly" || (node.kind === "group" && (node.group === "plugins" || node.group === "pluginProjects")))) forgetOrgPlugins(node.client);
    this.changed.fire(node);
  }

  /** Reloads one kind of section for every client (after its filter changes). */
  reloadSections(section: Section): void {
    for (const node of this.sections.values()) {
      if (node.section !== section) continue;
      this.loaded.delete(sectionKey(node.client, section));
      this.changed.fire(node);
    }
  }

  private sectionNode(client: Client, section: Section): Extract<LocalNode, { kind: "section" }> {
    const key = `${client.name}|${section}`;
    let node = this.sections.get(key);
    if (!node) {
      node = { kind: "section", client, section };
      this.sections.set(key, node);
    }
    node.client = client;
    return node;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const { clients, unconfigured } = scanAll();
      const nodes: TreeNode[] = [];
      for (const client of clients) nodes.push(this.keep(`client|${client.name}`, { kind: "client", client, branch: await currentBranch(client.dir) }));
      for (const dir of unconfigured) nodes.push({ kind: "unconfigured", dir });
      return nodes;
    }
    if (isMeta(node)) return this.metadata.getChildren(node);
    try {
      return await this.children(node as LocalNode | TraceNode);
    } catch (err) {
      return [{
        kind: "message",
        text: `Couldn't load: ${err instanceof Error ? err.message : String(err)}`,
        icon: "error",
        command: { command: "lantern.refreshNode", title: "Retry", arguments: [node] },
      } as TraceNode];
    }
  }

  private async children(node: LocalNode | TraceNode): Promise<TreeNode[]> {
    switch (node.kind) {
      case "client": {
        const c = node.client;
        const out: TreeNode[] = [];
        if (!c.config.org) {
          out.push({
            kind: "hint",
            client: c,
            text: "Set the org URL in .lantern/config.json to connect",
            command: { command: "lantern.openClientConfig", title: "Edit .lantern/config.json", arguments: [c] },
          });
        }
        const group = (g: Extract<LocalNode, { kind: "group" }>["group"]) => this.keep(`${c.name}|group|${g}`, { kind: "group", client: c, group: g }, node);
        out.push(group("solutions"));
        if (c.config.org || findPluginProjects(c.dir).length) out.push(group("plugins"));
        if (findPcfControls(c.dir).length) out.push(group("pcf"));
        if (findPagesSites(c.dir).length) out.push(group("pages"));
        if (c.config.org) out.push(group("queries"));
        if (c.config.org) {
          for (const section of Object.keys(SECTIONS) as Section[]) if (!PLUGIN_SECTIONS.has(section)) out.push(this.sectionNode(c, section));
        }
        return out;
      }
      case "group": {
        if (node.group === "plugins") {
          // Everything plug-in in one place: your projects (matched to what's registered), then the org's steps and traces.
          const c = node.client;
          const out: TreeNode[] = [this.keep(`${c.name}|group|pluginProjects`, { kind: "group", client: c, group: "pluginProjects" }, node)];
          if (c.config.org) {
            for (const section of PLUGIN_SECTIONS) {
              const sectionNode = this.sectionNode(c, section);
              this.parents.set(sectionNode, node);
              out.push(sectionNode);
            }
          }
          return out;
        }
        if (node.group === "pluginProjects") return this.pluginGroup(node.client, node);
        if (node.group === "pcf") return findPcfControls(node.client.dir).map((control) => ({ kind: "pcfControl", client: node.client, control }));
        if (node.group === "pages") return findPagesSites(node.client.dir).map((dir) => ({ kind: "pagesSite", client: node.client, dir }));
        if (node.group === "queries") {
          const dir = path.join(node.client.dir, "queries");
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(sql|xml)$/i.test(f)).sort() : [];
          const out: TreeNode[] = files.map((f) => ({ kind: "savedQuery", client: node.client, file: path.join(dir, f) }));
          if (this.history?.list(node.client.name).length) out.push({ kind: "recentQueries", client: node.client });
          if (!out.length) return [{ kind: "hint", client: node.client, text: "Run a query, then Save Query to keep it here" }];
          return out;
        }
        return this.solutions(node.client);
      }
      case "solution": {
        if (!node.client.config.org) return [];
        return [
          { kind: "solutionPart", client: node.client, unique: node.unique, part: "tables" },
          { kind: "solutionPart", client: node.client, unique: node.unique, part: "webresources" },
          { kind: "solutionPart", client: node.client, unique: node.unique, part: "flows" },
        ];
      }
      case "solutionPart": {
        const c = node.client;
        if (node.part === "flows") {
          const key = `${clientKey(c)}|flows|${node.unique.toLowerCase()}`;
          const hit = this.loaded.get(key);
          if (hit) return hit;
          const flows = await fetchSolutionFlows(dataverseFor(c), node.unique);
          const list: TreeNode[] = flows.length
            ? flows.map((flow) => ({ kind: "flow", client: c, unique: node.unique, flow }))
            : [message("No Power Automate flows in this solution")];
          this.loaded.set(key, list);
          return list;
        }
        if (node.part === "tables") {
          const svc = this.serviceFor(c);
          const [tables, inSolution] = await Promise.all([svc.tables(), svc.solutionTables([node.unique])]);
          const own = new Set(inSolution);
          const list = tables.filter((t) => own.has(t.logicalName)).map((table): MetaNode => ({ kind: "table", client: c, table }));
          return list.length ? list : [message("No tables in this solution")];
        }
        const key = `${clientKey(c)}|webresources|${node.unique.toLowerCase()}`;
        const hit = this.loaded.get(key);
        if (hit) return hit;
        const resources = await fetchSolutionWebResources(dataverseFor(c), node.unique);
        const list: TreeNode[] = resources.length
          ? resources.map((resource) => ({ kind: "webResource", client: c, unique: node.unique, resource }))
          : [message("No web resources in this solution")];
        this.loaded.set(key, list);
        return list;
      }
      case "section": {
        // Tables come from the metadata cache already; the other sections are cached here.
        if (node.section === "tables") return this.sectionChildren(node.client, node.section);
        const key = sectionKey(node.client, node.section);
        const hit = this.loaded.get(key);
        if (hit) return hit;
        const fresh = await this.sectionChildren(node.client, node.section);
        this.loaded.set(key, fresh);
        return fresh;
      }
      case "stepAssembly":
        return node.steps.map((step) => ({ kind: "step", client: node.client, step }));
      case "plugin":
        return this.pluginClasses(node.client, node.plugin, node);
      case "pluginClass":
        return node.status.steps.map((step) => ({ kind: "step", client: node.client, step }));
      case "remoteAssembly": {
        const org = await orgPlugins(node.client, dataverseFor(node.client));
        const id = node.assembly.pluginassemblyid;
        return org.types
          .filter((t) => t._pluginassemblyid_value === id)
          .sort((a, b) => a.typename.localeCompare(b.typename))
          .map((type): TreeNode => this.keep(`${node.client.name}|remoteClass|${node.assembly.name}|${type.typename}`, {
            kind: "pluginClass",
            client: node.client,
            assembly: node.assembly.name,
            typeName: type.typename,
            assemblyRegistered: true,
            remote: true,
            status: {
              typeName: type.typename,
              type,
              kind: type.isworkflowactivity ? "workflow" : "plugin",
              steps: org.steps.filter((s) => s.assembly === node.assembly.name && s.typeName === type.typename),
            },
          }, node));
      }
      case "recentQueries":
        return (this.history?.list(node.client.name) ?? []).map((entry) => ({ kind: "recentQuery", client: node.client, entry }));
      case "envDetail":
        return (node.children ?? []).map((value) => ({ kind: "envDetail", client: node.client, label: value, value, icon: "shield" }));
      default:
        return [];
    }
  }

  /** Plug-in projects in the folder, then registered assemblies that have no project here. */
  private async pluginGroup(client: Client, parent: TreeNode): Promise<TreeNode[]> {
    const projects = findPluginProjects(client.dir);
    const out: TreeNode[] = projects.map((plugin) => this.keep(`${client.name}|project|${plugin.project}`, { kind: "plugin", client, plugin }, parent));
    if (client.config.org) {
      try {
        const org = await orgPlugins(client, dataverseFor(client));
        for (const assembly of assembliesWithoutProjects(org, projects)) {
          out.push(this.keep(`${client.name}|remote|${assembly.name.toLowerCase()}`, { kind: "remoteAssembly", client, assembly }, parent));
        }
      } catch (err) {
        out.push(message(`Couldn't load registered plug-ins: ${err instanceof Error ? err.message : String(err)}`, "error"));
      }
    }
    if (!out.length) {
      out.push({ kind: "hint", client, text: "No plug-ins yet", command: { command: "lantern.plugins.newProject", title: "New Plug-in Project", arguments: [client] } });
    }
    return out;
  }

  /** A project's plug-in classes, each matched to its registration in the active environment. */
  private async pluginClasses(client: Client, plugin: PluginProject, parent: TreeNode): Promise<TreeNode[]> {
    const classKey = (typeName: string) => `${client.name}|class|${plugin.project}|${typeName}`;
    if (!client.config.org) {
      return projectPluginClasses(plugin.project, client.dir).map((cls) => this.keep(classKey(cls.fullName), {
        kind: "pluginClass",
        client,
        plugin,
        assembly: plugin.assembly,
        typeName: cls.fullName,
        assemblyRegistered: false,
        status: { typeName: cls.fullName, cls, kind: cls.pluginKind, steps: [] },
      }, parent));
    }
    const org = await orgPlugins(client, dataverseFor(client));
    const st = projectStatus(client, plugin, org);
    const where = client.envName || client.orgHost;
    const head: TreeNode = st.registered
      ? {
          kind: "hint",
          client,
          icon: "cloud",
          text: `${st.registered.version} in ${where}${st.registered.ismanaged ? " (managed)" : ""}`,
          tooltip: [
            `${plugin.assembly} ${st.registered.version} is registered in ${where}. Your project builds ${st.localVersion}.`,
            st.registered.publickeytoken ? `Public key token ${st.registered.publickeytoken}` : "",
            st.others.length ? `Also registered: ${st.others.map((o) => o.version).join(", ")}` : "",
          ].filter(Boolean).join("\n"),
        }
      : {
          kind: "hint",
          client,
          icon: "cloud-upload",
          text: `Not registered in ${where} yet`,
          tooltip: "Build and Push registers the assembly and every plug-in class in it.",
          command: { command: "lantern.pushPlugin", title: "Build and Push", arguments: [{ client, plugin }] },
        };
    const classes: TreeNode[] = st.classes.map((status) => this.keep(classKey(status.typeName), {
      kind: "pluginClass",
      client,
      plugin,
      assembly: plugin.assembly,
      typeName: status.typeName,
      status,
      assemblyRegistered: !!st.registered,
    }, parent));
    return [head, ...classes];
  }

  /**
   * The node to reveal for a plug-in class: the class under Plug-ins > Projects (its steps
   * underneath), or the Steps section when the class isn't in a project here. Walks the tree
   * the way the view would, so every node on the way is the same object the view holds.
   */
  async revealTarget(client: Client, typeName?: string): Promise<TreeNode | undefined> {
    const clientNode = (await this.getChildren()).find((n) => n.kind === "client" && n.client.name === client.name);
    if (!clientNode) return undefined;
    const plugins = (await this.getChildren(clientNode)).find((n) => n.kind === "group" && n.group === "plugins");
    if (!plugins) return undefined;
    const [projects, ...rest] = await this.getChildren(plugins);
    if (typeName) {
      for (const p of await this.getChildren(projects)) {
        if (p.kind !== "plugin" && p.kind !== "remoteAssembly") continue;
        const cls = (await this.getChildren(p)).find((n) => n.kind === "pluginClass" && n.typeName === typeName);
        if (cls) return cls;
      }
    }
    return rest.find((n) => n.kind === "section" && n.section === "steps");
  }

  /** Plug-in projects, their classes and registered plug-ins reload on next view. */
  reloadPlugins(): void {
    forgetOrgPlugins();
    this.changed.fire(undefined);
  }

  /**
   * The client's solutions: the ones listed in .lantern/config.json (pulled or not), then any
   * unpacked solution folders that aren't listed yet.
   */
  private solutions(client: Client): TreeNode[] {
    const folders = findSolutionFolders(client.dir).map((folder) => ({ folder, unique: solutionNameOf(folder) }));
    const listed: TreeNode[] = client.config.solutions.map((unique) => ({
      kind: "solution",
      client,
      unique,
      configured: true,
      folder: folders.find((f) => f.unique.toLowerCase() === unique.toLowerCase())?.folder,
    }));
    const extra: TreeNode[] = folders
      .filter((f) => !client.config.solutions.some((u) => u.toLowerCase() === f.unique.toLowerCase()))
      .map((f) => ({ kind: "solution", client, unique: f.unique, folder: f.folder, configured: false }));
    const all = [...listed, ...extra];
    if (all.length) return all;
    return [{
      kind: "hint",
      client,
      text: client.config.org ? "Add a solution to work with" : "Set the org URL, then add a solution",
      command: client.config.org ? { command: "lantern.solutions.add", title: "Add Solution", arguments: [client] } : undefined,
    }];
  }

  private async sectionChildren(client: Client, section: Section): Promise<TreeNode[]> {
    const dv = () => dataverseFor(client);
    switch (section) {
      case "tables": {
        // Every table in the org. A solution's own tables are under that solution.
        const tables = await this.serviceFor(client).tables();
        return tables.map((table: TableMeta): MetaNode => ({ kind: "table", client, table }));
      }
      case "traces":
        return this.traces.getChildren({ kind: "client", client });
      case "steps": {
        const steps = await fetchSteps(dv());
        if (!steps.length) return [message("No custom plug-in steps are registered")];
        const byAssembly = new Map<string, StepInfo[]>();
        for (const s of steps) byAssembly.set(s.assembly, [...(byAssembly.get(s.assembly) ?? []), s]);
        return [...byAssembly].map(([assembly, list]) => ({ kind: "stepAssembly", client, assembly, steps: list }));
      }
      case "jobs": {
        const jobs = await fetchJobs(dv(), this.jobFilter);
        if (!jobs.length) return [message(this.jobFilter.status === "failed" ? "No failed jobs in this time window" : "No jobs match the filter")];
        return jobs.map((job) => ({ kind: "job", client, job }));
      }
      case "envvars": {
        const vars = await fetchEnvVars(dv());
        if (!vars.length) return [message("No environment variables")];
        return vars.map((variable) => ({ kind: "envvar", client, variable }));
      }
      case "environment": {
        const e = await fetchEnvironment(dv());
        const d = (label: string, value: string, icon: string, link?: string): LocalNode => ({ kind: "envDetail", client, label, value, icon, link });
        const using = accountInUse(client);
        const out: LocalNode[] = [
          {
            kind: "envDetail",
            client,
            label: "Microsoft account",
            value: using ? `${using.account}${using.pinned ? "" : " (not pinned)"}` : "not pinned",
            icon: "key",
            commandId: "lantern.signInAs",
          },
          d("Dataverse user", e.userName ? `${e.userName} (${e.userEmail})` : e.userId, "account"),
          { kind: "envDetail", client, label: "Security roles", value: String(e.roles.length), icon: "shield", children: e.roles },
          d("Business unit", e.businessUnit, "organization"),
          d("Version", e.version, "versions"),
          d("Organization ID", e.organizationId, "key"),
          d("User ID", e.userId, "key"),
        ];
        if (e.environmentId) {
          out.push(
            d("Environment ID", e.environmentId, "key"),
            d("Open in Power Apps maker portal", "", "link-external", `https://make.powerapps.com/environments/${e.environmentId}/home`),
            d("Open in Power Platform admin center", "", "link-external", `https://admin.powerplatform.microsoft.com/environments/${e.environmentId}/hub`)
          );
        }
        out.push(d("Open the app", "", "link-external", `${client.config.org}/main.aspx`));
        return out;
      }
    }
  }

  getTreeItem(treeNode: TreeNode): vscode.TreeItem {
    if (isMeta(treeNode)) return this.metadata.getTreeItem(treeNode);
    // MetaNode also has "client" and "message" kinds, so narrow by hand rather than by the guard.
    const node = treeNode as LocalNode | TraceNode;
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case "client": {
        const c = node.client;
        const branch = "branch" in node ? node.branch : "";
        const item = new vscode.TreeItem(c.name, C.Collapsed);
        item.description = [c.envName, c.orgHost || "no org set", branch ? `⎇ ${branch}` : ""].filter(Boolean).join("  ");
        item.iconPath = new vscode.ThemeIcon(c.isRepo ? "repo" : "folder", c.isProtected ? new vscode.ThemeColor("charts.orange") : undefined);
        item.contextValue = c.config.org ? "client.connected" : "client";
        item.resourceUri = vscode.Uri.file(c.dir);
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${c.name}**\n\n`);
        md.appendMarkdown(`- Org: ${c.config.org || "_not set_"}${c.envName ? ` (${c.envName}${c.isProtected ? ", protected" : ""})` : ""}\n`);
        if (c.environments.length > 1) md.appendMarkdown(`- Environments: ${c.environments.map((e) => e.name).join(", ")}\n`);
        const using = c.config.org ? accountInUse(c) : undefined;
        if (c.config.org) md.appendMarkdown(`- Account: ${using ? `${using.account}${using.pinned ? "" : " (not pinned)"}` : "_not pinned; use Sign In As…_"}\n`);
        md.appendMarkdown(`- Repo: ${c.isRepo ? `yes${branch ? ` (${branch})` : ""}` : "none (local folder)"}\n`);
        md.appendMarkdown(`- Solutions: ${c.config.solutions.join(", ") || "_none listed_"}\n`);
        md.appendMarkdown(`- JS typings: ${c.typingMode === "xdt" ? "org-specific (XrmDefinitelyTyped)" : "generic (@types/xrm)"}\n`);
        item.tooltip = md;
        return item;
      }
      case "unconfigured": {
        const item = new vscode.TreeItem(path.basename(node.dir), C.None);
        item.description = "not configured";
        item.iconPath = new vscode.ThemeIcon("folder", new vscode.ThemeColor("disabledForeground"));
        item.contextValue = "unconfigured";
        item.resourceUri = vscode.Uri.file(node.dir);
        item.tooltip = "Folder without .lantern/config.json. Configure it to use it as a client.";
        return item;
      }
      case "group": {
        const label = { solutions: "Solutions", plugins: "Plug-ins", pluginProjects: "Projects", queries: "Queries", pcf: "PCF controls", pages: "Power Pages sites" }[node.group];
        const item = new vscode.TreeItem(label, C.Collapsed);
        item.iconPath = new vscode.ThemeIcon({ solutions: "package", plugins: "plug", pluginProjects: "project", queries: "database", pcf: "extensions", pages: "globe" }[node.group]);
        if (node.group === "plugins") item.tooltip = "Your plug-in projects, matched class by class to what's registered, and the org's plug-in steps and traces.";
        if (node.group === "pluginProjects") item.tooltip = "Plug-in projects in this folder, then registered assemblies that have no project here.";
        if (node.group === "pcf" || node.group === "pages") {
          item.contextValue = `group.${node.group}`;
          return item;
        }
        if (node.group === "queries") {
          item.contextValue = "group.queries";
          return item;
        }
        if (node.group === "solutions") {
          item.collapsibleState = C.Expanded;
          item.description = node.client.config.solutions.length ? undefined : "none yet";
          item.contextValue = node.client.config.org ? "group.solutions.connected" : "group.solutions";
        } else item.contextValue = `group.${node.group}`;
        return item;
      }
      case "solution": {
        const item = new vscode.TreeItem(node.unique, node.client.config.org ? C.Collapsed : C.None);
        const state = node.folder ? "pulled" : node.configured ? "not pulled yet" : "";
        item.description = [state, node.configured ? "" : "not in .lantern/config.json"].filter(Boolean).join(", ");
        item.iconPath = new vscode.ThemeIcon("package", node.configured ? undefined : new vscode.ThemeColor("disabledForeground"));
        item.contextValue = `solution.${node.configured ? "configured" : "local"}${node.folder ? ".pulled" : ""}`;
        item.tooltip = [
          node.unique,
          node.folder ? `Unpacked in ${path.relative(node.client.dir, node.folder) || "."}` : "Not in this folder yet. Pull to bring it down.",
          node.configured ? "" : 'Not listed in .lantern/config.json "solutions", so Pull won\'t sync it.',
        ].filter(Boolean).join("\n");
        if (node.folder) item.resourceUri = vscode.Uri.file(node.folder);
        return item;
      }
      case "pcfControl": {
        const item = new vscode.TreeItem(node.control.name, C.None);
        item.description = path.relative(node.client.dir, node.control.dir);
        item.iconPath = new vscode.ThemeIcon("extensions");
        item.contextValue = "pcfControl";
        item.resourceUri = vscode.Uri.file(node.control.dir);
        return item;
      }
      case "pagesSite": {
        const item = new vscode.TreeItem(path.basename(node.dir), C.None);
        item.iconPath = new vscode.ThemeIcon("globe");
        item.contextValue = "pagesSite";
        item.resourceUri = vscode.Uri.file(node.dir);
        item.command = { command: "revealInExplorer", title: "Reveal", arguments: [vscode.Uri.file(node.dir)] };
        return item;
      }
      case "savedQuery": {
        const item = new vscode.TreeItem(path.basename(node.file).replace(/\.(sql|xml)$/i, ""), C.None);
        item.description = path.extname(node.file).slice(1).toUpperCase();
        item.iconPath = new vscode.ThemeIcon("file-code");
        item.resourceUri = vscode.Uri.file(node.file);
        item.contextValue = "savedQuery";
        item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(node.file)] };
        return item;
      }
      case "recentQueries": {
        const item = new vscode.TreeItem("Recent", C.Collapsed);
        item.iconPath = new vscode.ThemeIcon("history");
        return item;
      }
      case "recentQuery": {
        const e = node.entry;
        const oneLine = e.sql.replace(/\s+/g, " ");
        const item = new vscode.TreeItem(oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine, C.None);
        item.description = [e.environment, `${e.rows} row${e.rows === 1 ? "" : "s"}`, relative(e.when)].filter(Boolean).join(", ");
        item.iconPath = new vscode.ThemeIcon("history");
        item.tooltip = e.sql;
        item.contextValue = "recentQuery";
        item.command = { command: "lantern.queries.openRecent", title: "Open", arguments: [node] };
        return item;
      }
      case "solutionPart": {
        const item = new vscode.TreeItem({ tables: "Tables", webresources: "Web resources", flows: "Power Automate flows" }[node.part], C.Collapsed);
        item.iconPath = new vscode.ThemeIcon({ tables: "table", webresources: "file-code", flows: "git-merge" }[node.part]);
        return item;
      }
      case "flow": {
        const item = new vscode.TreeItem(node.flow.name, C.None);
        item.description = node.flow.state === 1 ? "On" : node.flow.state === 0 ? "Off" : "Suspended";
        item.iconPath = new vscode.ThemeIcon("git-merge");
        item.contextValue = "flow";
        item.tooltip = `${node.flow.name}\n${node.flow.description}\nOpen the Power Automate designer inside VS Code.`;
        item.command = { command: "lantern.flows.open", title: "Open Flow", arguments: [node] };
        return item;
      }
      case "webResource": {
        const r = node.resource;
        const item = new vscode.TreeItem(r.name, C.None);
        item.description = r.displayName !== r.name ? r.displayName : undefined;
        item.iconPath = new vscode.ThemeIcon([1, 2, 4, 9, 11, 12].includes(r.type) ? "file-code" : r.type === 3 ? "symbol-method" : "file-media");
        item.contextValue = "webResource";
        item.tooltip = `${r.name}\nClick to open your local copy, or the version in Dataverse if you haven't pulled it.`;
        item.command = { command: "lantern.webResources.open", title: "Open", arguments: [node] };
        return item;
      }
      case "plugin": {
        const item = new vscode.TreeItem(node.plugin.assembly, C.Collapsed);
        item.description = path.relative(node.client.dir, path.dirname(node.plugin.project));
        item.iconPath = new vscode.ThemeIcon("symbol-method");
        item.contextValue = "plugin";
        item.resourceUri = vscode.Uri.file(node.plugin.project);
        item.tooltip = `${node.plugin.assembly}\n${path.relative(node.client.dir, node.plugin.project)}\nExpand to see each plug-in class and its registration.`;
        return item;
      }
      case "hint": {
        const item = new vscode.TreeItem(node.text, C.None);
        item.iconPath = new vscode.ThemeIcon(node.icon ?? "info");
        item.command = node.command;
        if (node.tooltip) item.tooltip = node.tooltip;
        return item;
      }
      case "pluginClass": {
        const st = node.status;
        const short = node.typeName.split(/[.+]/).pop() ?? node.typeName;
        const item = new vscode.TreeItem(short, st.steps.length ? C.Collapsed : C.None);
        const off = st.steps.filter((s) => !s.enabled).length;
        const where = node.client.envName || node.client.orgHost;
        let state: "registered" | "unregistered" | "orphan";
        if (st.type && st.cls) state = "registered";
        else if (st.type) state = "orphan";
        else state = "unregistered";
        if (node.remote) state = "registered";
        const stepText = st.steps.length ? `${st.steps.length} step${st.steps.length === 1 ? "" : "s"}${off ? `, ${off} off` : ""}` : st.kind === "workflow" ? "workflow activity" : "no steps";
        item.description =
          state === "orphan" ? `only in ${where}${st.steps.length ? `, ${stepText}` : ""}` :
          state === "unregistered" ? (node.assemblyRegistered ? "not registered yet" : st.kind === "workflow" ? "workflow activity" : "") :
          stepText;
        item.iconPath = state === "orphan"
          ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
          : new vscode.ThemeIcon(st.kind === "workflow" ? "symbol-event" : "symbol-class");
        item.contextValue = `pluginClass.${state}.${st.kind}`;
        item.tooltip = [
          node.typeName,
          state === "registered" && !node.remote ? `Registered in ${where}.` : "",
          state === "unregistered" && node.assemblyRegistered ? `In your code but not registered in ${where}. Build and Push registers it.` : "",
          state === "orphan" ? `Registered in ${where}, but your code doesn't have this class. Build and Push will offer to unregister it.` : "",
          st.cls ? path.relative(node.client.dir, st.cls.file) : "",
        ].filter(Boolean).join("\n");
        if (st.cls) {
          const at = new vscode.Range(st.cls.line, st.cls.column, st.cls.line, st.cls.column + short.length);
          item.command = { command: "vscode.open", title: "Open class", arguments: [vscode.Uri.file(st.cls.file), { selection: at, preview: true }] };
        }
        return item;
      }
      case "remoteAssembly": {
        const a = node.assembly;
        const item = new vscode.TreeItem(a.name, C.Collapsed);
        item.description = `${a.version} in ${node.client.envName || node.client.orgHost}, no project here`;
        item.iconPath = new vscode.ThemeIcon("cloud");
        item.contextValue = "remoteAssembly";
        item.tooltip = `${a.name} ${a.version} is registered in ${node.client.envName || node.client.orgHost}, but no project in ${node.client.name} builds it.${a.ismanaged ? " It came from a managed solution." : ""} Get Source decompiles it into a project here.`;
        return item;
      }
      case "section": {
        const meta = SECTIONS[node.section];
        const item = new vscode.TreeItem(meta.label, C.Collapsed);
        item.iconPath = new vscode.ThemeIcon(meta.icon);
        item.contextValue = `section.${node.section}`;
        if (node.section === "tables") item.tooltip = "Every table in the org. Your solutions' own tables are under Solutions.";
        if (node.section === "traces") item.description = this.traces.describe();
        if (node.section === "jobs") item.description = describeJobs(this.jobFilter);
        return item;
      }
      case "stepAssembly": {
        const off = node.steps.filter((s) => !s.enabled).length;
        const item = new vscode.TreeItem(node.assembly, C.Collapsed);
        item.description = `${node.steps.length} step${node.steps.length === 1 ? "" : "s"}${off ? `, ${off} off` : ""}`;
        item.iconPath = new vscode.ThemeIcon("library");
        item.contextValue = "stepAssembly";
        return item;
      }
      case "step": {
        const s = node.step;
        const item = new vscode.TreeItem(`${s.message}${s.table ? ` of ${s.table}` : ""}`, C.None);
        item.description = [s.typeName.split(".").pop(), s.stage, s.mode === "Asynchronous" ? "async" : "", s.enabled ? "" : "off"].filter(Boolean).join(", ");
        item.iconPath = new vscode.ThemeIcon(s.enabled ? "plug" : "circle-slash", s.enabled ? undefined : new vscode.ThemeColor("disabledForeground"));
        item.contextValue = s.enabled ? "step.enabled" : "step.disabled";
        item.tooltip = `${s.name}\n${s.typeName}\n${s.stage}, ${s.mode}, order ${s.rank}${s.filtering ? `\nRuns when these change: ${s.filtering}` : ""}`;
        item.command = { command: "lantern.steps.openCode", title: "Open plug-in class", arguments: [node] };
        return item;
      }
      case "job": {
        const j = node.job;
        const item = new vscode.TreeItem(j.name, C.None);
        item.description = `${j.type}, ${j.status}, ${relative(j.createdOn)}`;
        item.iconPath = new vscode.ThemeIcon(j.failed ? "error" : j.status === "Succeeded" ? "pass" : "loading", j.failed ? new vscode.ThemeColor("errorForeground") : undefined);
        item.contextValue = j.regarding ? "job.regarding" : "job";
        item.tooltip = `${j.name}\n${j.status}\n${j.message.split("\n")[0]}`;
        item.command = { command: "lantern.jobs.open", title: "Open job", arguments: [node] };
        return item;
      }
      case "envvar": {
        const v = node.variable;
        const item = new vscode.TreeItem(v.displayName, C.None);
        const current = v.value ?? (v.defaultValue ? `${v.defaultValue} (default)` : "(not set)");
        item.description = v.type === "Secret" ? "secret" : current;
        item.iconPath = new vscode.ThemeIcon("symbol-constant");
        item.contextValue = v.editable ? "envvar.editable" : "envvar";
        item.tooltip = `${v.schemaName} (${v.type})\nCurrent value: ${v.value ?? "none"}\nDefault: ${v.defaultValue || "none"}`;
        if (v.editable) item.command = { command: "lantern.envvars.edit", title: "Edit value", arguments: [node] };
        return item;
      }
      case "envDetail": {
        const item = new vscode.TreeItem(node.label, node.children?.length ? C.Collapsed : C.None);
        item.description = node.link ? undefined : node.value;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.contextValue = node.link ? "envDetail.link" : "envDetail";
        item.command = node.commandId
          ? { command: node.commandId, title: node.label, arguments: [node.client] }
          : node.link
          ? { command: "vscode.open", title: "Open", arguments: [vscode.Uri.parse(node.link)] }
          : node.children?.length
            ? undefined
            : { command: "lantern.copyText", title: "Copy", arguments: [node.value] };
        item.tooltip = node.commandId ? "Click to choose which account this client signs in with" : node.link ?? (node.children ? undefined : `${node.value}\nClick to copy`);
        return item;
      }
      case "trace":
        return this.traces.getTreeItem(node);
      case "message": {
        const item = new vscode.TreeItem(node.text, C.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.command = node.command;
        return item;
      }
    }
    return new vscode.TreeItem("?");
  }
}

/** Cached per client and org, so switching environments never shows the other org's data. */
const clientKey = (client: Client) => `${client.name}@${client.orgHost}`;
const sectionKey = (client: Client, section: Section) => `${clientKey(client)}|${section}`;

function message(text: string, icon = "info"): TraceNode {
  return { kind: "message", text, icon };
}

export function describeJobs(f: JobFilter): string {
  const status = f.status === "failed" ? "failed" : f.status === "active" ? "waiting or running" : "all";
  const time = f.hours ? `last ${f.hours === 1 ? "hour" : f.hours < 48 ? `${f.hours} hours` : `${f.hours / 24} days`}` : "any time";
  return `${status}, ${time}`;
}

function relative(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
