// Regression tests for the command bar (ribbon) editor, modern commands, environment compare,
// column tracing and dependency bugs.
// Run with: npm run compile && node test/regression/ribbon.js (LANTERN_OUT=<dir> to test another build).
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
const vm = require("vm");
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
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lantern-ribbon-"));
const clone = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  const rm = out("core/ribbonModel.js");
  const pub = out("core/ribbonPublish.js");
  const mc = out("core/modernCommands.js");
  const { writeZip, readZip } = out("core/zip.js");
  const dvm = out("core/dataverse.js");
  dvm.timing.sleep = async () => {};

  /** Every Id attribute and LocLabel Id in a RibbonDiffXml text. */
  const idsIn = (xml) => [...xml.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]);
  const ribbon = (body, defs = "") => `<RibbonDefinitions><RibbonDefinition><UI><Ribbon><Tabs>${body}</Tabs></Ribbon></UI>${defs}</RibbonDefinition></RibbonDefinitions>`;

  // ---------- writing the client's RibbonDiffXml back ----------

  // The environment's merged ribbon: a Microsoft flyout with the client's menu item in it, and a group the client adds.
  const ENV = ribbon(`<Tab Id="Mscrm.Form.account.MainTab" Sequence="10"><Groups Id="Mscrm.Form.account.MainTab.Groups">
    <Group Id="Mscrm.Form.account.MainTab.Actions" Sequence="10" Title="Actions"><Controls Id="Mscrm.Form.account.MainTab.Actions.Controls">
      <FlyoutAnchor Id="Mscrm.Form.account.RunReport" Sequence="10" LabelText="Run Report" Command="Mscrm.ReportMenu.Form"><Menu Id="Mscrm.Form.account.RunReport.Menu"><MenuSection Id="Mscrm.Form.account.RunReport.Menu.Sec" Sequence="10"><Controls Id="Mscrm.Form.account.RunReport.Menu.Sec.Controls">
        <Button Id="acme.Form.account.MyReport.Button" Sequence="50" LabelText="$LocLabels:acme.MyReport.Label" Command="acme.account.RunMyReport" />
      </Controls></MenuSection></Menu></FlyoutAnchor>
    </Controls></Group>
    <Group Id="acme.Form.account.Grp" Sequence="99" Title="$LocLabels:acme.Grp.Title" Template="acme.Templates.Two"><Controls Id="acme.Form.account.Grp.Controls">
      <Button Id="acme.Form.account.Approve.Button" Sequence="10" LabelText="$LocLabels:acme.Approve.Label" Command="acme.account.Approve" TemplateAlias="o1" />
      <Button Id="acme.Form.account.Reject.Button" Sequence="20" LabelText="$LocLabels:acme.Reject.Label" Command="acme.account.Approve" TemplateAlias="o1" />
    </Controls></Group>
  </Groups></Tab>`, `<CommandDefinitions>
    <CommandDefinition Id="acme.account.Approve"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.approve" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition>
    <CommandDefinition Id="acme.account.RunMyReport"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.report" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition>
  </CommandDefinitions>`);
  const DIFF = `<RibbonDiffXml>
    <CustomActions>
      <CustomAction Id="acme.Form.account.Grp.CustomAction" Location="Mscrm.Form.account.MainTab.Groups._children" Sequence="99"><CommandUIDefinition>
        <Group Id="acme.Form.account.Grp" Sequence="99" Title="$LocLabels:acme.Grp.Title" Template="acme.Templates.Two"><Controls Id="acme.Form.account.Grp.Controls">
          <Button Id="acme.Form.account.Approve.Button" Sequence="10" LabelText="$LocLabels:acme.Approve.Label" Command="acme.account.Approve" TemplateAlias="o1" />
          <Button Id="acme.Form.account.Reject.Button" Sequence="20" LabelText="$LocLabels:acme.Reject.Label" Command="acme.account.Approve" TemplateAlias="o1" />
        </Controls></Group></CommandUIDefinition></CustomAction>
      <CustomAction Id="acme.Form.account.Grp.MaxSize.CustomAction" Location="Mscrm.Form.account.MainTab.Scaling._children" Sequence="120"><CommandUIDefinition>
        <MaxSize Id="acme.Form.account.Grp.MaxSize" GroupId="acme.Form.account.Grp" Sequence="99" Size="LargeMedium" /></CommandUIDefinition></CustomAction>
      <CustomAction Id="acme.Form.account.Grp.Scale.CustomAction" Location="Mscrm.Form.account.MainTab.Scaling._children" Sequence="130"><CommandUIDefinition>
        <Scale Id="acme.Form.account.Grp.Scale" GroupId="acme.Form.account.Grp" Sequence="130" Size="Popup" /></CommandUIDefinition></CustomAction>
      <CustomAction Id="acme.Form.account.MyReport.CustomAction" Location="Mscrm.Form.account.RunReport.Menu.Sec.Controls._children" Sequence="50"><CommandUIDefinition>
        <Button Id="acme.Form.account.MyReport.Button" Sequence="50" LabelText="$LocLabels:acme.MyReport.Label" Command="acme.account.RunMyReport" /></CommandUIDefinition></CustomAction>
    </CustomActions>
    <Templates><RibbonTemplates Id="Mscrm.Templates"><GroupTemplate Id="acme.Templates.Two"><Layout Title="Large"><OverflowSection Type="OneRow" TemplateAlias="o1" DisplayMode="Large" /></Layout></GroupTemplate></RibbonTemplates></Templates>
    <CommandDefinitions>
      <CommandDefinition Id="acme.account.Approve"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.approve" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition>
      <CommandDefinition Id="acme.account.RunMyReport"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.report" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition>
    </CommandDefinitions>
    <RuleDefinitions><TabDisplayRules><TabDisplayRule TabCommand="acme.account.Tab.Command"><EntityRule EntityName="account" Context="Form" /></TabDisplayRule></TabDisplayRules><DisplayRules /><EnableRules /></RuleDefinitions>
    <LocLabels>
      <LocLabel Id="acme.Grp.Title"><Titles><Title description="Acme" languagecode="1033" /><Title description="Acme DE" languagecode="1031" /></Titles></LocLabel>
      <LocLabel Id="acme.Approve.Label"><Titles><Title description="Approve" languagecode="1033" /></Titles></LocLabel>
      <LocLabel Id="acme.Reject.Label"><Titles><Title description="Reject" languagecode="1033" /></Titles></LocLabel>
      <LocLabel Id="acme.MyReport.Label"><Titles><Title description="My report" languagecode="1033" /></Titles></LocLabel>
    </LocLabels>
  </RibbonDiffXml>`;
  const loaded = () => rm.applyDiff(rm.parseRibbonXml(ENV, "account", "Form"), rm.parseRibbonDiff(DIFF), "client");

  await test("command bar: saving with no edits keeps every Id, LocLabel, template and tab display rule of the RibbonDiffXml", () => {
    const xml = rm.serializeRibbonDiff(loaded()).xml;
    assert.deepStrictEqual([...new Set(idsIn(xml))].sort(), [...new Set(idsIn(DIFF))].sort(), "the same Ids, MaxSize, Scale, the menu item in Microsoft's flyout and the group title's label included");
    const again = rm.parseRibbonDiff(xml);
    assert.deepStrictEqual(again.locLabels["acme.Grp.Title"], [{ languagecode: "1033", description: "Acme" }, { languagecode: "1031", description: "Acme DE" }]);
    assert.match(xml, /<GroupTemplate Id="acme.Templates.Two">[\s\S]*<OverflowSection Type="OneRow"/);
    assert.match(xml, /<TabDisplayRule TabCommand="acme.account.Tab.Command">\s*<EntityRule EntityName="account" Context="Form" \/>/);
    assert.match(xml, /Location="Mscrm.Form.account.RunReport.Menu.Sec.Controls._children"/, "the menu item keeps its place in the flyout");
  });

  await test("command bar: edits and removals of controls inside the client's own group are written", () => {
    const m = loaded();
    const group = m.tabs[0].groups.find((g) => g.id === "acme.Form.account.Grp");
    const approve = group.controls.find((c) => c.id === "acme.Form.account.Approve.Button");
    assert.strictEqual(approve.origin, "client");
    approve.sequence = 5;
    approve.command = "acme.account.RunMyReport";
    group.controls = group.controls.filter((c) => c.id !== "acme.Form.account.Reject.Button");
    const xml = rm.serializeRibbonDiff(m).xml;
    assert.match(xml, /<Button Id="acme.Form.account.Approve.Button" Sequence="5"[^>]*Command="acme.account.RunMyReport"/);
    assert.ok(!xml.includes("acme.Form.account.Reject.Button"), "the removed button is gone");
    assert.match(xml, /<MaxSize Id="acme.Form.account.Grp.MaxSize"/);
  });

  await test("command bar: the local RibbonDiffXml's command and rule win over the environment's older published ones", () => {
    const env = ribbon(`<Tab Id="Mscrm.Form.account.MainTab" Sequence="10"><Groups Id="g"><Group Id="Mscrm.Form.account.MainTab.Save" Sequence="10" Title="Save"><Controls Id="Mscrm.Form.account.MainTab.Save.Controls">
      <Button Id="Mscrm.Form.account.Delete" Sequence="10" LabelText="Delete" Command="Mscrm.DeletePrimaryRecord" />
      <Button Id="acme.Form.account.Approve.Button" Sequence="70" LabelText="Approve" Command="acme.account.Approve" />
    </Controls></Group></Groups></Tab>`, `<CommandDefinitions><CommandDefinition Id="acme.account.Approve"><EnableRules><EnableRule Id="acme.account.CanApprove" /></EnableRules><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.approveV1" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition></CommandDefinitions>
      <RuleDefinitions><EnableRules><EnableRule Id="acme.account.CanApprove"><FormStateRule State="Existing" /></EnableRule></EnableRules></RuleDefinitions>`);
    const local = `<RibbonDiffXml><CustomActions><CustomAction Id="acme.Approve.CA" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="70"><CommandUIDefinition>
      <Button Id="acme.Form.account.Approve.Button" Sequence="80" LabelText="Approve it" Command="acme.account.Approve" /></CommandUIDefinition></CustomAction></CustomActions>
      <CommandDefinitions><CommandDefinition Id="acme.account.Approve"><EnableRules><EnableRule Id="acme.account.CanApprove" /></EnableRules><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.approveV2" Library="$webresource:acme_/a.js"><CrmParameter Value="PrimaryControl" /></JavaScriptFunction></Actions></CommandDefinition></CommandDefinitions>
      <RuleDefinitions><EnableRules><EnableRule Id="acme.account.CanApprove"><FormStateRule State="Existing" /><CustomRule FunctionName="Acme.canApprove" Library="$webresource:acme_/a.js" Default="false" /></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>`;
    const m = rm.applyDiff(rm.parseRibbonXml(env, "account", "Form"), rm.parseRibbonDiff(local), "client");
    m.hidden.push({ id: "Mscrm.Form.account.Delete", location: "Mscrm.Form.account.MainTab.Save.Controls._children", origin: "client" });
    const xml = rm.serializeRibbonDiff(m).xml;
    assert.match(xml, /FunctionName="Acme.approveV2"[\s\S]*<CrmParameter Value="PrimaryControl" \/>/);
    assert.ok(!xml.includes("approveV1"));
    assert.match(xml, /<CustomRule FunctionName="Acme.canApprove"/);
    assert.match(xml, /<Button Id="acme.Form.account.Approve.Button"[^>]*Sequence="80"[^>]*LabelText="Approve it"/, "the client's copy of the button too");
  });

  await test("command bar: a flyout inside a split button's menu keeps its own menu sections (no duplicate Ids)", () => {
    const split = `<SplitButton Id="acme.Form.account.Split" Sequence="70" LabelText="Split" Command="acme.cmd"><Menu Id="acme.Form.account.Split.Menu"><MenuSection Id="acme.Form.account.Split.Sec" Sequence="10"><Controls Id="acme.Form.account.Split.Sec.Controls">
      <Button Id="acme.Form.account.Split.A" Sequence="10" LabelText="A" Command="acme.cmd" />
      <FlyoutAnchor Id="acme.Form.account.Split.Fly" Sequence="20" LabelText="More" Command="acme.cmd"><Menu Id="acme.Form.account.Split.Fly.Menu"><MenuSection Id="acme.Form.account.Split.Fly.Sec" Sequence="10"><Controls Id="acme.Form.account.Split.Fly.Sec.Controls">
        <Button Id="acme.Form.account.Split.Fly.B" Sequence="10" LabelText="B" Command="acme.cmd" />
      </Controls></MenuSection></Menu></FlyoutAnchor>
    </Controls></MenuSection></Menu></SplitButton>`;
    const cmd = `<CommandDefinitions><CommandDefinition Id="acme.cmd"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="A.b" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition></CommandDefinitions>`;
    const env = ribbon(`<Tab Id="Mscrm.Form.account.MainTab" Sequence="10"><Groups Id="g"><Group Id="Mscrm.Form.account.MainTab.Save" Sequence="10" Title="Save"><Controls Id="Mscrm.Form.account.MainTab.Save.Controls">${split}</Controls></Group></Groups></Tab>`, cmd);
    const diff = `<RibbonDiffXml><CustomActions><CustomAction Id="acme.Split.CA" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="70"><CommandUIDefinition>${split}</CommandUIDefinition></CustomAction></CustomActions>${cmd}</RibbonDiffXml>`;
    const m = rm.applyDiff(rm.parseRibbonXml(env, "account", "Form"), rm.parseRibbonDiff(diff), "client");
    assert.deepStrictEqual(m.tabs[0].groups[0].controls[0].children.map((c) => c.id), ["acme.Form.account.Split.Sec"]);
    assert.deepStrictEqual(rm.ribbonEditProblems(m, {}), [], "nothing says another control has its Id");
    const ids = idsIn(rm.serializeRibbonDiff(m).xml);
    assert.deepStrictEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
    assert.deepStrictEqual([...new Set(ids)].filter((x) => x !== "Mscrm.Templates").sort(), [...new Set(idsIn(diff))].sort());
  });

  // ---------- Open Command Bar… end to end, with a fake environment ----------

  const auth = out("ui/auth.js");
  const cb = out("commands/commandBar.js");
  const zipB64 = (xml) => writeZip([{ name: "RibbonXml.xml", data: Buffer.from(xml) }]).toString("base64");
  const solutionZip = (customizations) => writeZip([{ name: "solution.xml", data: Buffer.from("<ImportExportXml />") }, { name: "customizations.xml", data: Buffer.from(customizations) }]);
  const customizationsOf = (b64) => readZip(Buffer.from(b64, "base64")).find((e) => e.name === "customizations.xml").data.toString("utf8");
  const accountEntity = (diff) => `<ImportExportXml><Entities><Entity><Name LocalizedName="Account" OriginalName="Account">Account</Name><EntityInfo><entity Name="account" /></EntityInfo>${diff}</Entity></Entities></ImportExportXml>`;
  const writeSolution = (root, name, diff) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "Other"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Other", "Solution.xml"), `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName></SolutionManifest></ImportExportXml>`);
    fs.mkdirSync(path.join(dir, "Entities", "Account"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Entities", "Account", "Entity.xml"), '<Entity><Name LocalizedName="Account" OriginalName="Account">Account</Name></Entity>');
    if (diff) fs.writeFileSync(path.join(dir, "Entities", "Account", "RibbonDiff.xml"), diff);
    return path.join(dir, "Entities", "Account", "RibbonDiff.xml");
  };
  const SAVE_GROUP = (buttons) => ribbon(`<Tab Id="Mscrm.Form.account.MainTab" Sequence="10"><Groups Id="g"><Group Id="Mscrm.Form.account.MainTab.Save" Sequence="10" Title="Save"><Controls Id="Mscrm.Form.account.MainTab.Save.Controls">
    <Button Id="Mscrm.Form.account.Delete" Sequence="10" LabelText="Delete" Command="Mscrm.DeletePrimaryRecord" />${buttons}</Controls></Group></Groups></Tab>`);
  const HIDE_DELETE = { id: "Mscrm.Form.account.Delete", location: "Mscrm.Form.account.MainTab.Save.Controls._children", origin: "client" };

  /** Opens the command bar of account against a fake environment; `page` plays the page (and gets the environment's record). */
  async function commandBar(o, page) {
    const env = { imported: [], rows: new Map((o.rows || []).map((r) => [r.appactionid, r.uniquename])), created: 0, known: new Set(o.known || []) };
    const dv = {
      getJson: async (p) => {
        const d = decodeURIComponent(p);
        if (d.startsWith("RetrieveEntityRibbon")) return { CompressedEntityXml: zipB64(/Filters'Form'/.test(d) ? o.formRibbon : ribbon("")) };
        if (d.startsWith("asyncoperations(")) return { statecode: 3, statuscode: 30 };
        throw new Error(`unexpected GET ${d}`);
      },
      getAll: async (p) => (p.startsWith("appactions") ? (o.rows || []) : p.startsWith("appmodules") ? [{ appmoduleid: "app1", name: "Sales Hub", uniquename: "acme_SalesHub" }] : p.startsWith("entities?") ? [{ entityid: "e1" }] : []),
      actionJson: async (name, body) => {
        if (name === "ExportSolution") return { ExportSolutionFile: (o.exported || solutionZip(accountEntity(""))).toString("base64") };
        env.imported.push(body.CustomizationFile);
        return { AsyncOperationId: "op1" };
      },
      action: async () => {},
      findWebResource: async (name) => (env.known.has(name) ? { id: `wr-${name}`, name, type: 3, content: "" } : undefined),
      create: async (set, body) => { const id = `new-${++env.created}`; env.rows.set(id, body.uniquename); return id; },
      update: async () => {},
      remove: async (p) => { const id = /^appactions\(([^)]+)\)$/.exec(p)?.[1]; if (id && !env.rows.delete(id)) throw new Error(`Dataverse returned 404 for DELETE appactions(${id}).`); },
    };
    auth.dataverseFor = () => dv;
    const client = { name: "Acme", dir: o.dir || tmp(), envName: "DEV", orgHost: "acme.crm.dynamics.com", isProtected: false, environments: [], config: { org: "https://acme.crm.dynamics.com", solutions: o.solutions || ["AcmeCore"], publisherPrefix: "acme", webResourceRoots: [], environments: [] } };
    S.panelAnswers.push(async (state, panel) => {
      const draft = clone(state.draft);
      const submit = async (d) => {
        const before = panel.webview.posted.length;
        await panel.webview.send({ type: "submit", draft: clone(d) });
        return panel.webview.posted.slice(before);
      };
      await page(draft, submit, env, state);
      if (!panel.disposed) await panel.webview.send({ type: "cancel" });
    });
    await cb.openCommandBar({ kind: "table", client, table: { logicalName: "account", displayName: "Account" } }, () => ({}), {});
    return env;
  }

  await test("command bar publish: a button the solution has that the page never showed as the client's survives (Ribbon Workbench)", async () => {
    const workbench = `<RibbonDiffXml><CustomActions>
      <CustomAction Id="acme.Form.account.Approve.CA" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="70"><CommandUIDefinition><Button Id="acme.Form.account.Approve.Button" Command="acme.account.Approve" Sequence="70" LabelText="$LocLabels:acme.Approve.Label" TemplateAlias="o1" /></CommandUIDefinition></CustomAction>
      <CustomAction Id="acme.Form.account.Save.MaxSize.CA" Location="Mscrm.Form.account.MainTab.Scaling._children" Sequence="10"><CommandUIDefinition><MaxSize Id="acme.Form.account.Save.MaxSize" GroupId="Mscrm.Form.account.MainTab.Save" Sequence="10" Size="Large" /></CommandUIDefinition></CustomAction>
    </CustomActions><CommandDefinitions><CommandDefinition Id="acme.account.Approve"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.approve" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition></CommandDefinitions>
    <LocLabels><LocLabel Id="acme.Approve.Label"><Titles><Title description="Approve" languagecode="1033" /><Title description="Genehmigen" languagecode="1031" /></Titles></LocLabel></LocLabels></RibbonDiffXml>`;
    const env = await commandBar({
      formRibbon: SAVE_GROUP('<Button Id="acme.Form.account.Approve.Button" Command="acme.account.Approve" Sequence="70" LabelText="Approve" />'),
      exported: solutionZip(accountEntity(workbench)),
    }, async (draft, submit) => {
      draft.model.hidden.push(HIDE_DELETE);
      draft.publish = true;
      draft.solution = "AcmeCore";
      const replies = await submit(draft);
      assert.deepStrictEqual(replies.filter((r) => r.type !== "status"), [], "the save went through");
    });
    assert.strictEqual(env.imported.length, 1);
    const text = customizationsOf(env.imported[0]);
    assert.match(text, /<Button Id="acme.Form.account.Approve.Button"/);
    assert.match(text, /<CommandDefinition Id="acme.account.Approve"/);
    assert.match(text, /<MaxSize Id="acme.Form.account.Save.MaxSize"/);
    assert.match(text, /<Title description="Genehmigen" languagecode="1031" \/>/);
    assert.match(text, /<HideCustomAction HideActionId="Mscrm.Form.account.Delete"/);
  });

  await test("command bar publish: what the page removed leaves the solution; what it never knew stays", async () => {
    const mine = `<RibbonDiffXml><CustomActions><CustomAction Id="acme.Mine.CA" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="80"><CommandUIDefinition><Button Id="acme.Form.account.Mine.Button" Command="acme.account.Mine" Sequence="80" LabelText="Mine" TemplateAlias="o1" /></CommandUIDefinition></CustomAction></CustomActions>
      <CommandDefinitions><CommandDefinition Id="acme.account.Mine"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="Acme.mine" Library="$webresource:acme_/a.js" /></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>`;
    const published = mine.replace("</CustomActions>", '<CustomAction Id="acme.Other.CA" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="90"><CommandUIDefinition><Button Id="acme.Form.account.Other.Button" Command="acme.account.Mine" Sequence="90" LabelText="Other" TemplateAlias="o1" /></CommandUIDefinition></CustomAction></CustomActions>');
    const dir = tmp();
    const file = writeSolution(dir, "AcmeCore", mine);
    const env = await commandBar({
      dir,
      formRibbon: SAVE_GROUP('<Button Id="acme.Form.account.Mine.Button" Command="acme.account.Mine" Sequence="80" LabelText="Mine" /><Button Id="acme.Form.account.Other.Button" Command="acme.account.Mine" Sequence="90" LabelText="Other" />'),
      exported: solutionZip(accountEntity(published)),
    }, async (draft, submit) => {
      const group = draft.model.tabs[0].groups[0];
      group.controls = group.controls.filter((c) => c.id !== "acme.Form.account.Mine.Button");
      draft.publish = true;
      const replies = await submit(draft);
      assert.deepStrictEqual(replies.filter((r) => r.type !== "status"), [], "the save went through");
    });
    const text = customizationsOf(env.imported[0]);
    assert.ok(!text.includes("acme.Form.account.Mine.Button"), "the removed button isn't put back");
    assert.match(text, /<Button Id="acme.Form.account.Other.Button"/);
    assert.ok(!fs.readFileSync(file, "utf8").includes("acme.Form.account.Mine.Button"));
  });

  await test("command bar publish: a RibbonDiffXml that would drop what the solution holds is refused before the import", async () => {
    const zip = solutionZip(accountEntity('<RibbonDiffXml><CustomActions><CustomAction Id="x.CA" Location="Mscrm.Form.account.MainTab.Save.Controls._children"><CommandUIDefinition><Button Id="acme.Keep.Button" Command="acme.Keep" /></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="acme.Keep"><Actions /></CommandDefinition></CommandDefinitions></RibbonDiffXml>'));
    const calls = [];
    const dv = { actionJson: async (name) => { calls.push(name); return name === "ExportSolution" ? { ExportSolutionFile: zip.toString("base64") } : { AsyncOperationId: "op1" }; }, getJson: async () => ({ statecode: 3, statuscode: 30 }), action: async () => calls.push("PublishXml") };
    await assert.rejects(pub.publishRibbonDiff(dv, "AcmeCore", "account", "<RibbonDiffXml />"), /would remove Button acme\.Keep\.Button, command acme\.Keep from the account command bar in AcmeCore/);
    assert.deepStrictEqual(calls, ["ExportSolution"], "nothing was imported");
  });

  await test("command bar: with two local solutions, only the target's RibbonDiffXml is written into its file, and it can't be published through the other", async () => {
    const dir = tmp();
    const diffOf = (btn) => `<RibbonDiffXml><CustomActions><CustomAction Id="${btn}.CA" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="70"><CommandUIDefinition><Button Id="${btn}" Sequence="70" LabelText="${btn}" Command="${btn}.Cmd" /></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="${btn}.Cmd"><EnableRules /><DisplayRules /><Actions><JavaScriptFunction FunctionName="A.b" Library="$webresource:x.js" /></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>`;
    const core = writeSolution(dir, "Core", diffOf("core.Form.account.A.Button"));
    const sales = writeSolution(dir, "Sales", diffOf("sales.Form.account.B.Button"));
    const salesBefore = fs.readFileSync(sales, "utf8");
    let status;
    const env = await commandBar({ dir, solutions: ["Core", "Sales"], formRibbon: SAVE_GROUP("") }, async (draft, submit, _env, state) => {
      assert.deepStrictEqual(state.localSolutions, ["Core"]);
      assert.strictEqual(draft.solution, "Core");
      draft.model.hidden.push(HIDE_DELETE);
      draft.publish = true;
      draft.solution = "Sales";
      status = (await submit(draft)).find((r) => r.type === "status");
      draft.publish = false;
      draft.writeLocal = true;
      await submit(draft);
    });
    assert.deepStrictEqual(status && status.status.problems, [{ field: "solution", text: "The RibbonDiffXml here is Core's: publish it through Core." }]);
    assert.strictEqual(env.imported.length, 0, "nothing was published through Sales");
    const written = fs.readFileSync(core, "utf8");
    assert.match(written, /core\.Form\.account\.A\.Button/);
    assert.match(written, /HideActionId="Mscrm.Form.account.Delete"/);
    assert.ok(!/sales\./.test(written), "Sales' button and command stay out of Core's file");
    assert.strictEqual(fs.readFileSync(sales, "utf8"), salesBefore);
  });

  const appaction = (id, uniquename, library) => ({
    appactionid: id, name: uniquename, uniquename, buttonlabeltext: uniquename, buttontooltiptitle: null, buttontooltipdescription: null, location: 0, type: 0, sequence: 20, hidden: false, isdisabled: false, grouptitle: null, fonticon: null,
    onclickeventtype: 2, onclickeventjavascriptfunctionname: "Acme.go", onclickeventjavascriptparameters: "PrimaryControl", onclickeventformulafunctionname: null, onclickeventformulacomponentname: null, onclickeventformulacomponentlibrary: null,
    visibilitytype: 0, visibilityformulafunctionname: null, visibilityformulacomponentname: null, visibilityformulacomponentlibrary: null,
    _appmoduleid_value: "app1", _parentappactionid_value: null, _iconwebresourceid_value: null, _onclickeventjavascriptwebresourceid_value: "w1",
    appmoduleid: { appmoduleid: "app1", name: "Sales Hub", uniquename: "acme_SalesHub" }, iconwebresourceid: null, onclickeventjavascriptwebresourceid: { webresourceid: "w1", name: library },
  });
  const freshModern = (uniqueName, library) => ({ uniqueName, name: uniqueName, label: uniqueName, location: 0, type: 0, sequence: 10, app: { id: "app1", name: "Sales Hub", uniqueName: "acme_SalesHub" }, hidden: false, disabled: false, onClick: { type: 2, functionName: "Acme.go", library, parameters: "" }, visibility: { type: 0 }, icon: {}, fresh: true });

  await test("modern commands: saving again after a Save stopped part-way doesn't delete twice or create twice", async () => {
    const env = await commandBar({ formRibbon: SAVE_GROUP(""), rows: [appaction("old-1", "acme_old", "acme_/a.js")], known: ["acme_/a.js"] }, async (draft, submit, env) => {
      draft.model.modern[0].removed = true;
      draft.model.modern.push(freshModern("acme_one", "acme_/a.js"), freshModern("acme_two", "acme_/b.js"));
      const first = await submit(draft);
      assert.ok(first.some((r) => r.type === "note"), "the first Save stops at acme_/b.js");
      assert.deepStrictEqual([...env.rows.values()], ["acme_one"]);
      env.known.add("acme_/b.js");
      const second = await submit(draft);
      assert.deepStrictEqual(second.filter((r) => r.type === "note"), [], "the second Save goes through");
    });
    assert.deepStrictEqual([...env.rows.values()].sort(), ["acme_one", "acme_two"]);
    assert.strictEqual(env.created, 2);
  });

  await test("modern commands: a DELETE that answers 404 (already gone) counts as done", async () => {
    const m = { ...mc.rowToCommand(appaction("gone-1", "acme_gone", "acme_/a.js")), removed: true };
    const written = [];
    await mc.saveModernCommands({ remove: async (p) => { throw new Error(`Dataverse returned 404 for DELETE ${p}.`); }, action: async () => {} }, { create: [], update: [], remove: [m] }, { table: "account", webResourceId: async () => undefined, written: (x, what, id) => written.push([what, id]) });
    assert.deepStrictEqual(written, [["removed", "gone-1"]]);
    await assert.rejects(mc.saveModernCommands({ remove: async () => { throw new Error("Dataverse returned 403 for DELETE appactions(x)."); }, action: async () => {} }, { create: [], update: [], remove: [m] }, { table: "account", webResourceId: async () => undefined }), /403/, "other failures still stop it");
  });

  // ---------- the page's Id boxes ----------

  /** The command bar page's own script, run in a sandbox; returns its functions and the draft. */
  const pageScript = (draft) => {
    const js = fs.readFileSync(path.join(OUT, "ui", "panels", "commandBarPanel.js"), "utf8");
    const start = js.indexOf("const SCRIPT = `") + "const SCRIPT = `".length;
    const raw = js.slice(start, js.indexOf("`;", start));
    const ctx = { draft, state: { prefix: "acme", table: "account" }, console };
    vm.createContext(ctx);
    vm.runInContext(eval("`" + raw + "`") + "\n;this.renameRecord = renameRecord; this.renameControl = renameControl;", ctx);
    return ctx;
  };

  await test("command bar page: typing a new rule's Id through an existing rule's Id doesn't overwrite or rewire it", () => {
    const show = { id: "acme.account.Show", kind: "enable", steps: [{ kind: "FormStateRule", attrs: { State: "Existing" }, parameters: [], text: "" }], origin: "client" };
    const model = { ...rm.emptyModel("account"), commands: { "acme.account.Approve": { id: "acme.account.Approve", enableRules: ["acme.account.Show"], displayRules: [], actions: [{ kind: "Url", url: "https://x", parameters: [], attrs: {} }], origin: "client" } }, enableRules: { "acme.account.Show": show } };
    const fresh = { id: "acme.account.Show2", kind: "enable", steps: [{ kind: "FormStateRule", attrs: { State: "Create" }, parameters: [], text: "" }], origin: "client", fresh: true };
    model.enableRules[fresh.id] = fresh;
    const page = pageScript({ model });
    const refs = (o, n) => { for (const c of Object.values(model.commands)) c.enableRules = c.enableRules.map((x) => (x === o ? n : x)); };
    page.renameRecord(model.enableRules, fresh, "acme.account.Show", refs);
    assert.strictEqual(model.enableRules["acme.account.Show"], show, "the existing rule is still there");
    assert.deepStrictEqual(rm.ribbonEditProblems(model, { prefix: "acme" }).map((p) => p.text), ["Another enable rule has the Id acme.account.Show."]);
    for (const v of ["acme.account.ShowO", "acme.account.ShowOnCreate"]) page.renameRecord(model.enableRules, fresh, v, refs);
    assert.deepStrictEqual(Object.keys(model.enableRules).sort(), ["acme.account.Show", "acme.account.ShowOnCreate"]);
    assert.deepStrictEqual(model.commands["acme.account.Approve"].enableRules, ["acme.account.Show"]);
    assert.strictEqual(model.enableRules["acme.account.Show"].steps[0].attrs.State, "Existing");
    assert.deepStrictEqual(rm.ribbonEditProblems(model, { prefix: "acme" }), []);
  });

  await test("command bar page: typing a new button's Id through another button's Id leaves that button's label alone", () => {
    const button = (id, label) => ({ id, kind: "button", tag: "Button", attrs: { TemplateAlias: "o1" }, label, labelKey: `$LocLabels:${id}.LabelText`, command: "Mscrm.SavePrimary", sequence: 80, children: [], origin: "client", localOnly: true, fresh: true });
    const a = button("acme.account.NewButton.Button", "Approve");
    const b = button("acme.account.NewButton2.Button", "Reject");
    const model = { ...rm.emptyModel("account"), tabs: [{ id: "Mscrm.Form.account.MainTab", location: "Form", attrs: {}, label: "", groups: [{ id: "Mscrm.Form.account.MainTab.Save", attrs: {}, label: "", controls: [a, b], origin: "microsoft" }], origin: "microsoft" }],
      commands: { "Mscrm.SavePrimary": { id: "Mscrm.SavePrimary", enableRules: [], displayRules: [], actions: [], origin: "microsoft" } },
      labels: { "acme.account.NewButton.Button.LabelText": "Approve", "acme.account.NewButton2.Button.LabelText": "Reject" },
      locLabels: { "acme.account.NewButton.Button.LabelText": [{ languagecode: "1033", description: "Approve" }], "acme.account.NewButton2.Button.LabelText": [{ languagecode: "1033", description: "Reject" }] } };
    const page = pageScript({ model });
    page.renameControl(b, "acme.account.NewButton.Button");
    assert.deepStrictEqual(model.locLabels["acme.account.NewButton.Button.LabelText"], [{ languagecode: "1033", description: "Approve" }]);
    assert.ok(rm.ribbonEditProblems(model, { prefix: "acme" }).some((p) => p.text === "Another control has this Id."), "the clash is reported");
    page.renameControl(b, "acme.account.NewButtonReject.Button");
    assert.deepStrictEqual(model.labels, { "acme.account.NewButton.Button.LabelText": "Approve", "acme.account.NewButtonReject.Button.LabelText": "Reject" });
    assert.deepStrictEqual([a.labelKey, b.labelKey], ["$LocLabels:acme.account.NewButton.Button.LabelText", "$LocLabels:acme.account.NewButtonReject.Button.LabelText"]);
    const xml = rm.serializeRibbonDiff(model).xml;
    assert.match(xml, /<LocLabel Id="acme.account.NewButton.Button.LabelText">\s*<Titles>\s*<Title description="Approve"/);
    assert.match(xml, /<LocLabel Id="acme.account.NewButtonReject.Button.LabelText">\s*<Titles>\s*<Title description="Reject"/);
  });

  // ---------- environment compare ----------

  const compare = out("core/compare.js");
  const side = (label, steps, forms = []) => ({
    label,
    dv: { getAll: async (p) => (p.startsWith("solutions?") ? [{ version: "1.0" }] : p.startsWith("sdkmessageprocessingsteps") ? steps : []), findWebResource: async () => undefined },
    service: { solutionTables: async () => (forms.length ? ["account"] : []), columns: async () => [], forms: async () => forms },
  });

  await test("compare: pre- and post-operation steps sharing the default name are compared apart", async () => {
    const step = (id, stage, statecode) => ({ sdkmessageprocessingstepid: id, name: "Acme.Plugins.AccountPlugin: Update of account", stage, mode: 0, statecode, rank: 1, filteringattributes: null, sdkmessageid: { name: "Update" }, sdkmessagefilterid: { primaryobjecttypecode: "account" }, plugintypeid: { typename: "Acme.Plugins.AccountPlugin", assemblyname: "Acme.Plugins" } });
    const r = await compare.compareEnvironments(side("DEV", [step("a", 20, 0), step("b", 40, 0)]), side("TEST", [step("a", 20, 1), step("b", 40, 0)]), "Acme");
    assert.strictEqual(r.counts.steps, 2);
    assert.deepStrictEqual(r.differences.map((d) => `${d.name}|${d.status}|${d.detail ?? ""}`), ["Acme.Plugins.AccountPlugin: Update of account (Pre-operation, Synchronous)|differs|on vs off"]);
  });

  await test("compare: two forms with one name and type are compared apart", async () => {
    const form = (id, libraries) => ({ id, name: "Information", type: "Main", tabs: [], header: [], events: [], libraries });
    const r = await compare.compareEnvironments(side("DEV", [], [form("f1", []), form("f2", ["acme_/a.js"])]), side("TEST", [], [form("f1", []), form("f2", [])]), "Acme");
    assert.deepStrictEqual(r.differences.map((d) => `${d.kind}|${d.name}|${d.status}|${d.detail ?? ""}`), ["Form|account: Information (Main) #2|differs|libraries differ"]);
  });

  // ---------- tracing a column ----------

  await test("trace column: in a CRLF library, the line is put in the function it's in", async () => {
    const outlines = out("core/componentOutlines.js");
    const fns = [];
    for (let i = 0; i < 40; i++) fns.push(`function helper${i}(ctx) {\n  var x = ${i};\n  return x;\n}`);
    fns.push('function onLoad(ctx) {\n  var f = ctx.getFormContext();\n  f.getAttribute("acme_status").setValue(1);\n}');
    const src = fns.join("\n").replace(/\n/g, "\r\n");
    const dv = { getJson: async () => { throw new Error("no"); }, getAll: async () => [], findWebResource: async (name) => ({ id: "1", name, type: 3, content: Buffer.from(src).toString("base64") }) };
    const forms = [{ name: "Main", type: "main", libraries: ["acme_/a.js"], events: [{ name: "onload", handlers: [{ functionName: "onLoad", libraryName: "acme_/a.js" }] }], tabs: [], header: [] }];
    const md = await outlines.traceColumn(dv, "account", "acme_status", forms, tmp());
    const hit = md.split("\n").find((l) => /acme_\/a\.js:\d+/.test(l));
    assert.match(hit, /acme_\/a\.js:163 in onLoad\(\)/);
  });

  // ---------- dependencies ----------

  await test("dependencies: a lookup that fails is reported as unchecked, not as nothing", async () => {
    const deps = out("core/dependencies.js");
    const analysis = out("commands/analysis.js");
    const failing = { getAll: async (p) => { if (p.startsWith("RetrieveDependentComponents")) throw new Error("Dataverse returned 500 for GET RetrieveDependentComponents."); return [{ requiredcomponentobjectid: "t1", requiredcomponenttype: 1 }]; }, getJson: async () => { throw new Error("x"); } };
    const result = await deps.fetchDependencies(failing, "11111111-1111-1111-1111-111111111111", 61, [{ metadataId: "t1", logicalName: "account", displayName: "Account" }]);
    const md = analysis.dependenciesMarkdown("acme_/a.js", 61, result, { orgHost: "acme.crm.dynamics.com", dir: tmp(), config: { webResourceRoots: [] } });
    assert.match(md, /## Used by \(unknown\)[\s\S]*Couldn't check:\*\* Dataverse returned 500/);
    assert.ok(!/## Used by \(0\)/.test(md));
    assert.match(md, /## Uses \(1\)[\s\S]*- Account \(account\)/, "the side that answered is still listed");
  });

  if (S.panelErrors) failures.push(...S.panelErrors.map((e) => `panel answer: ${e.message}`));
  console.log(`${passed} ribbon regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  if (failures.length) process.exitCode = 1;
})();
