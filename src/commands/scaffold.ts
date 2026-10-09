import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Client } from "../core/clients";
import { findFiles } from "../core/files";
import { outlineJs } from "../core/codeanalysis";
import { ensureAuth, pluginInit, solutionImport, solutionPack } from "../core/pac";
import { findPluginProjects, PluginProject } from "../core/solutions";
import { confirmProtected, reportError, resolveClient, withProgress } from "../ui/context";

const r = (id: string, fn: (...args: any[]) => unknown) =>
  vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      reportError(err);
    }
  });

/** RootNamespace (or AssemblyName, or the file name) of a C# project. */
export function projectNamespace(csproj: string): string {
  const text = fs.readFileSync(csproj, "utf8");
  return /<RootNamespace>([^<]+)<\/RootNamespace>/.exec(text)?.[1] ?? /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(text)?.[1] ?? path.basename(csproj, ".csproj");
}

export type ClassKind = "plugin" | "workflow" | "customapi";

/** C# source for a new class. Uses the project's PluginBase (from pac plugin init) when it has one. */
export function classTemplate(kind: ClassKind, ns: string, name: string, usesPluginBase: boolean): string {
  if (kind === "workflow") {
    return `using System.Activities;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Workflow;

namespace ${ns}
{
    /// <summary>Custom workflow activity. Build and Push Plug-in registers it as a workflow activity.</summary>
    public class ${name} : CodeActivity
    {
        [Input("Text")]
        public InArgument<string> Text { get; set; }

        [Output("Result")]
        public OutArgument<string> Result { get; set; }

        protected override void Execute(CodeActivityContext executionContext)
        {
            var context = executionContext.GetExtension<IWorkflowContext>();
            var factory = executionContext.GetExtension<IOrganizationServiceFactory>();
            var service = factory.CreateOrganizationService(context.UserId);
            var tracing = executionContext.GetExtension<ITracingService>();

            tracing.Trace("${name} started for {0} {1}", context.PrimaryEntityName, context.PrimaryEntityId);
            Result.Set(executionContext, Text.Get(executionContext));
        }
    }
}
`;
  }
  const body =
    kind === "customapi"
      ? `            // Custom API: read the request parameters, set the response properties.
            // var input = context.InputParameters["Input"] as string;
            // context.OutputParameters["Output"] = input;`
      : `            if (!(context.InputParameters.TryGetValue("Target", out var targetObject) && targetObject is Entity target))
                return;

            tracing.Trace("${name}: {0} of {1} {2}", context.MessageName, target.LogicalName, target.Id);
            // var name = target.GetAttributeValue<string>("name");`;
  if (usesPluginBase) {
    return `using System;
using Microsoft.Xrm.Sdk;

namespace ${ns}
{
    public class ${name} : PluginBase
    {
        public ${name}(string unsecureConfiguration, string secureConfiguration)
            : base(typeof(${name}))
        {
        }

        protected override void ExecuteDataversePlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));
            var context = localPluginContext.PluginExecutionContext;
            var service = localPluginContext.PluginUserService;
            var tracing = localPluginContext.TracingService;

${body}
        }
    }
}
`;
  }
  return `using System;
using Microsoft.Xrm.Sdk;

namespace ${ns}
{
    public class ${name} : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));

${body}
        }
    }
}
`;
}

/** The unpacked folder pac packs: the one holding Other/Solution.xml. */
export function packableFolder(solutionFolder: string): string | undefined {
  for (const candidate of [path.join(solutionFolder, "src"), solutionFolder]) {
    if (fs.existsSync(path.join(candidate, "Other", "Solution.xml"))) return candidate;
  }
  return undefined;
}

