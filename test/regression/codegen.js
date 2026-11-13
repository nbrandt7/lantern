// Regression tests for generated code (C# table classes and their queue, script models, query code),
// form handler registration, TypeScript output paths, new plug-in classes, and reading JS and C# source.
// Run with: npm run compile && node test/regression/codegen.js (LANTERN_OUT=<dir> to test another build).
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
const vscode = require("../mock-vscode");
const S = vscode.__state;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-codegen-"));
let n = 0;
const tmp = () => {
  const dir = path.join(scratch, `t${++n}`);
  fs.mkdirSync(dir);
  return dir;
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n${String(err && err.stack).split("\n").slice(0, 6).join("\n")}`);
  }
}

/** A tenant as the commands see one: just what they read. */
const fakeClient = (dir, name = "Dev", config = {}) => ({
  name,
  dir,
  configFile: path.join(dir, ".lantern", "config.json"),
  envName: name,
  orgHost: "contoso.crm.dynamics.com",
  config: { org: "https://contoso.crm.dynamics.com", webResourceRoots: ["WebResources"], ...config },
  reload() {},
  save() {},
});
const opt = (pairs) => pairs.map(([value, label]) => ({ value, label }));

(async () => {
  const cc = out("core/csharpClasses.js");
  const project = { logicalName: "new_project", schemaName: "new_Project", displayName: "Project", entitySetName: "new_projects", primaryId: "new_projectid", primaryName: "new_name" };
  const projectCols = [
    { logicalName: "new_projectid", schemaName: "new_ProjectId", displayName: "Project", type: "Uniqueidentifier" },
    { logicalName: "new_kind", schemaName: "new_Kind", displayName: "Kind", type: "Picklist", options: opt([[1, "Big"], [2, "Small"]]) },
    { logicalName: "new_event", schemaName: "event", displayName: "Event", type: "String" },
  ];

  // ---------- C# classes ----------

  await test("C# classes: a column kept from the code keeps its enum from the same file, and its Fields name gets @ when it's a keyword", () => {
    const dir = tmp();
    const first = cc.generateClass(project, projectCols, { namespace: "Contoso.Models", enums: new Map(), source: "test" });
    fs.writeFileSync(path.join(dir, `${first.className}.cs`), first.text);
    const existing = cc.scanExisting(dir);
    const cls = existing.classes.get("new_project");
    // new_kind and new_event are gone from Dataverse (or from this environment): kept as written.
    const g = cc.generateClass(project, [projectCols[0]], { namespace: "Contoso.Models", existing: cls, enums: existing.enums, keep: new Set(["new_kind", "new_event"]), source: "test" });
    assert.deepStrictEqual(g.kept, ["new_event", "new_kind"]);
    assert.match(g.text, /public new_project_new_kind\? new_Kind/);
    assert.match(g.text, /\n    public enum new_project_new_kind\n    \{\n        \/\/\/ <summary>Big<\/summary>\n        Big = 1,/, "the enum the kept property uses is still declared");
    assert.match(g.text, /\n    \/\/\/ <summary>Choices of Kind \(new_project\.new_kind\)<\/summary>\n    public enum/, "with its doc comment");
    assert.match(g.text, /public const string @event = "new_event";/);
    assert.doesNotMatch(g.text, /const string event\b/);
    // Without a namespace the kept enum moves out with the class.
    const bare = cc.generateClass(project, [projectCols[0]], { existing: cls, enums: existing.enums, keep: new Set(["new_kind"]), source: "test" });
    assert.match(bare.text, /\npublic enum new_project_new_kind\n\{\n    \/\/\/ <summary>Big<\/summary>\n    Big = 1,/);
    // An enum declared in another file stays there.
    const elsewhere = new Map([...existing.enums, ["new_project_new_kind", path.join(dir, "OptionSets.cs")]]);
    const g2 = cc.generateClass(project, [projectCols[0]], { namespace: "Contoso.Models", existing: cls, enums: elsewhere, keep: new Set(["new_kind"]), source: "test" });
    assert.doesNotMatch(g2.text, /enum new_project_new_kind/);
  });

  await test("C# classes: a CrmSvcUtil-style OptionSetValue property stays OptionSetValue on Update and Edit Columns", () => {
    const account = { logicalName: "account", schemaName: "Account", displayName: "Account", primaryId: "accountid", primaryName: "name" };
    const src = [
      "namespace Contoso",
      "{",
      '    [Microsoft.Xrm.Sdk.Client.EntityLogicalNameAttribute("account")]',
      "    public partial class Account : Microsoft.Xrm.Sdk.Entity",
      "    {",
      '        [Microsoft.Xrm.Sdk.AttributeLogicalNameAttribute("industrycode")]',
      "        public Microsoft.Xrm.Sdk.OptionSetValue IndustryCode",
      "        {",
      '            get { return this.GetAttributeValue<Microsoft.Xrm.Sdk.OptionSetValue>("industrycode"); }',
      '            set { this.SetAttributeValue("industrycode", value); }',
      "        }",
      '        [Microsoft.Xrm.Sdk.AttributeLogicalNameAttribute("statuscode")]',
      "        public OptionSetValue StatusCode",
      "        {",
      '            get { return this.GetAttributeValue<OptionSetValue>("statuscode"); }',
      '            set { this.SetAttributeValue("statuscode", value); }',
      "        }",
      "    }",
      "}",
    ].join("\n");
    const cls = cc.classesIn(src, "Account.cs")[0];
    const cols = [
      { logicalName: "accountid", schemaName: "AccountId", type: "Uniqueidentifier" },
      { logicalName: "industrycode", schemaName: "IndustryCode", type: "Picklist", options: opt([[1, "Accounting"]]) },
      { logicalName: "statuscode", schemaName: "StatusCode", type: "Status", options: opt([[1, "Active"]]) },
      { logicalName: "customertypecode", schemaName: "CustomerTypeCode", type: "Picklist", options: opt([[1, "Competitor"]]) },
    ];
    const g = cc.generateClass(account, cols, { namespace: "Contoso", existing: cls, enums: new Map(), source: "test" });
    assert.match(g.text, /public OptionSetValue IndustryCode\n\s*\{\n\s*get => GetAttributeValue<OptionSetValue>\("industrycode"\);/);
    assert.match(g.text, /public OptionSetValue StatusCode\n/);
    assert.doesNotMatch(g.text, /enum account_industrycode|enum account_statuscode/);
    assert.match(g.text, /public account_customertypecode\? CustomerTypeCode/, "a column new to the class still gets an enum");
  });

  await test("C# classes and script models: accented labels make whole words (Ünïcode café is UnicodeCafe)", () => {
    assert.strictEqual(cc.identifier("Ünïcode café"), "UnicodeCafe");
    const sm = out("core/scriptModels.js");
    const text = sm.generateModel(project, [projectCols[0], { ...projectCols[1], options: opt([[1, "Ünïcode café"]]) }], { language: "js", namespace: "Acme.Models", keep: [], source: "test" });
    assert.match(text, /\bUnicodeCafe: 1,/);
  });

  const accountTable = { logicalName: "account", schemaName: "Account", displayName: "Account", entitySetName: "accounts", primaryId: "accountid", primaryName: "name" };
  const contactTable = { logicalName: "contact", schemaName: "Contact", displayName: "Contact", entitySetName: "contacts", primaryId: "contactid", primaryName: "fullname" };
  const columnsOf = {
    account: [{ logicalName: "accountid", schemaName: "AccountId", type: "Uniqueidentifier" }, { logicalName: "name", schemaName: "Name", displayName: "Account Name", type: "String" }],
    contact: [{ logicalName: "contactid", schemaName: "ContactId", type: "Uniqueidentifier" }, { logicalName: "fullname", schemaName: "FullName", displayName: "Full Name", type: "String" }],
  };
  const service = { tables: async () => [accountTable, contactTable], columns: async (t) => columnsOf[t] };
  const { CSharpClassQueue } = out("commands/csharpClasses.js");
  const memento = () => {
    const values = {};
    return { get: (k) => values[k], update: async (k, v) => { values[k] = JSON.parse(JSON.stringify(v)); }, values };
  };
  const classesConfig = () => ({ csharpClasses: { outDir: "Models", namespace: "Acme.Models", entities: [] } });

  await test("C# classes: generating doesn't overwrite a file of yours that has the class's name", async () => {
    const dir = tmp();
    const mine = "namespace Acme.Models\n{\n    public partial class Account\n    {\n        public string Describe() => \"mine\";\n    }\n}\n";
    fs.mkdirSync(path.join(dir, "Models"));
    fs.writeFileSync(path.join(dir, "Models", "Account.cs"), mine);
    const q = new CSharpClassQueue({ globalState: memento() }, () => service);
    const client = fakeClient(dir, "Dev", classesConfig());
    await assert.rejects(q.request(client, [{ table: "account", columns: ["name"] }, { table: "contact", columns: ["fullname"] }], { generate: true }), (err) => {
      assert.strictEqual(err.constructor.name, "UserError");
      assert.match(err.message, /Models[\\/]Account\.cs is already there and isn't the account class/);
      return true;
    });
    assert.strictEqual(fs.readFileSync(path.join(dir, "Models", "Account.cs"), "utf8"), mine);
    assert.ok(!fs.existsSync(path.join(dir, "Models", "Contact.cs")), "nothing is written when one file is in the way");
    q.dispose();
  });

  await test("C# classes queue: tenants with the same name in two projects have their own queues", async () => {
    const state = memento();
    const q = new CSharpClassQueue({ globalState: state }, () => service);
    const a = fakeClient(tmp(), "Dev", classesConfig());
    const b = fakeClient(tmp(), "Dev", classesConfig());
    await q.request(b, [{ table: "account", columns: ["name"] }]);
    assert.deepStrictEqual(q.queue(b).map((e) => e.table), ["account"]);
    assert.deepStrictEqual(q.queue(a), [], "the other project's Dev has nothing queued");
    // A queue saved by name alone (before) is still read, and moves on the next save.
    const key = Object.keys(state.values)[0];
    state.values[key] = { Dev: [{ table: "contact", label: "Contact", columns: ["contactid"], keep: [] }] };
    assert.deepStrictEqual(q.queue(a).map((e) => e.table), ["contact"]);
    await q.request(a, [{ table: "account", columns: ["name"] }]);
    assert.deepStrictEqual(q.queue(a).map((e) => e.table), ["account", "contact"]);
    assert.ok(!("Dev" in state.values[key]));
    q.dispose();
  });

  await test("C# classes queue: generating leaves what was queued while it ran", async () => {
    const state = memento();
    const q = new CSharpClassQueue({ globalState: state }, () => service);
    const client = fakeClient(tmp(), "Dev", classesConfig());
    await q.request(client, [{ table: "account", columns: ["name"] }]);
    const key = Object.keys(state.values)[0];
    // While the namespace is asked, an AI assistant queues contact (saving the queue as a new list).
    S.inputAnswers.push(() => {
      const all = state.values[key];
      for (const k of Object.keys(all)) all[k] = [...all[k], { table: "contact", label: "Contact", columns: ["contactid", "fullname"], keep: [] }];
      return "Acme.Models";
    });
    S.messageAnswers.push(undefined);
    await q.generate(client);
    assert.ok(fs.existsSync(path.join(client.dir, "Models", "Account.cs")));
    assert.deepStrictEqual(q.queue(client).map((e) => e.table), ["contact"]);
    q.dispose();
  });

  // ---------- script models ----------

  await test("script models: a form script with the model's file name isn't overwritten", async () => {
    const dir = tmp();
    const scripts = path.join(dir, "WebResources", "new_", "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    const formScript = path.join(scripts, "account.js");
    const mine = "var Acme = Acme || {};\nAcme.Account = { onLoad: function (ctx) {} };\n";
    fs.writeFileSync(formScript, mine);
    const client = fakeClient(dir, "Dev", { scriptModels: { outDir: "WebResources/new_/scripts", language: "js", namespace: "Acme.Models" } });
    const { ScriptModels } = out("commands/scriptModels.js");
    const models = new ScriptModels(() => service);
    await assert.rejects(models.addColumn(client, accountTable, columnsOf.account[1]), /account\.js is already there and isn't a Lantern script model/);
    assert.strictEqual(fs.readFileSync(formScript, "utf8"), mine);
    // A model there is still updated.
    fs.unlinkSync(formScript);
    await models.addColumn(client, accountTable, columnsOf.account[1]);
    assert.match(fs.readFileSync(formScript, "utf8"), /lantern-model: account/);
  });

  // ---------- query code ----------

  const cg = out("core/codegen.js");
  const sqlInput = (text) => ({ text, isFetchXml: false, org: "https://contoso.crm.dynamics.com/", entitySetOf: (t) => `${t}s`, options: { primaryIdOf: (t) => `${t}id` } });

  await test("Xrm.WebApi code: backslashes in values survive the template literal", () => {
    for (const value of ["C:\\users\\x", "C:\\temp", "%\\%", "a`b${c}"]) {
      const r = cg.generate("xrmWebApi", sqlInput(`SELECT name FROM account WHERE name = '${value}'`));
      const decl = /const fetchXml = (`[\s\S]*?[^\\]`);\n/.exec(r.code)[1];
      const fetchXml = new Function(`return ${decl};`)();
      assert.strictEqual(/value="([^"]*)"/.exec(fetchXml)[1], value);
    }
  });

  await test("Web API URL: multi-line FetchXML keeps attributes apart", () => {
    const fetch = [
      '<fetch top="5">',
      '  <entity name="account">',
      '    <attribute name="name" />',
      "    <filter>",
      '      <condition attribute="statecode"',
      '                 operator="eq"',
      '                 value="0" />',
      "    </filter>",
      "  </entity>",
      "</fetch>",
    ].join("\r\n");
    const r = cg.generate("webApiUrl", { text: fetch, isFetchXml: true, org: "https://contoso.crm.dynamics.com", entitySetOf: (t) => `${t}s` });
    const xml = decodeURIComponent(r.code.split("?fetchXml=")[1]);
    assert.strictEqual(xml, '<fetch top="5"><entity name="account"><attribute name="name" /><filter><condition attribute="statecode" operator="eq" value="0" /></filter></entity></fetch>');
  });

  await test("QueryExpression code: line breaks in values are escapes, not line breaks in the string (CS1010)", () => {
    const r = cg.generate("csQuery", sqlInput("SELECT name FROM account WHERE name = 'two\r\nlines'"));
    assert.match(r.code, /AddCondition\("name", ConditionOperator\.Equal, "two\\r\\nlines"\);/);
    for (const line of r.code.split("\n")) assert.strictEqual((line.match(/(?<!\\)"/g) ?? []).length % 2, 0, `unbalanced quotes: ${line}`);
  });

  // ---------- form handlers ----------

  await test("form handlers: adding one to a self-closing event keeps the event after it", () => {
    const fr = out("core/formRegistration.js");
    const xml = '<form><tabs/><events><event name="onload" application="false" active="false" /><event name="onsave" application="false" active="false"><Handlers><Handler functionName="Acme.save" libraryName="acme_/save.js" handlerUniqueId="{1}" enabled="true" parameters="" passExecutionContext="true" /></Handlers></event></events><formLibraries><Library name="acme_/save.js" libraryUniqueId="{2}" /></formLibraries></form>';
    const r = fr.addHandler(xml, { library: "acme_/load.js", functionName: "Acme.load", event: "onload", passExecutionContext: true });
    const events = /<events>([\s\S]*)<\/events>/.exec(r.xml)[1];
    assert.match(events, /^<event name="onload"[^>]*><Handlers><Handler functionName="Acme\.load" [^>]*\/><\/Handlers><\/event><event name="onsave"/);
    assert.match(events, /<event name="onsave" application="false" active="false"><Handlers><Handler functionName="Acme\.save" libraryName="acme_\/save\.js" handlerUniqueId="\{1\}"[^>]*\/><\/Handlers><\/event>$/);
    assert.strictEqual((r.xml.match(/<event\b/g) ?? []).length, 2);
    assert.strictEqual((r.xml.match(/<\/event>/g) ?? []).length, 2);
  });

  // ---------- TypeScript ----------

  await test("TypeScript: without rootDir, the file pushed is the one tsc wrote (below the common folder of the sources)", async () => {
    const dir = tmp();
    const ts = path.join(dir, "ts");
    fs.mkdirSync(path.join(ts, "src", "forms"), { recursive: true });
    fs.writeFileSync(path.join(ts, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "../WebResources/js" }, include: ["src"] }));
    const src = path.join(ts, "src", "forms", "account.ts");
    fs.writeFileSync(src, "const a: number = 1;\n");
    // tsc 5 without rootDir: outputs mirror the folders below the sources' common folder (src/forms here).
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, "fake-tsc.js");
    fs.writeFileSync(fake, [
      'const fs = require("fs"), path = require("path");',
      "const args = process.argv.slice(2);",
      'const config = args[args.indexOf("-p") + 1];',
      'const out = path.join(path.dirname(config), "..", "WebResources", "js", "account.js");',
      "fs.mkdirSync(path.dirname(out), { recursive: true });",
      'fs.writeFileSync(out, "var a = 1;\\n");',
      'if (args.includes("--listEmittedFiles")) console.log(`TSFILE: ${out.split(path.sep).join("/")}`);',
    ].join("\n"));
    if (process.platform === "win32") fs.writeFileSync(path.join(bin, "tsc.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
    else {
      fs.writeFileSync(path.join(bin, "tsc"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
      fs.chmodSync(path.join(bin, "tsc"), 0o755);
    }
    out("ui/tenantContext.js").selectTenant(fakeClient(dir));
    const tsmod = out("commands/typescript.js");
    S.messages.length = 0;
    await tsmod.compileAndPush(src, false);
    assert.ok(S.messages.some((m) => m[0] === "status" && m[1] === "$(check) Compiled account.js"), JSON.stringify(S.messages));
    const emitted = [path.join(dir, "WebResources", "js", "account.js").split(path.sep).join("/")];
    assert.strictEqual(tsmod.outputFor(path.join(ts, "tsconfig.json"), src, emitted), path.join(dir, "WebResources", "js", "account.js"));
    // tsc 6 (rootDir defaults to the tsconfig's folder), or a src/forms/account.ts beside another file: the longest match.
    const deeper = ["src/forms/account.js", "account.js"].map((p) => path.join(dir, "WebResources", "js", p));
    assert.strictEqual(tsmod.outputFor(path.join(ts, "tsconfig.json"), src, deeper), deeper[0]);
    out("ui/tenantContext.js").selectTenant(undefined);
  });

  // ---------- new plug-in class ----------

  await test("New Plug-in Class: an old-style project gets a Compile Include for the file", async () => {
    const dir = tmp();
    const projDir = path.join(dir, "Plugins");
    fs.mkdirSync(projDir);
    const csproj = path.join(projDir, "Acme.Plugins.csproj");
    fs.writeFileSync(csproj, '<?xml version="1.0" encoding="utf-8"?>\r\n<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\r\n  <ItemGroup>\r\n    <Compile Include="AccountPlugin.cs" />\r\n  </ItemGroup>\r\n</Project>\r\n');
    const client = fakeClient(dir);
    out("ui/tenantContext.js").selectTenant(client);
    out("commands/scaffold.js").registerScaffolding(() => {});
    S.quickPickAnswers.push("Plug-in");
    S.inputAnswers.push("ContactPlugin");
    S.messages.length = 0;
    await S.commands.get("lantern.plugins.newClass")({ client, plugin: { project: csproj, assembly: "Acme.Plugins" } });
    assert.deepStrictEqual(S.messages.filter((m) => m[0] === "error"), []);
    assert.ok(fs.existsSync(path.join(projDir, "ContactPlugin.cs")));
    assert.match(fs.readFileSync(csproj, "utf8"), /<Compile Include="ContactPlugin\.cs" \/>/);
    out("ui/tenantContext.js").selectTenant(undefined);
  });

  // ---------- reading JavaScript ----------

  const ca = out("core/codeanalysis.js");

  await test("JS outline: setTimeout(function () { … }) isn't a definition; if/for/while aren't either", () => {
    const js = [
      "function onLoad(ctx) {",
      "  setTimeout(function () {",
      '    ctx.getFormContext().getAttribute("name").setValue("x");',
      "  }, 10);",
      "}",
      "var Acme = {",
      "  save(ctx) {",
      "    return 1;",
      "  },",
      "};",
      "if (window.x) {",
      "}",
      "for (var i = 0; i < 1; i++) {",
      "}",
      "while (false) {",
      "}",
    ].join("\n");
    const outline = ca.outlineJs(js);
    assert.deepStrictEqual(outline.map((f) => f.name), ["onLoad", "save"]);
    assert.strictEqual(ca.functionAt(outline, js.indexOf("getAttribute")).name, "onLoad", "where-used names the form event's handler");
  });

  await test("JS calls: a call at the start of a line is reported on that line", () => {
    const js = "function helper() {}\nfunction onLoad(ctx) {\nhelper();\n}\n";
    const outline = ca.outlineJs(js);
    const t = ca.analyzeJsFunction(js, outline.find((f) => f.name === "onLoad"), outline);
    assert.deepStrictEqual(t.calls, [{ name: "helper", line: 2 }]);
  });

  await test("form script diagnostics: a tab named tab is underlined inside its quotes, not in tabs", () => {
    const dg = out("ui/diagnostics.js");
    const src = 'function f(fc) {\n  fc.ui.tabs.get("tab").setVisible(false);\n}';
    const forms = [{ id: "1", name: "Main", type: "Main", header: [], libraries: [], events: [], tabs: [{ name: "general", label: "General", visible: true, sections: [] }] }];
    const p = dg.findScriptProblems(src, "account", [], forms).find((x) => /No tab named tab/.test(x.message));
    assert.deepStrictEqual([p.start, p.end], [src.indexOf('"tab"') + 1, src.indexOf('"tab"') + 4]);
  });

  // ---------- reading C# ----------

  await test('C# types: @"""" is a verbatim string holding a quote, not a raw string', () => {
    const cs = out("core/csharp.js");
    const code = [
      "namespace Acme {",
      '  public class Util { public static string Q(string s) => s.Replace("\\"", @""""); }',
      "  public class AccountPlugin : IPlugin { public void Execute(System.IServiceProvider sp) {} }",
      '  public class Raw { string s = """ { """; }',
      "  public class After {}",
      "}",
    ].join("\n");
    assert.deepStrictEqual(cs.csharpTypes(code).map((t) => t.fullName), ["Acme.Util", "Acme.AccountPlugin", "Acme.Raw", "Acme.After"]);
    assert.deepStrictEqual(cs.pluginClassesIn(cs.csharpTypes(code)).map((t) => t.fullName), ["Acme.AccountPlugin"]);
  });

  // ---------- table queries ----------

  await test("Deactivated rows: a table with more than two states isn't filtered on state 1", () => {
    const md = out("commands/metadata.js");
    const t = { logicalName: "opportunity", displayName: "Opportunity", primaryId: "opportunityid", primaryName: "name" };
    const cols = [
      { logicalName: "name", type: "String" },
      { logicalName: "statecode", type: "State", options: opt([[0, "Open"], [1, "Won"], [2, "Lost"]]) },
      { logicalName: "statuscode", type: "Status" },
      { logicalName: "modifiedon", type: "DateTime" },
    ];
    assert.strictEqual(md.inactiveSql(t, cols), "-- Opportunity rows that aren't Open: Won, Lost\nSELECT TOP 1000 name, statuscode, modifiedon, statecode\nFROM opportunity\nWHERE statecode <> 0\nORDER BY modifiedon DESC");
    const account = { logicalName: "account", displayName: "Account", primaryId: "accountid", primaryName: "name" };
    cols[1] = { logicalName: "statecode", type: "State", options: opt([[0, "Active"], [1, "Inactive"]]) };
    assert.strictEqual(md.inactiveSql(account, cols), "-- Deactivated Account rows\nSELECT TOP 1000 name, statuscode, modifiedon\nFROM account\nWHERE statecode = 1\nORDER BY modifiedon DESC");
  });

  console.log(`${passed} codegen regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    // a process that just exited can hold its folder for a moment on Windows
  }
  if (failures.length) process.exitCode = 1;
})();
