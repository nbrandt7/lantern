// Loads every editor-tab form (src/ui/panels) in a real browser through the vscode mock:
// the page's own script runs, every control gets poked, the tab is hidden and restored,
// and the run fails on any script error, CSP violation or a form that doesn't round-trip.
// Needs Playwright (npm install -g playwright); skipped without it.
// Run with: npm run compile && node test/panelsBrowser.js
const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? require.resolve("./mock-vscode") : resolve.call(this, request, ...rest);
};
const assert = require("assert");
const os = require("os");
const path = require("path");
const vscode = require("./mock-vscode");
const out = (m) => require(path.join(__dirname, "..", "out", m));

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  try {
    ({ chromium } = require(path.join(os.homedir(), ".npm-global", "lib", "node_modules", "playwright")));
  } catch {
    console.log("Playwright isn't installed; skipping the panel browser test.");
    process.exit(0);
  }
}

// Text that would run or load something if a page ever put it in as HTML. The CSP turns
// either into a console error, which fails the run.
const NASTY = `<img src=x onerror="window.__xss=1">"'&`;

let browser;
const problems = [];
let current;

/** A webview panel backed by a browser page; messages go both ways as they do in VS Code. */
vscode.window.createWebviewPanel = (viewType, title, column, options) => {
  const listeners = [];
  const disposeListeners = [];
  let html = "";
  const panel = {
    viewType, title, column, options, disposed: false, page: undefined, loaded: Promise.resolve(), saved: undefined,
    onDidDispose(l) { disposeListeners.push(l); return { dispose() {} }; },
    onDidChangeViewState() { return { dispose() {} }; },
    reveal() {},
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      for (const l of disposeListeners) l();
      if (panel.page) void panel.page.close().catch(() => undefined);
    },
    webview: {
      cspSource: "vscode-webview:",
      asWebviewUri: (u) => u,
      onDidReceiveMessage(l) { listeners.push(l); return { dispose() {} }; },
      async postMessage(m) {
        await panel.loaded;
        if (panel.disposed || !panel.page) return false;
        await panel.page.evaluate((msg) => window.postMessage(msg, "*"), JSON.parse(JSON.stringify(m)));
        return true;
      },
      get html() { return html; },
      set html(value) {
        html = value;
        panel.loaded = panel.load();
      },
    },
    /** Opens the HTML in a fresh page, with the webview state VS Code would have kept. */
    async load(savedState) {
      const page = await browser.newPage();
      page.on("pageerror", (e) => problems.push(`${title}: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error") problems.push(`${title}: console: ${m.text()}`); });
      await page.exposeFunction("__toExtension", (m) => { for (const l of listeners) void l(m); });
      await page.exposeFunction("__saveState", (s) => { panel.saved = s; });
      await page.addInitScript((saved) => {
        let s = saved;
        window.acquireVsCodeApi = () => ({
          postMessage: (m) => window.__toExtension(JSON.parse(JSON.stringify(m))),
          getState: () => s,
          setState: (v) => { s = v; void window.__saveState(JSON.parse(JSON.stringify(v))); },
        });
      }, savedState);
      // Served as a navigation, not setContent, so the init script runs before the page's own.
      await page.route("https://panel.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto("https://panel.test/");
      panel.page = page;
    },
    /** Hides and shows the tab: retainContextWhenHidden is off, so the page reloads from its saved state. */
    async reload() {
      const old = panel.page;
      panel.page = undefined;
      await old.close();
      panel.loaded = panel.load(panel.saved);
      await panel.loaded;
    },
  };
  current = panel;
  return panel;
};

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Waits for the page to build itself from the state. */
async function opened() {
  for (let i = 0; i < 200 && !(current && current.page); i++) await settle(10);
  const panel = current;
  await panel.loaded;
  await panel.page.waitForFunction(() => document.querySelector("main") && document.querySelector("main").children.length > 0, null, { timeout: 5000 });
  await settle();
  return panel;
}

/**
 * Pokes every control on the page once: types into text boxes, ticks boxes, picks each
 * select's last option, clicks buttons other than the footer's. Returns what it did.
 */
async function pokeAll(panel, { skip = [] } = {}) {
  const page = panel.page;
  const done = [];
  for (let i = 0; i < 400; i++) {
    const did = await page.evaluate(({ i, skip }) => {
      const controls = [...document.querySelectorAll("main input, main select, main textarea, main button")]
        .filter((e) => !e.disabled && !e.hidden && e.offsetParent !== null);
      const e = controls[i];
      if (!e) return null;
      const label = `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.type ? "[" + e.type + "]" : ""} ${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 30)}`;
      if (skip.some((s) => label.includes(s))) return `skipped ${label}`;
      if (e.tagName === "BUTTON") e.click();
      else if (e.tagName === "SELECT") {
        if (e.options.length) e.selectedIndex = e.options.length - 1;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (e.type === "checkbox" || e.type === "radio") e.click();
      else {
        e.focus();
        e.value = e.type === "number" ? "3" : (e.value || "") + "x";
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        e.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        e.blur();
      }
      return label;
    }, { i, skip });
    if (did === null) break;
    done.push(did);
    await settle(15);
  }
  return done;
}

const footer = async (panel) => panel.page.evaluate(() => ({ text: document.getElementById("footerText").textContent, primaryDisabled: document.getElementById("primary").disabled }));
const click = (panel, id) => panel.page.evaluate((id) => document.getElementById(id).click(), id);
const injected = (panel) => panel.page.evaluate(() => !!window.__xss);

let passed = 0;
const failures = [];
async function test(name, fn) {
  const before = problems.length;
  try {
    await fn();
    const fresh = problems.slice(before);
    assert.deepStrictEqual(fresh, [], `page errors: ${fresh.join(" | ")}`);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n${String(err.stack || err).split("\n").slice(0, 8).join("\n")}`);
  } finally {
    if (current && !current.disposed) current.dispose();
  }
}

