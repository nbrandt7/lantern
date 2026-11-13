// Regression tests for plug-in registration, step and debugging bugs.
// Run with: npm run compile && node test/regression/plugins.js (LANTERN_OUT=<dir> to test another build).
const Module = require("module");
const path = require("path");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? require.resolve("../mock-vscode") : resolve.call(this, request, ...rest);
};
const OUT = process.env.LANTERN_OUT ? path.resolve(process.env.LANTERN_OUT) : path.join(__dirname, "..", "..", "out");
const out = (m) => require(path.join(OUT, m));
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const S = require("../mock-vscode").__state;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n${err.stack.split("\n").slice(0, 6).join("\n")}`);
  } finally {
    S.messageAnswers.length = 0;
    S.panelAnswers.length = 0;
  }
}
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-plugins-"));
  fs.mkdirSync(path.join(dir, ".lantern"));
  return dir;
};

/** A DataverseClient that records calls and answers from routes: { "GET <regex>": value | (path) => value }. An Error answer is thrown. */
function fakeDv(routes = {}) {
  const calls = [];
  let n = 0;
  const answer = (method, p) => {
    for (const [route, a] of Object.entries(routes)) {
      const [m, pattern] = route.split(" ");
      if (m === method && new RegExp(pattern).test(p)) {
        const v = typeof a === "function" ? a(p) : a;
        if (v instanceof Error) throw v;
        return v;
      }
    }
    return undefined;
  };
  return {
    calls,
    async getAll(p) { calls.push(["GET", p]); return answer("GET", p) ?? []; },
    async getJson(p) { calls.push(["GET", p]); return answer("GET", p) ?? {}; },
    async create(set, body, headers) { calls.push(["POST", set, body, headers]); answer("POST", set); return `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`; },
    async update(p, body) { calls.push(["PATCH", p, body]); answer("PATCH", p); },
    async remove(p) { calls.push(["DELETE", p]); answer("DELETE", p); },
  };
}

const auth = out("ui/auth.js");
const useDv = (dv) => (auth.dataverseFor = () => dv);
const clientIn = (dir) => ({ name: "dev", dir, orgHost: "org.crm.dynamics.com", envName: "DEV", isProtected: false, config: { org: "https://org.crm.dynamics.com", plugins: {}, solutions: [] }, save() {} });
const messages = (kind) => S.messages.filter((m) => m[0] === kind).map((m) => m[1]);

(async () => {
  // ---------- Unregister Plug-in Package ----------
  const { unregisterPackageCommand } = out("commands/unregisterPackage.js");
  const PKG = "11111111-1111-1111-1111-111111111111";
  const packageRoutes = (extra) => ({
    "GET pluginpackages\\?": [{ pluginpackageid: PKG, name: "Contoso.Plugins", uniquename: "contoso_Contoso.Plugins", version: "1.0.0", ismanaged: false }],
    "GET pluginassemblies\\?": [{ pluginassemblyid: "a1", name: "Contoso.Plugins", version: "1.0.0.0", _packageid_value: PKG }],
    "GET plugintypes\\?": [{ plugintypeid: "t1", typename: "Contoso.Plugins.Approve", _pluginassemblyid_value: "a1" }],
    "GET sdkmessageprocessingsteps\\?": [{ sdkmessageprocessingstepid: "s1", name: "Approve: Update of account", ismanaged: false, _sdkmessageprocessingstepsecureconfigid_value: "sc1" }],
    "GET sdkmessageprocessingsteps\\(s1\\)": { sdkmessageprocessingstepid: "s1", name: "Approve: Update of account", configuration: "unsecure config" },
    "GET sdkmessageprocessingstepimages": [{ entityalias: "PreImage", imagetype: 0 }],
    ...extra,
  });
  const packageRow = { pluginassemblyid: "a1", name: "Contoso.Plugins", _packageid_value: PKG };

  await test("unregister package: a type something else depends on stops it before any step is deleted", async () => {
    const dv = fakeDv(packageRoutes({
      // A classic workflow uses one of the package's types (a Custom API would too): Dataverse would refuse the package delete.
      "GET RetrieveDependenciesForDelete": [{ dependentcomponenttype: 92, dependentcomponentobjectid: "s1" }, { dependentcomponenttype: 29, dependentcomponentobjectid: "wf1" }],
    }));
    useDv(dv);
    S.messages.length = 0;
    S.messageAnswers.push("Unregister");
    await unregisterPackageCommand({ client: clientIn(tmp()), assembly: packageRow }, () => undefined);
    assert.deepStrictEqual(dv.calls.filter((c) => c[0] === "DELETE"), [], "nothing is deleted");
    assert.ok(dv.calls.some((c) => /^RetrieveDependenciesForDelete\(.*@p1=t1&@p2=90/.test(c[1])), "the package's type is checked");
    const error = messages("error").pop();
    assert.match(error, /Contoso\.Plugins\.Approve: another component depends on it \(Process\)/);
    assert.match(error, /Nothing was changed/);
  });

  await test("unregister package: a managed step on one of its types stops it", async () => {
    const dv = fakeDv(packageRoutes({
      "GET sdkmessageprocessingsteps\\?": [{ sdkmessageprocessingstepid: "s1", name: "Approve: Update of account", ismanaged: true, _sdkmessageprocessingstepsecureconfigid_value: null }],
      "GET RetrieveDependenciesForDelete": [{ dependentcomponenttype: 92, dependentcomponentobjectid: "s1" }],
    }));
    useDv(dv);
    S.messages.length = 0;
    S.messageAnswers.push("Unregister");
    await unregisterPackageCommand({ client: clientIn(tmp()), assembly: packageRow }, () => undefined);
    assert.deepStrictEqual(dv.calls.filter((c) => c[0] === "DELETE"), []);
    assert.match(messages("error").pop(), /from a managed solution/);
  });

  await test("unregister package: the steps are saved to .pull-backup before they're deleted, and a failed package delete names the file", async () => {
    const dir = tmp();
    const backups = () => (fs.existsSync(path.join(dir, ".pull-backup")) ? fs.readdirSync(path.join(dir, ".pull-backup")) : []);
    let savedBeforeDelete;
    const dv = fakeDv(packageRoutes({
      "GET RetrieveDependenciesForDelete": [{ dependentcomponenttype: 92, dependentcomponentobjectid: "s1" }],
      "DELETE sdkmessageprocessingsteps\\(": () => { savedBeforeDelete ??= backups().length === 1; },
      "DELETE pluginpackages": new Error("The object you tried to delete is associated with another object and cannot be deleted."),
    }));
    useDv(dv);
    S.messages.length = 0;
    S.messageAnswers.push("Unregister");
    await unregisterPackageCommand({ client: clientIn(dir), assembly: packageRow }, () => undefined);
    const ask = S.messages.find((m) => m[0] === "warn" && /^Unregister plug-in package/.test(m[1]));
    assert.match(ask[2].detail, /saved to a file in \.pull-backup first/);
    assert.strictEqual(savedBeforeDelete, true, "the backup is written before the first delete");
    const [file] = backups();
    assert.match(file, /^unregistered-steps-contoso_Contoso\.Plugins-.*\.json$/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, ".pull-backup", file), "utf8"));
    assert.deepStrictEqual(
      [saved.package, saved.steps[0].pluginType, saved.steps[0].step.configuration, saved.steps[0].images[0].entityalias],
      ["contoso_Contoso.Plugins", "Contoso.Plugins.Approve", "unsecure config", "PreImage"]
    );
    assert.match(messages("error").pop(), /cannot be deleted\. The steps were saved to \.pull-backup.unregistered-steps-contoso_Contoso\.Plugins-.*\.json\.$/);
  });

  // ---------- Register Plug-in Step ----------
  const { registerStep, registerStepCommands } = out("commands/registerStep.js");
  registerStepCommands(() => ({ tables: async () => [], solutionTables: async () => [], columns: async () => [] }), () => undefined);
  const registerCommand = S.commands.get("lantern.steps.register");
  const tenant = out("ui/tenantContext.js");

  await test("register step: SetState and SetStateDynamicEntity images come from EntityMoniker", async () => {
    const dv = fakeDv();
    useDv(dv);
    for (const [message, property] of [["SetState", "EntityMoniker"], ["SetStateDynamicEntity", "EntityMoniker"], ["Create", "Id"], ["Update", "Target"]]) {
      dv.calls.length = 0;
      await registerStep(clientIn(tmp()), {
        pluginTypeId: "t", typeName: "Acme.P", messageId: "m", message, filterId: "f", table: "account", stage: 40, mode: 0, filtering: [],
        images: [{ kind: "Pre", alias: "PreImage", attributes: [], type: 0 }],
      });
      const image = dv.calls.find((c) => c[0] === "POST" && c[1] === "sdkmessageprocessingstepimages");
      assert.strictEqual(image[2].messagepropertyname, property, message);
    }
  });

  await test("register step: filtering columns are kept when the message is typed in lower case", async () => {
    const dv = fakeDv({
      "GET plugintypes\\?": [{ plugintypeid: "t1", typename: "Acme.Plugins.AccountPlugin", assemblyname: "Acme.Plugins" }],
      "GET sdkmessages\\?": [{ sdkmessageid: "m1" }],
      "GET sdkmessagefilters\\?": [{ sdkmessagefilterid: "f1" }],
    });
    useDv(dv);
    const client = clientIn(tmp());
    tenant.activeTenant = () => client;
    // The "Other…" message box keeps whatever case the user typed; Dataverse finds the message either way.
    S.panelAnswers.push((state) => ({
      type: "submit",
      draft: {
        step: { ...state.draft.step, name: "AccountPlugin: update of account", filtering: ["name"] },
        target: { ...state.draft.target, pluginTypeId: "t1", typeName: "Acme.Plugins.AccountPlugin", message: "update", table: "account" },
      },
    }));
    // A draft the panel refuses would leave the command waiting on the page.
    let timer;
    const refused = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the panel refused the draft: ${JSON.stringify(S.panels.at(-1).webview.posted.at(-1))}`)), 2000)));
    await Promise.race([registerCommand({ client }), refused]).finally(() => clearTimeout(timer));
    const step = dv.calls.find((c) => c[0] === "POST" && c[1] === "sdkmessageprocessingsteps");
    assert.ok(step, `the step is registered (${JSON.stringify(S.panelErrors || messages("error"))})`);
    assert.strictEqual(step[2].filteringattributes, "name");
  });

  await test("register step: the type Build and Push (or the tree) names is pre-selected by ID, not an older version's type of the same name", async () => {
    const dv = fakeDv({ "GET plugintypes\\?": [
      { plugintypeid: "type-of-1.0", typename: "Acme.Plugins.AccountPlugin", assemblyname: "Acme.Plugins" },
      { plugintypeid: "type-of-2.0", typename: "Acme.Plugins.AccountPlugin", assemblyname: "Acme.Plugins" },
    ] });
    useDv(dv);
    const client = clientIn(tmp());
    tenant.activeTenant = () => client;
    const preselected = [];
    const capture = (state) => {
      preselected.push(state.draft.target.pluginTypeId);
      return { type: "cancel" };
    };
    S.panelAnswers.push(capture, capture);
    // What pushPlugin's "Register Step…" sends after registering 2.0 next to 1.0.
    await registerCommand({ client, assembly: "Acme.Plugins", typeName: "Acme.Plugins.AccountPlugin", typeId: "TYPE-OF-2.0" });
    // A registered class in the Plug-ins tree.
    await registerCommand({ client, assembly: "Acme.Plugins", typeName: "Acme.Plugins.AccountPlugin", status: { type: { plugintypeid: "type-of-2.0" } } });
    assert.deepStrictEqual(preselected, ["type-of-2.0", "type-of-2.0"]);
  });

  // ---------- Plug-in status: side-by-side versions, cache ----------
  const { fetchSteps } = out("core/admin.js");
  const pluginStatus = out("core/pluginStatus.js");

  await test("fetchSteps: each step carries its plug-in type's ID", async () => {
    const dv = fakeDv({ "GET sdkmessageprocessingsteps\\?": [
      { sdkmessageprocessingstepid: "s1", name: "x", stage: 40, mode: 0, statecode: 0, rank: 1, _plugintypeid_value: "t2", plugintypeid: { typename: "Acme.Plugins.AccountPlugin", assemblyname: "Acme.Plugins" } },
    ] });
    const [step] = await fetchSteps(dv);
    assert.match(dv.calls[0][1], /\$select=[^&]*\b_plugintypeid_value\b/);
    assert.strictEqual(step.typeId, "t2");
  });

  await test("plug-in status: the old version's steps don't show under the newer version's class", () => {
    const dir = tmp();
    const proj = path.join(dir, "Acme.Plugins");
    fs.mkdirSync(proj);
    fs.writeFileSync(
      path.join(proj, "Acme.Plugins.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net462</TargetFramework><AssemblyVersion>2.0.0.0</AssemblyVersion></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2.*" /></ItemGroup></Project>'
    );
    fs.writeFileSync(path.join(proj, "AccountPlugin.cs"), "using System; using Microsoft.Xrm.Sdk;\nnamespace Acme.Plugins { public class AccountPlugin : IPlugin { public void Execute(IServiceProvider sp) {} } }");
    const step = (id, typeId) => ({ id, name: id, typeId, typeName: "Acme.Plugins.AccountPlugin", assembly: "Acme.Plugins", message: "Update", table: "account", enabled: true });
    const org = {
      at: Date.now(),
      // 2.0 registered next to 1.0 with "Register as Separate Assembly"; 1.0 keeps its steps.
      assemblies: [{ pluginassemblyid: "a1", name: "Acme.Plugins", version: "1.0.0.0" }, { pluginassemblyid: "a2", name: "Acme.Plugins", version: "2.0.0.0" }],
      types: [
        { plugintypeid: "t1", typename: "Acme.Plugins.AccountPlugin", isworkflowactivity: false, assemblyname: "Acme.Plugins", _pluginassemblyid_value: "a1" },
        { plugintypeid: "t2", typename: "Acme.Plugins.AccountPlugin", isworkflowactivity: false, assemblyname: "Acme.Plugins", _pluginassemblyid_value: "a2" },
      ],
      steps: [step("s-old", "t1"), step("s-new", "t2")],
    };
    const st = pluginStatus.projectStatus(clientIn(dir), { project: path.join(proj, "Acme.Plugins.csproj"), assembly: "Acme.Plugins" }, org);
    assert.strictEqual(st.registered.pluginassemblyid, "a2");
    assert.deepStrictEqual(st.classes.map((c) => [c.type.plugintypeid, c.steps.map((s) => s.id)]), [["t2", ["s-new"]]]);
    // Step rows read without the type's ID still match by assembly and type name.
    const one = { ...org, assemblies: [org.assemblies[1]], types: [org.types[1]], steps: [step("s-no-id", undefined)] };
    assert.deepStrictEqual(pluginStatus.projectStatus(clientIn(dir), { project: path.join(proj, "Acme.Plugins.csproj"), assembly: "Acme.Plugins" }, one).classes[0].steps.map((s) => s.id), ["s-no-id"]);
  });

  const assembliesAt = (version, wait) => ({
    async getAll(p) {
      if (wait) await wait;
      return p.startsWith("pluginassemblies") ? [{ pluginassemblyid: "a", name: "Acme", version }] : [];
    },
  });

  await test("orgPlugins: a slower load overtaken by a fresh one doesn't put its older rows back in the cache", async () => {
    // Its own cache key, so what another test left cached doesn't answer for it.
    const client = { ...clientIn(tmp()), name: "overtaken" };
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = pluginStatus.orgPlugins(client, assembliesAt("1.0.0.0", gate));
    const fresh = await pluginStatus.orgPlugins(client, assembliesAt("2.0.0.0"), true);
    assert.strictEqual(fresh.assemblies[0].version, "2.0.0.0");
    release();
    await slow;
    const cached = await pluginStatus.orgPlugins(client, assembliesAt("3.0.0.0"));
    assert.strictEqual(cached.assemblies[0].version, "2.0.0.0", "the fresh rows stay cached");
    pluginStatus.forgetOrgPlugins(client);
  });

  await test("orgPlugins: a load started before forgetOrgPlugins (a push) isn't handed out or cached afterwards", async () => {
    // Its own cache key, so what another test left cached doesn't answer for it.
    const client = { ...clientIn(tmp()), name: "forgotten" };
    let release;
    const gate = new Promise((r) => (release = r));
    const before = pluginStatus.orgPlugins(client, assembliesAt("1.0.0.0", gate));
    pluginStatus.forgetOrgPlugins(client);
    const after = pluginStatus.orgPlugins(client, assembliesAt("2.0.0.0"));
    release();
    await before;
    assert.strictEqual((await after).assemblies[0].version, "2.0.0.0");
    const cached = await pluginStatus.orgPlugins(client, assembliesAt("3.0.0.0"));
    assert.strictEqual(cached.assemblies[0].version, "2.0.0.0");
    pluginStatus.forgetOrgPlugins(client);
  });

  // ---------- Edit Step ----------
  const stepEditing = out("core/stepEditing.js");

  await test("edit step: \"Set…\" with an empty secure configuration is a problem, not an empty row", () => {
    const step = { message: "Update" };
    const draft = (secureConfig) => ({ name: "S", description: "", stage: 40, mode: 0, rank: 1, filtering: [], deleteJobOnSuccess: false, configuration: "", secureConfig, images: [] });
    assert.ok(stepEditing.stepProblems(step, draft({ stored: false, replacement: "" })).some((p) => /secure configuration, or choose None/.test(p)));
    assert.ok(stepEditing.stepProblems(step, draft({ stored: true, replacement: "" })).some((p) => /Keep the stored one/.test(p)));
    assert.deepStrictEqual(stepEditing.stepProblems(step, draft({ stored: false, replacement: "secret" })), []);
    assert.deepStrictEqual(stepEditing.stepProblems(step, draft({ stored: true, replacement: null })), []);
  });

  // ---------- Debug Plug-in Step ----------
  const pluginDebug = out("core/pluginDebug.js");

  await test("debug launch.json: comments and commented-out configurations are kept", () => {
    const launch = [
      "{",
      "    // Use IntelliSense to learn about possible attributes.",
      '    "version": "0.2.0",',
      '    "configurations": [',
      '        // { "name": "Old config I keep around", "type": "node", "request": "launch" },',
      "        {",
      '            "name": "Run Extension", /* a [ and { in a comment */',
      '            "type": "extensionHost",',
      '            "request": "launch",',
      '            "args": ["--extensionDevelopmentPath=${workspaceFolder}", "x]}"],',
      "        },",
      "    ]",
      "}",
      "",
    ].join("\r\n");
    const updated = pluginDebug.withAttachConfiguration(launch);
    assert.ok(updated.includes("// Use IntelliSense") && updated.includes('// { "name": "Old config I keep around"') && updated.includes("/* a [ and { in a comment */"));
    assert.ok(!/[^\r]\n/.test(updated), "CRLF line endings are kept");
    const parsed = JSON.parse(pluginDebug.stripJsonc(updated));
    assert.deepStrictEqual(parsed.configurations.map((c) => c.name), [pluginDebug.ATTACH_CONFIGURATION.name, "Run Extension"]);
    assert.deepStrictEqual(parsed.configurations[0], pluginDebug.ATTACH_CONFIGURATION);
    assert.ok(updated.includes('    "configurations": [\r\n        {\r\n            "name": "Lantern: attach'), "indented like the file");
    assert.strictEqual(pluginDebug.withAttachConfiguration(updated), updated, "added once");

    for (const text of ['{ "version": "0.2.0", "configurations": [] }', '{\n  // keep\n  "configurations": [\n    // { "name": "later" }\n  ]\n}\n']) {
      const result = pluginDebug.withAttachConfiguration(text);
      assert.deepStrictEqual(JSON.parse(pluginDebug.stripJsonc(result)).configurations, [pluginDebug.ATTACH_CONFIGURATION], text);
      assert.ok(!text.includes("//") || (result.includes("// keep") && result.includes('// { "name": "later" }')), result);
    }
    assert.strictEqual(pluginDebug.withAttachConfiguration('{ "configurations": [ oops'), undefined, "a file that can't be read still comes back undefined");
  });

  const debug = out("commands/debugStep.js");
  const proc = out("core/process.js");
  const debugSetup = (withNupkg) => {
    const dir = tmp();
    const proj = path.join(dir, "Acme.Plugins");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "Acme.Plugins.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2.*" /></ItemGroup></Project>');
    if (withNupkg) {
      fs.mkdirSync(path.join(proj, "bin", "Debug"), { recursive: true });
      fs.writeFileSync(path.join(proj, "bin", "Debug", "Acme.Plugins.1.0.0.nupkg"), "");
    }
    useDv(fakeDv({
      "GET sdkmessageprocessingsteps\\?": [{
        sdkmessageprocessingstepid: "s1", name: "AccountPlugin: Update of account", stage: 40, mode: 0, statecode: 0, rank: 1, _plugintypeid_value: "t1",
        sdkmessageid: { name: "Update" }, sdkmessagefilterid: { primaryobjecttypecode: "account" }, plugintypeid: { typename: "Acme.Plugins.AccountPlugin", assemblyname: "Acme.Plugins" },
      }],
      "GET organizations\\?": { value: [{ organizationid: "o1", plugintracelogsetting: 2 }] },
      "GET plugintracelogs\\?": [{ plugintracelogid: "l1", createdon: "2026-10-31T10:00:00Z", typename: "Acme.Plugins.AccountPlugin", messagename: "Update", primaryentity: "account", exceptiondetails: "", profile: "<Profile />" }],
    }));
    // dotnet build succeeds, but no DLL lands under bin/Debug (UseArtifactsOutput, a custom OutputPath).
    proc.run = async () => ({ code: 0, stdout: "", stderr: "", missing: false });
    debug.timing.pollMs = 1;
    debug.tooling.find = () => undefined;
    debug.tooling.pac = () => undefined;
    S.messages.length = 0;
    S.output = [];
    return dir;
  };

  await test("debug step: a build whose DLL isn't under bin/Debug still adds the attach configuration and waits for a capture", async () => {
    const dir = debugSetup(false);
    await debug.debugStep({ client: clientIn(dir), step: { id: "s1" } }, () => undefined);
    assert.ok(fs.existsSync(path.join(dir, ".vscode", "launch.json")), "launch.json is written");
    assert.ok(fs.readdirSync(path.join(dir, ".lantern", "profiles")).some((f) => f.endsWith(".profile")), "the capture is saved");
    assert.match(messages("info").pop() ?? "", /^Captured Update of account and saved the profile\..*with this profile and your Debug build/);
  });

  await test("debug step: a .nupkg isn't offered as the assembly to replay", async () => {
    const dir = debugSetup(true);
    await debug.debugStep({ client: clientIn(dir), step: { id: "s1" } }, () => undefined);
    const info = messages("info").pop() ?? "";
    assert.match(info, /with this profile and your Debug build/);
    assert.ok(!/Assembly: .*\.nupkg/.test(S.output.join("")), "the replay steps don't name the .nupkg");
  });

  // ---------- Build and Push: a stale plug-in package ----------
  const sol = out("core/solutions.js");
  const reg = out("core/pluginRegistration.js");
  const { writeZip } = out("core/zip.js");
  const { writeAssembly } = require("../fakes/assembly-writer");
  const packageProject = (csprojExtra) => {
    const dir = tmp();
    const project = path.join(dir, "Acme.Pkg.csproj");
    fs.writeFileSync(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><PackageId>acme_Pkg</PackageId></PropertyGroup>${csprojExtra}</Project>`);
    return { dir, p: { project, assembly: "Acme.Pkg" } };
  };
  const put = (file, data = "x") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  };
  const nupkgWith = (dll) => writeZip([{ name: "acme_Pkg.nuspec", data: Buffer.from("<package><metadata><id>acme_Pkg</id><version>1.0.0</version></metadata></package>") }, { name: "lib/net462/Acme.Pkg.dll", data: dll }]);

  await test("build outputs: a package is the project's own, with a version after the id (not Acme.Pkg.Extra's, not .symbols)", () => {
    const { dir, p } = packageProject("");
    const bin = path.join(dir, "bin", "Release");
    const own = put(path.join(bin, "acme_Pkg.1.0.0.nupkg"));
    const later = Date.now() / 1000 + 60;
    for (const other of ["Acme.Pkg.Extra.1.0.0.nupkg", "acme_Pkg.1.0.0.symbols.nupkg"]) fs.utimesSync(put(path.join(bin, other)), later, later);
    assert.strictEqual(sol.findBuildOutputs(p, "Release").nupkg, own);
  });

  await test("before a build, a package project's last .nupkg and .nuspec are deleted; other projects' files stay", () => {
    const { dir, p } = packageProject('<ItemGroup><PackageReference Include="Microsoft.PowerApps.MSBuild.Plugin" Version="1.52.1" /></ItemGroup>');
    const pkg = put(path.join(dir, "bin", "Release", "acme_Pkg.1.0.0.nupkg"));
    const spec = put(path.join(dir, "obj", "Release", "acme_Pkg.1.0.0.nuspec"));
    const debugPkg = put(path.join(dir, "bin", "Debug", "acme_Pkg.1.0.0.nupkg"));
    const other = put(path.join(dir, "bin", "Release", "Acme.Pkg.Extra.1.0.0.nupkg"));
    const dll = put(path.join(dir, "bin", "Release", "net462", "Acme.Pkg.dll"));
    assert.deepStrictEqual(sol.clearBuiltPackages(p, "Release").sort(), [pkg, spec].sort());
    assert.deepStrictEqual([pkg, spec, debugPkg, other, dll].map((f) => fs.existsSync(f)), [false, false, true, true, true]);

    const { dir: plainDir, p: plain } = packageProject("");
    const manual = put(path.join(plainDir, "bin", "Release", "acme_Pkg.1.0.0.nupkg"));
    assert.deepStrictEqual(sol.clearBuiltPackages(plain, "Release"), [], "a project that doesn't pack on build keeps a package made by hand");
    assert.ok(fs.existsSync(manual));
    const { p: generated } = packageProject("<PropertyGroup><GeneratePackageOnBuild>true</GeneratePackageOnBuild></PropertyGroup>");
    assert.strictEqual(sol.packsOnBuild(generated), true);
  });

  await test("after a build, a .nupkg that doesn't hold the DLL just built isn't pushed", () => {
    const oldDll = writeAssembly({ name: "Acme.Pkg", version: "2026.11.6.1703", types: [] });
    const newDll = writeAssembly({ name: "Acme.Pkg", version: "2026.11.6.2321", types: [] });
    // The DLL was compiled at t; a package packed from it is written after, a stale one before.
    const t = Date.now();
    const built = { content: newDll, writtenAt: t };
    const stale = reg.stalePackageReason({ name: "bin/Release/acme_Pkg.1.0.0.nupkg", content: nupkgWith(oldDll), writtenAt: t - 3_600_000 }, built, "Acme.Pkg");
    assert.match(stale, /^bin\/Release\/acme_Pkg\.1\.0\.0\.nupkg \(.*\) is older than the Acme\.Pkg\.dll this build made \(2026\.11\.6\.2321\) and holds Acme\.Pkg 2026\.11\.6\.1703: the build didn't pack the new DLL\.$/);
    // A version that never changes: only the times tell, and a package from a moment before the DLL is still stale.
    const fixedOld = writeAssembly({ name: "Acme.Pkg", version: "1.0.0.0", types: [] });
    const fixedNew = Buffer.concat([fixedOld, Buffer.from("recompiled")]);
    assert.match(reg.stalePackageReason({ name: "x.nupkg", content: nupkgWith(fixedOld), writtenAt: t - 300 }, { content: fixedNew, writtenAt: t }, "Acme.Pkg"), /holds an older build of Acme\.Pkg \(also 1\.0\.0\.0\)/);
    assert.match(reg.stalePackageReason({ name: "x.nupkg", content: nupkgWith(oldDll), writtenAt: t + 500 }, built, "Acme.Pkg"), /^x\.nupkg holds Acme\.Pkg 2026\.11\.6\.1703, but the build made 2026\.11\.6\.2321\.$/, "packed after, but with another version");
    assert.strictEqual(reg.stalePackageReason({ name: "x.nupkg", content: nupkgWith(newDll), writtenAt: t - 3_600_000 }, built, "Acme.Pkg"), undefined, "a package holding this very DLL is fine, whatever its time");
    assert.strictEqual(reg.stalePackageReason({ name: "x.nupkg", content: nupkgWith(Buffer.concat([newDll, Buffer.from("signed")])), writtenAt: t + 500 }, built, "Acme.Pkg"), undefined, "packed after the DLL, same version");
    assert.match(reg.stalePackageReason({ name: "x.nupkg", content: writeZip([{ name: "acme_Pkg.nuspec", data: Buffer.from("<package/>") }]), writtenAt: t }, built, "Acme.Pkg"), /Acme\.Pkg\.dll isn't in x\.nupkg\./);
    assert.strictEqual(reg.stalePackageReason({ name: "x.nupkg", content: nupkgWith(oldDll), writtenAt: 0 }, undefined, "Acme.Pkg"), undefined, "no DLL to compare with");
  });

  await test("before a push, a package holding the build that's already deployed is recognised", async () => {
    const dll = writeAssembly({ name: "Acme.Pkg", version: "2026.11.6.1703", types: [] });
    const deployed = (content, version = "2026.11.6.1703") => fakeDv({
      "GET pluginassemblies\\?": [{ name: "Acme.Pkg", version }],
      "GET pluginpackages\\(": { content: content.toString("base64") },
    });
    assert.strictEqual(await reg.deployedInPackage(deployed(nupkgWith(dll)), PKG, "Acme.Pkg", dll), "2026.11.6.1703");
    const rebuilt = Buffer.concat([dll, Buffer.from("changed")]);
    assert.strictEqual(await reg.deployedInPackage(deployed(nupkgWith(dll)), PKG, "Acme.Pkg", rebuilt), undefined, "same version, other code: a real update");
    const newer = deployed(nupkgWith(dll), "2026.11.6.1000");
    assert.strictEqual(await reg.deployedInPackage(newer, PKG, "Acme.Pkg", dll), undefined);
    assert.ok(!newer.calls.some(([, p]) => p.startsWith("pluginpackages(")), "another version doesn't download the package");
  });

  if (S.panelErrors) failures.push(...S.panelErrors.map((e) => `panel answer: ${e.message}`));
  console.log(`${passed} plugins regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  if (failures.length) process.exitCode = 1;
})();