export function registerScaffolding(onChanged: () => void): vscode.Disposable[] {
  return [
    r("lantern.plugins.newProject", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (!client) return;
      const name = await vscode.window.showInputBox({
        title: "New plug-in project",
        prompt: "Project name, e.g. Acme.Plugins",
        value: `${client.config.scriptNamespace || "Acme"}.Plugins`,
        validateInput: (v: string) => (/^[A-Za-z_][\w.]*$/.test(v.trim()) ? undefined : "Use letters, digits, dots, and underscores."),
      });
      if (!name) return;
      const dir = path.join(client.dir, "Plugins", name.trim());
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
        void vscode.window.showWarningMessage(`${path.relative(client.dir, dir)} already exists and isn't empty.`);
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      const ok = await withProgress(`Creating ${name}`, async (ctx) => {
        await pluginInit(ctx, dir);
        return true;
      });
      onChanged();
      const csproj = findFiles(dir, (n) => n.endsWith(".csproj"))[0];
      if (ok && csproj) await vscode.window.showTextDocument(vscode.Uri.file(csproj));
    }),

    r("lantern.plugins.newClass", async (arg?: unknown) => {
      const node = arg as { client?: Client; plugin?: PluginProject } | undefined;
      const client = node?.client ?? (await resolveClient(arg));
      if (!client) return;
      let project = node?.plugin;
      if (!project) {
        const projects = findPluginProjects(client.dir);
        if (!projects.length) {
          const create = await vscode.window.showInformationMessage(`${client.name} has no plug-in project yet.`, "New Plug-in Project");
          if (create) await vscode.commands.executeCommand("lantern.plugins.newProject", client);
          return;
        }
        const pick = projects.length === 1 ? { project: projects[0] } : await vscode.window.showQuickPick(projects.map((p) => ({ label: p.assembly, description: path.relative(client.dir, p.project), project: p })), { placeHolder: "Add it to which project?" });
        if (!pick) return;
        project = pick.project;
      }
      const kind = await vscode.window.showQuickPick(
        [
          { label: "Plug-in", description: "runs on a message like Create or Update", classKind: "plugin" as const },
          { label: "Custom API handler", description: "the plug-in behind a Custom API", classKind: "customapi" as const },
          { label: "Custom workflow activity", description: "a step for classic workflows", classKind: "workflow" as const },
        ],
        { placeHolder: "What kind of class?" }
      );
      if (!kind) return;
      const name = await vscode.window.showInputBox({
        prompt: "Class name",
        validateInput: (v: string) => (/^[A-Za-z_]\w*$/.test(v.trim()) ? undefined : "Use a C# class name."),
      });
      if (!name) return;
      if (!project) return;
      const csproj = project.project;
      const projectDir = path.dirname(csproj);
      const file = path.join(projectDir, `${name.trim()}.cs`);
      if (fs.existsSync(file)) {
        void vscode.window.showWarningMessage(`${path.basename(file)} already exists.`);
        return;
      }
      const usesPluginBase = findFiles(projectDir, (n) => n === "PluginBase.cs").length > 0;
      fs.writeFileSync(file, classTemplate(kind.classKind, projectNamespace(csproj), name.trim(), usesPluginBase && kind.classKind !== "workflow"));
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),

    r("lantern.solutions.packAndImport", async (node: { client: Client; unique: string; folder?: string }) => {
      const src = node.folder ? packableFolder(node.folder) : undefined;
      if (!src) {
        void vscode.window.showWarningMessage(`${node.unique} isn't unpacked in this folder yet. Pull it first.`);
        return;
      }
      const kind = await vscode.window.showQuickPick(
        [
          { label: "Unmanaged", managed: false },
          { label: "Managed", description: "pac needs the managed files in the folder (from a managed export)", managed: true },
        ],
        { placeHolder: `Pack ${node.unique} from your files as…` }
      );
      if (!kind) return;
      let target = node.client;
      if (node.client.environments.length) {
        const env = await vscode.window.showQuickPick(
          node.client.environments.map((e) => ({ label: e.name, description: [e.org, e.protected ? "protected" : "", e.name === node.client.envName ? "current" : ""].filter(Boolean).join(", ") })),
          { placeHolder: "Import into which environment?" }
        );
        if (!env) return;
        target = node.client.withEnvironment(env.label);
      }
      if (!(await confirmProtected(target, `Import ${node.unique} from your files`))) return;
      const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lantern-pack-")), `${node.unique}.zip`);
      const ok = await withProgress(`Packing ${node.unique} and importing into ${target.envName || target.orgHost}`, async (ctx, progress) => {
        progress.report({ message: "packing..." });
        await solutionPack(ctx, src, zip, kind.managed);
        progress.report({ message: "importing..." });
        await ensureAuth(ctx, target);
        await solutionImport(ctx, target, zip);
        return true;
      });
      fs.rmSync(path.dirname(zip), { recursive: true, force: true });
      if (ok) void vscode.window.showInformationMessage(`Packed ${node.unique} from your files and imported it into ${target.envName || target.orgHost}.`);
    }),

    r("lantern.tests.setup", async (arg?: unknown) => {
      const client = await resolveClient(arg);
      if (client) await setUpScriptTests(client);
    }),
  ];
}