/**
 * The common run for a page: it builds, survives being hidden and shown, every control
 * can be poked, and Cancel resolves the opener with undefined.
 */
async function exercise(name, openIt, { skip, expectCancel = true } = {}) {
  await test(`${name}: builds, restores after hiding, survives every control, cancels`, async () => {
    const result = openIt();
    const panel = await opened();
    assert.match(panel.page ? await panel.page.content() : "", /<main/);
    await panel.reload();
    await panel.page.waitForFunction(() => document.querySelector("main").children.length > 0, null, { timeout: 5000 });
    await settle();
    const did = await pokeAll(panel, { skip });
    assert.ok(did.length > 0, "the page has controls");
    await settle(60);
    assert.ok(!(await injected(panel)), "no injected markup ran");
    await panel.reload();
    await settle(60);
    await click(panel, "cancel");
    const value = await Promise.race([result, settle(3000).then(() => "timeout")]);
    if (expectCancel) assert.strictEqual(value, undefined, "Cancel resolves with undefined");
  });
}

(async () => {
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.log(`Couldn't start a browser (${String(err.message).split("\n")[0]}); skipping the panel browser test.`);
    process.exit(0);
  }

  // ---------- registration ----------
  const props = out("commands/pluginProperties.js");
  const registration = out("ui/panels/registrationPanel.js");
  const meta = {
    name: `Acme.Plugins${NASTY}`, version: "1.0.0.0", culture: "neutral", signed: true, references: [],
    pluginClasses: [{ typeName: "Acme.Plugins.AccountPlugin", kind: "plugin" }, { typeName: `Acme.Plugins.Copy${NASTY}`, kind: "workflow" }, { typeName: "Acme.Plugins.Nested+Inner", kind: "plugin" }],
  };
  await exercise("register assembly", () => props.askAssemblyDetails(meta, "DEV"));
  await exercise("register package", () => props.askPackageDetails({ id: `Acme.Pkg${NASTY}`, version: "1.0.0" }, "acme", "DEV"));
  const editState = (kind) => ({
    subtitle: NASTY, mode: "edit", what: { name: "Acme.Plugins", version: "1.0.0.0", kind },
    draft: {
      description: NASTY, isolationMode: kind === "assembly" ? 2 : undefined, packageName: kind === "package" ? "acme_Pkg" : undefined,
      types: [
        { id: "t1", typeName: "Acme.Plugins.AccountPlugin", workflow: false, name: "Acme.Plugins.AccountPlugin", friendlyName: NASTY, description: "", workflowGroup: "" },
        { id: "t2", typeName: "Acme.Plugins.CopyText", workflow: true, name: "CopyText", friendlyName: "", description: "", workflowGroup: "Acme (1.0.0.0)" },
      ],
    },
  });
  await exercise("edit assembly", () => registration.openRegistrationPanel("Edit Plug-in Assembly", editState("assembly"), () => 1));
  await exercise("edit package assembly", () => registration.openRegistrationPanel("Edit Plug-in Assembly", editState("package"), () => 0));

  await test("register assembly: typing a display name and submitting from the page returns it", async () => {
    const result = props.askAssemblyDetails({ ...meta, name: "Acme.Plugins", pluginClasses: meta.pluginClasses.slice(0, 1) }, "DEV");
    const panel = await opened();
    await panel.page.evaluate(() => [...document.querySelectorAll("main [data-key]")].find((e) => e.textContent.includes("AccountPlugin")).click());
    await settle(40);
    const filled = await panel.page.evaluate(() => {
      const friendly = document.querySelector('main input[placeholder^="Generated"]');
      if (!friendly) return false;
      friendly.value = "Account Plugin";
      friendly.dispatchEvent(new Event("input", { bubbles: true }));
      friendly.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    assert.ok(filled, "the page has a display name box");
    await settle(80);
    const f = await footer(panel);
    assert.ok(!f.primaryDisabled, `Register is enabled (${f.text})`);
    await click(panel, "primary");
    const details = await Promise.race([result, settle(3000).then(() => "timeout")]);
    assert.strictEqual(details.types["Acme.Plugins.AccountPlugin"].friendlyName, "Account Plugin");
  });

  // ---------- steps ----------
  const stepPanel = out("ui/panels/stepPanel.js");
  const stepDraft = () => ({ name: `AccountPlugin: Update of account${NASTY}`, description: NASTY, stage: 40, mode: 0, rank: 1, filtering: ["name"], deleteJobOnSuccess: false, configuration: NASTY, secureConfig: { stored: true }, impersonate: { id: "u1", label: `Ada${NASTY}` }, images: [{ id: "i1", alias: "PreImage", type: 0, columns: ["name"], messageProperty: "Target" }, { id: "i2", alias: "Post", type: 1, columns: [], messageProperty: "Target" }] });
  const stepHooks = {
    columns: async (table) => (table ? [{ id: "name", label: `Account Name${NASTY}`, meta: "name" }, { id: "revenue", label: "Revenue", meta: "revenue" }, { id: "fax", label: "Fax", meta: "fax" }] : []),
    users: async (text) => [{ id: "u1", label: `Ada${NASTY}`, meta: "ada@acme.com" }, { id: "u2", label: `Grace ${text}`, meta: "grace@acme.com" }],
    submit: async () => undefined,
  };
  await exercise("edit step", () => stepPanel.openStepPanel("Edit Plug-in Step", { subtitle: NASTY, mode: "edit", message: "Update", table: "account", typeName: "Acme.AccountPlugin", draft: { step: stepDraft() } }, stepDraft(), stepHooks));
  for (const message of ["Create", "Delete", "SetState", "Associate", "Retrieve"]) {
    await exercise(`edit step (${message})`, () => stepPanel.openStepPanel("Edit Plug-in Step", { subtitle: "", mode: "edit", message, table: message === "Associate" ? "" : "account", typeName: "Acme.AccountPlugin", draft: { step: { ...stepDraft(), images: message === "Retrieve" ? [] : stepDraft().images } } }, stepDraft(), stepHooks));
  }
  const registerState = () => ({
    subtitle: "", mode: "register", message: "", table: "", typeName: "",
    classes: [{ id: "pt1", typeName: "Acme.AccountPlugin", assembly: `Acme${NASTY}` }, { id: "pt2", typeName: "Acme.ContactPlugin", assembly: "Acme" }],
    messages: ["Create", "Update", "Delete", `acme_Do${NASTY}`],
    tables: [{ id: "account", label: `Account${NASTY}`, meta: "account" }, { id: "contact", label: "Contact", meta: "contact" }],
    solutions: ["AcmeCore", `Other${NASTY}`],
    draft: { step: { ...stepDraft(), name: "", images: [] }, target: { pluginTypeId: "", typeName: "", message: "", table: "", solution: "", nameAuto: true } },
  });
  await exercise("register step", () => stepPanel.openStepPanel("Register Plug-in Step", registerState(), undefined, stepHooks));

  // ---------- environment ----------
  const envPanel = out("ui/panels/environmentPanel.js");
  const envState = (current) => ({
    subtitle: NASTY, client: `Acme${NASTY}`,
    current,
    found: [
      { id: "https://acme-dev.crm.dynamics.com", label: `Acme Dev${NASTY}`, host: "acme-dev.crm.dynamics.com", meta: "Sandbox", disabled: false, suggested: "DEV" },
      { id: "https://acme.crm.dynamics.com", label: "Acme", host: "acme.crm.dynamics.com", meta: "Production", disabled: true },
      { id: "https://acme-prod.crm.dynamics.com", label: "Acme Prod", host: "acme-prod.crm.dynamics.com", meta: "Production", disabled: false, suggested: "PROD" },
    ],
    discoveryFailed: false,
    taken: ["TEST"],
    names: ["DEV", "TEST", "UAT", "PROD"],
    draft: { currentName: current ? "" : undefined, source: "", url: "", name: "", protected: false, nameAuto: true, protectedAuto: true },
  });
  await exercise("add environment (first one)", () => envPanel.openEnvironmentPanel(envState({ host: "acme.crm.dynamics.com", suggested: "DEV", from: `acme${NASTY}` }), ["acme.crm.dynamics.com"]));
  await exercise("add environment", () => envPanel.openEnvironmentPanel(envState(undefined), ["acme.crm.dynamics.com"]));
  await exercise("add environment (discovery failed)", () => envPanel.openEnvironmentPanel({ ...envState(undefined), found: [], discoveryFailed: true }, ["acme.crm.dynamics.com"]));

  await test("add environment: picking a discovered org fills the name and protection, and Add returns it", async () => {
    const result = envPanel.openEnvironmentPanel(envState(undefined), ["acme.crm.dynamics.com"]);
    const panel = await opened();
    const picked = await panel.page.evaluate(() => {
      const radios = [...document.querySelectorAll("main input[type=radio]")];
      const prod = radios.find((r) => r.value === "https://acme-prod.crm.dynamics.com");
      if (prod) { prod.click(); return "radio"; }
      const sel = document.querySelector("main select");
      if (sel) {
        const i = [...sel.options].findIndex((o) => o.value === "https://acme-prod.crm.dynamics.com");
        if (i >= 0) { sel.selectedIndex = i; sel.dispatchEvent(new Event("change", { bubbles: true })); sel.dispatchEvent(new Event("input", { bubbles: true })); return "select"; }
      }
      const item = [...document.querySelectorAll("main [data-id], main li, main .item, main button")].find((e) => (e.getAttribute("data-id") || e.textContent || "").includes("acme-prod"));
      if (item) { item.click(); return "click"; }
      return null;
    });
    assert.ok(picked, "the discovered orgs can be picked");
    await settle(80);
    const f = await footer(panel);
    assert.ok(!f.primaryDisabled, `Add is enabled (${f.text})`);
    await click(panel, "primary");
    const draft = await Promise.race([result, settle(3000).then(() => "timeout")]);
    assert.notStrictEqual(draft, "timeout");
    assert.deepStrictEqual([draft.url, draft.name, draft.protected], ["https://acme-prod.crm.dynamics.com", "PROD", true]);
  });

  // ---------- column picker ----------
  const picker = out("ui/panels/columnPickerPanel.js");
  const pickerState = () => ({
    subtitle: NASTY,
    table: { logical: "account", label: `Account${NASTY}`, primaryId: "accountid" },
    fields: {
      namespace: { label: "Namespace", value: "", pattern: "^[A-Za-z_]\\w*(\\.[A-Za-z_]\\w*)*$", patternText: "Use a C# namespace.", hint: NASTY },
      outDir: { label: "Output folder", value: "Models", required: true, placeholder: NASTY },
      language: { label: "Language", value: "ts", options: [{ value: "ts", label: "TypeScript" }, { value: "js", label: `JavaScript${NASTY}`, description: NASTY }] },
    },
    items: [
      { id: "accountid", label: "Account", group: "Standard columns", picked: true, tags: ["primary key"] },
      { id: "name", label: `Name${NASTY}`, meta: "name", group: "Standard columns", picked: true, title: NASTY },
      { id: "revenue", label: "Revenue", group: "Standard columns", picked: false, tags: [NASTY] },
      { id: "acme_score", label: "Score", group: `Custom columns${NASTY}`, picked: false },
    ],
    notes: [NASTY],
    draft: { picked: ["accountid", "name"], fields: { namespace: "", outDir: "Models", language: "ts" } },
  });
  await exercise("column picker", () => picker.openColumnPicker("Add to C# Classes", "Queue", pickerState()));

  await test("column picker: ticking a column in the page and submitting returns it", async () => {
    const result = picker.openColumnPicker("Add to C# Classes", "Queue", pickerState());
    const panel = await opened();
    const ticked = await panel.page.evaluate(() => {
      const box = [...document.querySelectorAll("main input[type=checkbox]")].find((b) => (b.value || b.id || b.closest("label")?.textContent || "").includes("revenue") || (b.closest("label, li, div")?.textContent || "").includes("Revenue"));
      if (!box) return false;
      box.click();
      return true;
    });
    assert.ok(ticked, "Revenue has a checkbox");
    await settle(80);
    await click(panel, "primary");
    const draft = await Promise.race([result, settle(3000).then(() => "timeout")]);
    assert.notStrictEqual(draft, "timeout", `submit went through (${JSON.stringify(await footer(panel).catch(() => ({})))})`);
    assert.deepStrictEqual([...draft.picked].sort(), ["accountid", "name", "revenue"]);
  });

  // ---------- command bar ----------
  const commandBar = out("ui/panels/commandBarPanel.js");
  const rm = out("core/ribbonModel.js");
  const ribbonXml = `<RibbonDefinitions><RibbonDefinition><UI><Ribbon><Tabs><Tab Id="Mscrm.Form.account.MainTab" Sequence="10"><Groups><Group Id="Mscrm.Form.account.MainTab.Save" Sequence="10"><Controls Id="c">
    <Button Id="acme.Approve" Command="acme.Approve.Command" Sequence="20" LabelText="Approve &lt;img src=x&gt;" ToolTipTitle="Approve" Image16by16="$webresource:acme_/icon.svg" />
    <FlyoutAnchor Id="acme.More" Command="acme.More.Command" Sequence="30" LabelText="More"><Menu Id="acme.More.Menu"><MenuSection Id="acme.More.Section" Sequence="10"><Controls Id="acme.More.Controls"><Button Id="acme.More.One" Command="acme.Approve.Command" Sequence="10" LabelText="One" /></Controls></MenuSection></Menu></FlyoutAnchor>
    </Controls></Group></Groups></Tab></Tabs></Ribbon></UI>
    <CommandDefinitions>
      <CommandDefinition Id="acme.Approve.Command"><EnableRules><EnableRule Id="acme.Approve.Enable" /></EnableRules><DisplayRules><DisplayRule Id="acme.Approve.Display" /></DisplayRules><Actions><JavaScriptFunction FunctionName="Acme.approve" Library="$webresource:acme_/ribbon.js"><CrmParameter Value="PrimaryControl" /><StringParameter Value="a&quot;b" /></JavaScriptFunction></Actions></CommandDefinition>
      <CommandDefinition Id="acme.More.Command"><EnableRules /><DisplayRules /><Actions /></CommandDefinition>
    </CommandDefinitions>
    <RuleDefinitions><TabDisplayRules /><DisplayRules><DisplayRule Id="acme.Approve.Display"><FormStateRule State="Create" InvertResult="true" /></DisplayRule></DisplayRules><EnableRules><EnableRule Id="acme.Approve.Enable"><CustomRule FunctionName="Acme.canApprove" Library="$webresource:acme_/ribbon.js" /><RecordPrivilegeRule PrivilegeType="Write" AppliesTo="PrimaryEntity" /></EnableRule></EnableRules></RuleDefinitions>
    </RibbonDefinition></RibbonDefinitions>`;
  const cbState = () => {
    const model = rm.parseRibbonXml(ribbonXml, "account", "Form");
    return {
      original: JSON.parse(JSON.stringify(model)),
      state: { subtitle: NASTY, table: "account", tableLabel: `Account${NASTY}`, env: "DEV", localSolutions: ["AcmeCore"], localFiles: [], prefix: "acme", solutions: ["AcmeCore", `Other${NASTY}`], apps: [], scripts: ["acme_/ribbon.js", `acme_/x${NASTY}.js`], images: ["acme_/icon.svg"], ruleKinds: rm.RULE_KINDS, parameterKinds: rm.PARAMETER_KINDS, crmParameters: rm.CRM_PARAMETER_VALUES, draft: { model, publish: false, solution: "", writeLocal: true } },
    };
  };
  const cbHooks = {
    open: async () => {}, openFile: async () => {}, icon: async () => undefined,
    check: (m) => rm.checkRibbonReferences(m, () => ({ file: "ribbon.js", text: "" }), () => false),
    explain: (s) => rm.explainStep(s),
    submit: async () => undefined,
  };
  {
    const { state, original } = cbState();
    await exercise("command bar", () => commandBar.openCommandBarPanel(state, original, cbHooks));
  }
  {
    // Every tree row selected in turn, each one's editor poked.
    await test("command bar: every row's editor builds and survives every control", async () => {
      const { state, original } = cbState();
      const result = commandBar.openCommandBarPanel(state, original, cbHooks);
      const panel = await opened();
      const rows = await panel.page.evaluate(() => document.querySelectorAll("main #items [data-key]").length);
      assert.ok(rows > 0, "the command bar has a tree of rows");
      for (let r = 0; r < rows; r++) {
        const exists = await panel.page.evaluate((r) => {
          const all = document.querySelectorAll("main #items [data-key]");
          const row = all[r];
          if (!row) return false;
          row.click();
          return true;
        }, r);
        if (!exists) break;
        await settle(40);
        // Only the right-hand editor's controls; the tree's own buttons add and remove rows.
        await panel.page.evaluate(() => {
          const editor = document.querySelector("main #form");
          if (!editor) return;
          for (const e of editor.querySelectorAll("input, select, textarea")) {
            if (e.disabled) continue;
            if (e.type === "checkbox") e.click();
            else if (e.tagName === "SELECT") { if (e.options.length) e.selectedIndex = e.options.length - 1; e.dispatchEvent(new Event("change", { bubbles: true })); e.dispatchEvent(new Event("input", { bubbles: true })); }
            else { e.value = (e.value || "") + "x"; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }
          }
        });
        await settle(40);
      }
      await settle(80);
      assert.ok(!(await injected(panel)));
      await click(panel, "cancel");
      assert.strictEqual(await Promise.race([result, settle(3000).then(() => "timeout")]), undefined);
    });
  }

  await browser.close();
  console.log(`${passed} panel browser checks passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  if (failures.length) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  if (browser) await browser.close().catch(() => undefined);
  process.exit(1);
});
