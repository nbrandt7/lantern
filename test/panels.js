// Drives the editor-tab forms (src/ui/panels) through the vscode mock: the page's
// messages in, the core functions' inputs out. Run with: npm run compile && node test/panels.js
const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? require.resolve("./mock-vscode") : resolve.call(this, request, ...rest);
};
const assert = require("assert");
const path = require("path");
const S = require("./mock-vscode").__state;
const out = (m) => require(path.join(__dirname, "..", "out", m));

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
const lastPanel = () => S.panels[S.panels.length - 1];
const lastStatus = (panel) => { const m = panel.webview.posted.filter((m) => m.type === "status").pop(); return m && m.status; };
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  const props = out("commands/pluginProperties.js");
  const reg = out("core/pluginRegistration.js");
  const meta = {
    name: "Acme.Plugins", version: "1.0.0.0", culture: "neutral", signed: true, references: [],
    pluginClasses: [{ typeName: "Acme.Plugins.AccountPlugin", kind: "plugin" }, { typeName: "Acme.Plugins.CopyText", kind: "workflow" }],
  };

  await test("registration panel: the page gets the state, the submitted draft reaches registerAssembly", async () => {
    let seen;
    S.panelAnswers.push((state, panel) => {
      seen = { state, panel };
      assert.strictEqual(state.mode, "register");
      assert.strictEqual(state.draft.isolationMode, reg.ISOLATION_SANDBOX);
      assert.deepStrictEqual(state.draft.types.map((t) => [t.typeName, t.workflow, t.workflowGroup]), [["Acme.Plugins.AccountPlugin", false, ""], ["Acme.Plugins.CopyText", true, "Acme.Plugins (1.0.0.0)"]]);
      const draft = JSON.parse(JSON.stringify(state.draft));
      draft.description = "  Account rules ";
      draft.isolationMode = reg.ISOLATION_NONE;
      draft.types[0].friendlyName = "Account Plugin";
      draft.types[0].description = "Keeps accounts tidy";
      draft.types[1].workflowGroup = "Acme";
      return { type: "submit", draft };
    });
    const details = await props.askAssemblyDetails(meta, "DEV");
    assert.ok(seen.panel.disposed, "the panel closes after the submit");
    assert.strictEqual(seen.panel.options.retainContextWhenHidden, false);
    assert.strictEqual(seen.panel.title, "Register Plug-in Assembly");
    assert.match(seen.panel.webview.html, /Content-Security-Policy[^>]*script-src 'nonce-/);
    assert.deepStrictEqual(details, {
      description: "Account rules",
      isolationMode: reg.ISOLATION_NONE,
      types: {
        "Acme.Plugins.AccountPlugin": { name: "Acme.Plugins.AccountPlugin", friendlyName: "Account Plugin", description: "Keeps accounts tidy", workflowGroup: undefined },
        "Acme.Plugins.CopyText": { name: "Acme.Plugins.CopyText", friendlyName: undefined, description: undefined, workflowGroup: "Acme" },
      },
    });
    // The same details through the core function: what Dataverse would receive.
    const created = [];
    const dv = { create: async (set, body) => { created.push([set, body]); return `${set}-id`; } };
    const result = await reg.registerAssembly(dv, meta, Buffer.from("dll"), { details, solution: "AcmeCore" });
    assert.strictEqual(result.assemblyId, "pluginassemblies-id");
    assert.deepStrictEqual([created[0][1].description, created[0][1].isolationmode], ["Account rules", reg.ISOLATION_NONE]);
    assert.deepStrictEqual([created[1][1].friendlyname, created[1][1].description], ["Account Plugin", "Keeps accounts tidy"]);
    assert.strictEqual(created[2][1].workflowactivitygroupname, "Acme");
    assert.match(created[2][1].friendlyname, /^[0-9a-f-]{36}$/, "no display name: a generated ID, the Plugin Registration Tool's default");
  });

  await test("registration panel: an invalid draft is refused with the problem on its field, then a fixed one goes through", async () => {
    S.panelAnswers.push(async (state, panel) => {
      const draft = JSON.parse(JSON.stringify(state.draft));
      draft.types[1].workflowGroup = "";
      draft.types[0].name = "";
      await panel.webview.send({ type: "submit", draft });
      const status = lastStatus(panel);
      assert.deepStrictEqual(status.problems, [
        { field: "type:Acme.Plugins.AccountPlugin:name", text: "AccountPlugin needs a name." },
        { field: "type:Acme.Plugins.CopyText:workflowGroup", text: "CopyText needs a workflow activity group." },
      ]);
      assert.ok(!panel.disposed, "the panel stays open");
      draft.types[0].name = "AccountPlugin";
      draft.types[1].workflowGroup = "Acme";
      return { type: "submit", draft };
    });
    const details = await props.askAssemblyDetails(meta, "DEV");
    assert.strictEqual(details.types["Acme.Plugins.AccountPlugin"].name, "AccountPlugin");
  });

  await test("registration panel: Cancel and closing the tab both mean cancelled", async () => {
    S.panelAnswers.push(() => ({ type: "cancel" }));
    assert.strictEqual(await props.askAssemblyDetails(meta, "DEV"), undefined);
    S.panelAnswers.push((state, panel) => { panel.dispose(); });
    assert.strictEqual(await props.askAssemblyDetails(meta, "DEV"), undefined);
  });

  await test("registration panel: a package's unique name has to start with the publisher prefix", async () => {
    S.panelAnswers.push(async (state, panel) => {
      assert.deepStrictEqual(state.draft.pkg, { name: "Acme.Pkg", uniqueName: "acme_Acme.Pkg" });
      assert.strictEqual(state.prefix, "acme");
      await panel.webview.send({ type: "submit", draft: { pkg: { name: "Acme.Pkg", uniqueName: "Acme.Pkg" }, types: [] } });
      assert.deepStrictEqual(lastStatus(panel).problems, [{ field: "pkg.uniqueName", text: "Start it with acme_ (the publisher's prefix)." }]);
      await panel.webview.send({ type: "change", draft: { pkg: { name: "", uniqueName: "acme_x y" }, types: [] } });
      assert.deepStrictEqual(lastStatus(panel).problems.map((p) => p.field), ["pkg.name", "pkg.uniqueName"]);
      return { type: "submit", draft: { pkg: { name: " Acme Package ", uniqueName: "acme_Acme.Pkg" }, types: [] } };
    });
    assert.deepStrictEqual(await props.askPackageDetails({ id: "Acme.Pkg", version: "1.0.0" }, "acme", "DEV"), { name: "Acme Package", uniqueName: "acme_Acme.Pkg" });
  });

  // ---------- step panel ----------
  const stepPanel = out("ui/panels/stepPanel.js");
  const stepDraft = () => ({ name: "AccountPlugin: Update of account", description: "", stage: 40, mode: 0, rank: 1, filtering: ["name"], deleteJobOnSuccess: false, configuration: "", secureConfig: { stored: false }, images: [{ id: "i1", alias: "PreImage", type: 0, columns: [], messageProperty: "Target" }] });

  await test("step panel: stepProblems land on their fields, Save stays off until something changed and nothing is wrong", async () => {
    const was = stepDraft();
    S.panelAnswers.push(async (state, panel) => {
      assert.strictEqual(state.mode, "edit");
      assert.strictEqual(lastStatus(panel), undefined, "no status before the page asks");
      await panel.webview.send({ type: "change", draft: { step: stepDraft() } });
      assert.deepStrictEqual(lastStatus(panel), { problems: [], summary: "No changes yet", blocked: true });
      const d = stepDraft();
      d.stage = 20;
      d.mode = 1;
      d.rank = -1;
      d.images.push({ alias: "", type: 1, columns: [], messageProperty: "Target" });
      d.images.push({ alias: "preimage", type: 0, columns: ["name"], messageProperty: "Target" });
      await panel.webview.send({ type: "change", draft: { step: d } });
      const status = lastStatus(panel);
      assert.deepStrictEqual(status.problems, [
        { field: "mode", text: "Asynchronous steps can only run post-operation." },
        { field: "rank", text: "The execution order is a whole number." },
        { field: "image:1:alias", text: "The image needs an alias." },
        { field: "image:1:type", text: 'The post-image "" only works post-operation.' },
        { field: "image:2:alias", text: 'Another image is called "preimage" too.' },
      ]);
      assert.match(status.summary, /^5 changes$/);
      const ok = stepDraft();
      ok.description = "Rules";
      ok.images[0].columns = ["name", "revenue"];
      const columns = await new Promise((resolve) => {
        panel.webview.listeners.push((m) => { if (m.type === "reply") resolve(m); });
        void panel.webview.send({ type: "request", id: 7, name: "columns", args: { table: "account" } });
        const waitFor = () => { const r = panel.webview.posted.find((m) => m.type === "reply" && m.id === 7); r ? resolve(r) : setTimeout(waitFor, 2); };
        waitFor();
      });
      assert.deepStrictEqual(columns.result, [{ id: "name", label: "Account Name", meta: "name" }]);
      return { type: "submit", draft: { step: ok } };
    });
    const result = await stepPanel.openStepPanel("Edit Plug-in Step", { subtitle: "", mode: "edit", message: "Update", table: "account", typeName: "Acme.AccountPlugin", draft: { step: stepDraft() } }, was, {
      columns: async (table) => (table === "account" ? [{ id: "name", label: "Account Name", meta: "name" }] : []),
      users: async () => [],
    });
    const changes = out("core/stepEditing.js").stepChanges(was, result.step);
    assert.deepStrictEqual(changes.step, { description: "Rules" });
    assert.deepStrictEqual(changes.images.update, [{ id: "i1", patch: { attributes: "name,revenue" } }]);
  });

  await test("step panel: Register Step needs a class and a message; a submit the org refuses keeps the page open", async () => {
    S.panelAnswers.push(async (state, panel) => {
      const draft = { step: { ...stepDraft(), name: "", filtering: [], images: [] }, target: { pluginTypeId: "", typeName: "", message: "*", table: "", solution: "", nameAuto: true } };
      await panel.webview.send({ type: "change", draft });
      assert.deepStrictEqual(lastStatus(panel).problems, [
        { field: "pluginTypeId", text: "Pick the plug-in class." },
        { field: "messageOther", text: "Enter the message's name." },
        { field: "name", text: "The step needs a name." },
      ]);
      draft.target = { pluginTypeId: "pt1", typeName: "Acme.AccountPlugin", message: "acme_Approve", table: "account", solution: "AcmeCore", nameAuto: true };
      draft.step.name = "AccountPlugin: acme_Approve of account";
      await panel.webview.send({ type: "submit", draft });
      assert.deepStrictEqual(panel.webview.posted.filter((m) => m.type === "note").map((m) => m.text), ["There's no message named acme_Approve."]);
      assert.ok(!panel.disposed);
      draft.target.message = "Update";
      return { type: "submit", draft };
    });
    const result = await stepPanel.openStepPanel("Register Plug-in Step", { subtitle: "", mode: "register", message: "", table: "", typeName: "", classes: [], messages: ["Update"], tables: [], solutions: ["AcmeCore"], draft: { step: stepDraft(), target: { pluginTypeId: "", typeName: "", message: "", table: "", solution: "", nameAuto: true } } }, undefined, {
      columns: async () => [],
      users: async () => [],
      submit: async (d) => (stepPanel.targetMessage(d.target) === "Update" ? undefined : `There's no message named ${stepPanel.targetMessage(d.target)}.`),
    });
    assert.deepStrictEqual([result.target.message, result.target.table, result.target.solution], ["Update", "account", "AcmeCore"]);
  });

  // ---------- environment and column picker ----------
  const envPanel = out("ui/panels/environmentPanel.js");
  await test("environment panel: names and URLs are checked against what the tenant has", async () => {
    const state = { current: { host: "acme.crm.dynamics.com", from: "acme" }, taken: ["TEST"] };
    const d = { currentName: "", source: "", url: "", name: "", protected: false, nameAuto: true, protectedAuto: true };
    assert.deepStrictEqual(envPanel.environmentProblems(d, state, ["acme.crm.dynamics.com"], true).map((p) => p.field), ["currentName", "name", "url"]);
    assert.deepStrictEqual(envPanel.environmentProblems({ ...d, currentName: "DEV", name: "dev", source: "custom", url: "https://acme.crm.dynamics.com" }, state, ["acme.crm.dynamics.com"]), [
      { field: "name", text: "That name is taken." },
      { field: "url", text: "That org is already one of this tenant's environments." },
    ]);
    assert.deepStrictEqual(envPanel.environmentProblems({ ...d, currentName: "DEV", name: "PROD", source: "custom", url: "acme-prod.crm.dynamics.com" }, state, ["acme.crm.dynamics.com"]), []);
  });

  const picker = out("ui/panels/columnPickerPanel.js");
  await test("column picker: the fields above the list are checked, the picked columns come back in list order", async () => {
    const fields = { namespace: { label: "Namespace", value: "", pattern: "^[A-Za-z_]\\w*(\\.[A-Za-z_]\\w*)*$", patternText: "Use a C# namespace." }, outDir: { label: "Output folder", value: "Models", required: true } };
    assert.deepStrictEqual(picker.columnPickerProblems({ picked: [], fields: { namespace: "1bad", outDir: " " } }, fields), [
      { field: "namespace", text: "Use a C# namespace." },
      { field: "outDir", text: "Enter the output folder." },
    ]);
    S.panelAnswers.push((state) => ({ type: "submit", draft: { picked: ["revenue", "name"], fields: { ...state.draft.fields, namespace: "Acme.Models" } } }));
    const r = await picker.openColumnPicker("Add to C# Classes", "Queue", { subtitle: "", table: { logical: "account", label: "Account", primaryId: "accountid" }, fields, items: [{ id: "name", label: "Name", group: "Standard columns", picked: true }, { id: "revenue", label: "Revenue", group: "Standard columns", picked: false }], notes: [], draft: { picked: ["name"], fields: { namespace: "", outDir: "Models" } } });
    assert.deepStrictEqual(r, { picked: ["revenue", "name"], fields: { namespace: "Acme.Models", outDir: "Models" } });
  });

  // ---------- command bar ----------
  const commandBar = out("ui/panels/commandBarPanel.js");
  await test("command bar panel: the model reaches the page, warnings and explanations are answered on request, a change enables Save, Save hands the draft to the hook", async () => {
    const rm = out("core/ribbonModel.js");
    const model = rm.parseRibbonXml(`<RibbonDefinitions><RibbonDefinition><UI><Ribbon><Tabs><Tab Id="Mscrm.Form.account.MainTab" Sequence="10"><Groups><Group Id="Mscrm.Form.account.MainTab.Save" Sequence="10"><Controls Id="c"><Button Id="acme.Approve" Command="acme.Approve.Command" Sequence="20" LabelText="Approve" /></Controls></Group></Groups></Tab></Tabs></Ribbon></UI><CommandDefinitions><CommandDefinition Id="acme.Approve.Command"><Actions><JavaScriptFunction FunctionName="Acme.approve" Library="$webresource:acme_/ribbon.js" /></Actions></CommandDefinition></CommandDefinitions></RibbonDefinition></RibbonDefinitions>`, "account", "Form");
    const original = JSON.parse(JSON.stringify(model));
    const check = (m) => rm.checkRibbonReferences(m, () => ({ file: "ribbon.js", text: "" }), () => false);
    const opened = [];
    const submitted = [];
    S.panelAnswers.push(async (state, panel) => {
      assert.strictEqual(panel.title, "Account command bar");
      assert.match(panel.webview.html, />Save<\/button>/);
      assert.match(panel.webview.html, />Close<\/button>/);
      assert.strictEqual(state.model, undefined, "the model travels as the draft");
      assert.strictEqual(state.draft.model.tabs[0].groups[0].controls[0].label, "Approve");
      assert.deepStrictEqual(Object.keys(state.ruleKinds).slice(0, 3), ["CustomRule", "EntityPrivilegeRule", "RecordPrivilegeRule"]);
      await panel.webview.send({ type: "change", draft: state.draft });
      assert.deepStrictEqual(lastStatus(panel), { problems: [], summary: "No changes yet · 1 JavaScript warning", blocked: true });
      await panel.webview.send({ type: "request", id: 3, name: "check", args: { model: state.draft.model } });
      await tick();
      assert.deepStrictEqual(panel.webview.posted.find((m) => m.type === "reply" && m.id === 3).result, [{ key: "action:acme.Approve.Command:0", text: "Acme.approve isn't defined in ribbon.js.", file: "ribbon.js" }]);
      await panel.webview.send({ type: "request", id: 4, name: "explain", args: { step: { kind: "FormStateRule", attrs: { State: "Create" }, parameters: [], text: "" } } });
      await tick();
      assert.strictEqual(panel.webview.posted.find((m) => m.type === "reply" && m.id === 4).result, "The form is a new record.");
      await panel.webview.send({ type: "request", id: 5, name: "open", args: { webResource: "acme_/ribbon.js", functionName: "Acme.approve" } });
      await tick();
      assert.deepStrictEqual(opened, [["acme_/ribbon.js", "Acme.approve"]]);
      const draft = JSON.parse(JSON.stringify(state.draft));
      draft.model.hidden.push({ id: "acme.Approve", location: "Mscrm.Form.account.MainTab.Save.Controls._children", origin: "client" });
      draft.publish = true;
      await panel.webview.send({ type: "change", draft });
      assert.deepStrictEqual(lastStatus(panel), { problems: [{ field: "solution", text: "Pick the solution to publish through." }], summary: "1 change · 1 JavaScript warning", blocked: false });
      draft.solution = "AcmeCore";
      await panel.webview.send({ type: "submit", draft });
      assert.deepStrictEqual(panel.webview.posted.filter((m) => m.type === "note").map((m) => m.text), ["Not this time."], "a refused save keeps the page open");
      assert.ok(!panel.disposed);
      return { type: "submit", draft };
    });
    let refuse = true;
    const result = await commandBar.openCommandBarPanel(
      { subtitle: "", table: "account", tableLabel: "Account", env: "DEV", localSolutions: ["AcmeCore"], localFiles: [], prefix: "acme", solutions: ["AcmeCore"], apps: [], scripts: ["acme_/ribbon.js"], images: [], ruleKinds: rm.RULE_KINDS, parameterKinds: rm.PARAMETER_KINDS, crmParameters: rm.CRM_PARAMETER_VALUES, draft: { model, publish: false, solution: "", writeLocal: true } },
      original,
      { open: async (wr, fn) => { opened.push([wr, fn]); }, openFile: async () => {}, icon: async () => undefined, check, explain: (s) => rm.explainStep(s), submit: async (d) => { submitted.push(d); if (refuse) { refuse = false; return "Not this time."; } return undefined; } }
    );
    assert.strictEqual(submitted.length, 2);
    assert.deepStrictEqual([result.publish, result.solution, result.model.hidden.map((h) => h.id)], [true, "AcmeCore", ["acme.Approve"]]);
    assert.ok(lastPanel().disposed);
  });

  await tick();
  if (S.panelErrors) failures.push(...S.panelErrors.map((e) => `panel answer: ${e.message}`));
  console.log(`${passed} panel checks passed${failures.length ? `, ${failures.length} failed` : ""}.`);
  if (failures.length) process.exit(1);
})();