/** A tests folder with Jest and xrm-mock, a loader for web resource scripts, and a first test. */
async function setUpScriptTests(client: Client): Promise<void> {
  const dir = path.join(client.dir, "tests");
  if (fs.existsSync(path.join(dir, "package.json"))) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, "package.json")));
    return;
  }
  const scripts = findFiles(client.dir, (n, full) => /\.js$/i.test(n) && /webresources/i.test(full) && !/node_modules|[\\/]tests[\\/]/i.test(full));
  const pick = await vscode.window.showQuickPick(
    [...scripts.map((f) => ({ label: path.basename(f), description: path.relative(client.dir, f), file: f })), { label: "(start with an empty test)", description: "", file: "" }],
    { placeHolder: "Write a first test for which script?" }
  );
  if (!pick) return;
  fs.mkdirSync(path.join(dir, "helpers"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `${client.name}-tests`, private: true, scripts: { test: "jest" }, devDependencies: { jest: "^29.7.0", "xrm-mock": "^3.5.0", "@types/jest": "^29.5.0" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "jest.config.js"), 'module.exports = { testEnvironment: "node", testMatch: ["**/*.test.js"] };\n');
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(
    path.join(dir, "helpers", "load-web-resource.js"),
    `// Web resources aren't modules: run one in a shared context with the Xrm mock and return what it defined.
const fs = require("fs");
const vm = require("vm");

module.exports = function loadWebResource(file, globals = {}) {
  const context = vm.createContext({ console, Xrm: global.Xrm, ...globals });
  context.window = context;
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context;
};
`
  );
  const rel = pick.file ? path.relative(dir, pick.file).split(path.sep).join("/") : "";
  const first = pick.file ? outlineJs(fs.readFileSync(pick.file, "utf8"))[0] : undefined;
  const call = first ? (first.written.startsWith("this.") ? `script.${first.name}` : first.written.includes(".") ? `script.${first.written}` : `script.${first.name}`) : "";
  fs.writeFileSync(
    path.join(dir, `${pick.file ? path.basename(pick.file, ".js") : "example"}.test.js`),
    `const { XrmMockGenerator } = require("xrm-mock");
const path = require("path");
const loadWebResource = require("./helpers/load-web-resource");

describe("${pick.file ? path.basename(pick.file) : "example"}", () => {
  beforeEach(() => {
    XrmMockGenerator.initialise();
    // Add the columns and controls the script uses, e.g.:
    // XrmMockGenerator.Attribute.createString("name", "Contoso");
  });

  test("${first ? `${first.name} runs` : "add your first test"}", () => {
${
  pick.file
    ? `    const script = loadWebResource(path.join(__dirname, "${rel}"));
${first ? `    ${call}(XrmMockGenerator.getEventContext());\n` : ""}    // expect(Xrm.Page.getAttribute("name").getValue()).toBe("Contoso");`
    : "    expect(true).toBe(true);"
}
  });
});
`
  );
  const run = await vscode.window.showInformationMessage(`Created ${client.name}/tests with Jest and xrm-mock.`, "Install and Run Tests");
  if (run) {
    const terminal = vscode.window.createTerminal({ name: `${client.name} tests`, cwd: dir });
    terminal.show();
    terminal.sendText("npm install && npm test");
  }
}
