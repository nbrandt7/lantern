// Regression tests for tenant settings, sign-in and the tree's caches: the metadata service's account,
// duplicate and vanished tenants, the saved default environment, unreadable tenant files, the legacy
// import, app registration secrets, Refresh, an edited "folder", the schema and the connection check.
// Run with: npm run compile && node test/regression/tenants.js (LANTERN_OUT=<dir> to test another build).
const Module = require("module");
const path = require("path");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? require.resolve("../mock-vscode") : resolve.call(this, request, ...rest);
};
const OUT = process.env.LANTERN_OUT ? path.resolve(process.env.LANTERN_OUT) : path.join(__dirname, "..", "..", "out");
const out = (m) => require(path.join(OUT, m));
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const vscode = require("../mock-vscode");
const S = vscode.__state;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-tenants-"));
// Activating writes Lantern's log and MCP files under the home folder: keep them in this run's own.
const home = path.join(scratch, "home");
fs.mkdirSync(home);
Object.assign(process.env, { USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: path.join(home, ".codex") });
// Sign In As brings the pac profile in line; no real pac (or dotnet, az) may run here.
for (const tool of ["pacPath", "dotnetPath", "azPath"]) S.config[tool] = path.join(scratch, "no-such-tool");
let n = 0;
const tmp = () => {
  const dir = path.join(scratch, `t${++n}`);
  fs.mkdirSync(dir);
  return dir;
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------- a fake Dataverse ----------
const requests = [];
let whoami = "1";
global.fetch = async (url, init = {}) => {
  requests.push(String(url));
  const json = (data, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) });
  if (/oauth2\/v2\.0\/token/.test(url)) return json({ access_token: "app-token", expires_in: 3600 });
  if (/RetrieveCurrentOrganization/.test(url)) return json({ Detail: { EnvironmentId: "env-1" } });
  if (/RetrieveVersion/.test(url)) return json({ Version: "9.2" });
  if (url.includes("systemusers(")) return json({ fullname: `User ${whoami}`, domainname: "x", systemuserroles_association: [] });
  if (url.includes("businessunits(")) return json({ name: "bu" });
  if (/WhoAmI/.test(url)) return json({ UserId: "u1", BusinessUnitId: "b1", OrganizationId: "o1" });
  if (/EntityDefinitions/.test(url)) {
    // Each org has one table named after its host, so a table list shows which org it came from.
    const host = new URL(url).host.split(".")[0];
    return json({ value: [{ LogicalName: `from_${host}`, MetadataId: "00000000-0000-0000-0000-000000000001", DisplayName: { UserLocalizedLabel: { Label: host } }, EntitySetName: "x", PrimaryIdAttribute: "xid", PrimaryNameAttribute: "name", ObjectTypeCode: 10000, IsCustomEntity: true }] });
  }
  return json({ value: [] });
};

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

/** Activates the extension the way VS Code would, with its global storage in `storage`. */
function activate(storage, globalState) {
  const values = new Map();
  const memento = { get: (k, d) => (values.has(k) ? values.get(k) : d), update: async (k, v) => void values.set(k, v), keys: () => [...values.keys()] };
  const context = {
    subscriptions: [],
    globalStorageUri: vscode.Uri.file(storage),
    extensionUri: vscode.Uri.file(scratch),
    extensionPath: scratch,
    extension: { packageJSON: { version: "0" } },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    globalState: globalState ?? memento,
    workspaceState: memento,
  };
  out("extension.js").activate(context);
  return context;
}
const run = (id, ...args) => S.commands.get(`lantern.${id}`)(...args);
const fresh = () => {
  out("ui/tenantContext.js").selectTenant(undefined);
  Object.assign(S, { quickPickAnswers: [], messages: [], messageAnswers: [], sessionOptions: [], context: {}, accounts: [] });
  whoami = "1";
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  fresh();
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n${err.stack.split("\n").slice(0, 6).join("\n")}`);
  }
}

(async () => {
  const clients = out("core/clients.js");
  const tc = out("ui/tenantContext.js");
  const auth = out("ui/auth.js");
  const ctx = out("ui/context.js");

  await test("metadata service: after DEV → PROD → Select Tenant again, All tables on DEV comes from DEV", async () => {
    const base = tmp();
    const root = path.join(base, "ws");
    const storage = path.join(base, "storage");
    fs.mkdirSync(root);
    writeJson(path.join(storage, "tenants.json"), { legacyImported: true, tenants: [{
      name: "Acme", defaultEnvironment: "DEV",
      environments: [{ name: "DEV", org: "https://acme-dev.crm.dynamics.com" }, { name: "PROD", org: "https://acme-prod.crm.dynamics.com", protected: true }],
    }] });
    S.workspaceFolders = [root];
    S.config.clientSettingsLocation = "global";
    activate(storage);
    S.quickPickAnswers.push("Acme");
    await run("selectTenant");
    const first = tc.activeTenant();
    await run("refresh"); // makes DEV's metadata service with the first client
    S.quickPickAnswers.push("PROD");
    await run("environments.switch");
    assert.strictEqual(first.envName, "PROD", "switching changes the client in place");
    await run("refresh");
    S.quickPickAnswers.push("Acme");
    await run("selectTenant");
    assert.strictEqual(tc.activeTenant().envName, "DEV");
    const tree = S.treeViews["lantern.environment"].treeDataProvider;
    const tables = (await tree.getChildren()).find((node) => node.kind === "section" && node.section === "tables");
    await settle();
    requests.length = 0;
    const rows = await tree.getChildren(tables);
    assert.deepStrictEqual(rows.map((row) => row.table && row.table.logicalName), ["from_acme-dev"]);
    assert.deepStrictEqual([...new Set(requests.map((url) => new URL(url).host))], ["acme-dev.crm.dynamics.com"]);
    const cached = readJson(path.join(storage, "metadata", "acme-dev.crm.dynamics.com", "tables.json"));
    assert.ok(!JSON.stringify(cached).includes("from_acme-prod"), "PROD's tables aren't cached as DEV's");
  });

  await test("tenantsInFile: a repeated name is offered once; saving or removing it leaves the other entry alone", async () => {
    const root = tmp();
    const file = path.join(root, ".lantern", "config.json");
    // A teammate copied the Acme block to start a UAT tenant and hasn't renamed it yet.
    writeJson(file, { defaultTenant: "Acme", tenants: [
      { name: "Acme", org: "https://acme.crm.dynamics.com", solutions: ["AcmeCore"] },
      { name: "Acme", org: "https://acme-uat.crm.dynamics.com", solutions: ["AcmeUat"] },
    ] });
    tc.configureTenantContext(path.join(root, "tenants.json"), "folder", () => [root]);
    const offered = tc.availableTenants();
    assert.deepStrictEqual(offered.map((t) => t.orgHost), ["acme.crm.dynamics.com"]);
    offered[0].config.account = "me@acme.com";
    offered[0].save();
    const [acme, uat] = readJson(file).tenants;
    assert.deepStrictEqual([acme.org, acme.account, acme.solutions], ["https://acme.crm.dynamics.com", "me@acme.com", ["AcmeCore"]]);
    assert.deepStrictEqual(uat, { name: "Acme", org: "https://acme-uat.crm.dynamics.com", solutions: ["AcmeUat"] }, "the second entry is untouched");
    tc.removeTenant(offered[0]);
    assert.deepStrictEqual(readJson(file).tenants.map((t) => t.org), ["https://acme-uat.crm.dynamics.com"], "only the offered entry is removed");
  });

  await test("save: a tenant renamed or removed in another window isn't written back", async () => {
    const base = tmp();
    const file = path.join(base, "tenants.json");
    writeJson(file, { legacyImported: true, tenants: [{ name: "Acme", org: "https://acme.crm.dynamics.com" }, { name: "Beta", org: "https://beta.crm.dynamics.com" }] });
    const acme = clients.tenantsInFile(file, base).find((t) => t.name === "Acme");
    const doc = readJson(file);
    doc.tenants[0].name = "Acme Corp";
    writeJson(file, doc);
    acme.reload();
    acme.config.account = "me@acme.com";
    assert.throws(() => acme.save(), /Acme isn't in .*tenants\.json anymore/);
    assert.deepStrictEqual(readJson(file).tenants.map((t) => t.name), ["Acme Corp", "Beta"]);
  });

  await test("save: Switch Environment then Sign In As keeps the saved default environment", async () => {
    const root = tmp();
    const file = path.join(root, ".lantern", "config.json");
    writeJson(file, { defaultTenant: "Acme", tenants: [{ name: "Acme",
      environments: [{ name: "DEV", org: "https://acme-dev.crm.dynamics.com" }, { name: "PROD", org: "https://acme-prod.crm.dynamics.com", protected: true }] }] });
    tc.configureTenantContext(path.join(root, "tenants.json"), "folder", () => [root]);
    const acme = tc.activeTenant();
    assert.strictEqual(acme.envName, "DEV");
    acme.selectEnvironment("PROD");
    acme.config.account = "prod@acme.com"; // Sign In As on PROD
    acme.save();
    const saved = readJson(file).tenants[0];
    assert.notStrictEqual(saved.defaultEnvironment, "PROD", "switching doesn't change the default");
    assert.deepStrictEqual(saved.accounts, { PROD: "prod@acme.com" });
    assert.deepStrictEqual([acme.envName, acme.config.account], ["PROD", "prod@acme.com"], "this window stays on PROD");
    assert.strictEqual(clients.tenantsInFile(file, root)[0].envName, "DEV", "the next window opens on DEV");
  });

  await test("activation: a tenants.json that doesn't parse doesn't stop Lantern, and says which file", async () => {
    const base = tmp();
    const root = path.join(base, "ws");
    const storage = path.join(base, "storage");
    fs.mkdirSync(root);
    const file = path.join(storage, "tenants.json");
    writeJson(file, '{ "legacyImported": true, "tenants": [ { "name": "Acme", "org": "https://acme.crm.dynamics.com" }, ] }');
    S.workspaceFolders = [root];
    S.config.clientSettingsLocation = "global";
    const listeners = (S.configListeners || []).length;
    activate(storage);
    assert.strictEqual(S.context["lantern.tenantSelected"], false, "activation ran to the end");
    const about = () => S.messages.filter((m) => m[0] === "warn" && m[1].includes(file));
    assert.strictEqual(about().length, 1);
    // Changing the storage setting sets the store up again; that mustn't throw or repeat the warning.
    for (const listener of S.configListeners.slice(listeners)) listener({ affectsConfiguration: (s) => s === "lantern" || s === "lantern.clientSettingsLocation" });
    assert.strictEqual(about().length, 1);
    await run("selectTenant");
    assert.strictEqual(about().length, 2, "Select Tenant points at the file");
    assert.ok(!S.messages.some((m) => /No tenants are configured/.test(m[1])));
  });

  await test("legacy import: two old folders on the same org both import, each with its own folder", async () => {
    const base = tmp();
    const root = path.join(base, "ws");
    const storage = path.join(base, "storage");
    clients.useClientStore(path.join(storage, "clients"), path.join(storage, "ignored-folders.json"));
    try {
      for (const [folder, config] of [
        ["acme-plugins", { org: "https://acme.crm.dynamics.com", solutions: ["AcmePlugins"] }],
        ["acme-web", { org: "https://acme.crm.dynamics.com", solutions: ["AcmeWeb"], webResourceRoots: ["src/WebResources"] }],
      ]) {
        fs.mkdirSync(path.join(root, folder), { recursive: true });
        clients.ensureClientConfig(path.join(root, folder), config, { jsconfig: false });
      }
      tc.configureTenantContext(path.join(storage, "tenants.json"), "global", () => [root]);
      tc.importSavedTenants(path.join(storage, "clients"));
      const imported = readJson(path.join(storage, "tenants.json")).tenants;
      assert.deepStrictEqual(imported.map((t) => [t.name, t.folder, t.solutions]), [
        ["acme-plugins", path.join(root, "acme-plugins"), ["AcmePlugins"]],
        ["acme-web", path.join(root, "acme-web"), ["AcmeWeb"]],
      ]);
      assert.deepStrictEqual(tc.availableTenants().map((t) => t.dir), [path.join(root, "acme-plugins"), path.join(root, "acme-web")]);
    } finally {
      clients.useClientStore(undefined);
    }
  });

  await test("app registration secret: kept when Add Environment names the single org, and when it's renamed", async () => {
    const store = new Map();
    auth.useSecrets({ get: async (k) => store.get(k), store: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) });
    const base = tmp();
    const file = path.join(base, "tenants.json");
    const org = "https://acme.crm.dynamics.com";
    const appId = "11112222-3333-4444-5555-666677778888";
    tc.configureTenantContext(file, "global", () => []);
    const acme = tc.addTenant("Acme", { org, tenant: "contoso.onmicrosoft.com", appId });
    // Where the previous version kept a single org's secret.
    const hashed = (identity) => `lantern.appSecret.${crypto.createHash("sha256").update(identity).digest("hex")}`;
    store.set(hashed(`${org}|contoso.onmicrosoft.com||${appId}`), "s3cret");
    // Add Environment names the org in use DEV and adds TEST, as commands/environments.ts does.
    acme.reload();
    acme.config.environments.push({ name: "DEV", org: acme.config.org });
    acme.config.environment = "DEV";
    acme.config.environments.push({ name: "TEST", org: "https://acme-test.crm.dynamics.com" });
    acme.save();
    assert.deepStrictEqual([acme.envName, readJson(file).tenants[0].defaultEnvironment], ["DEV", "DEV"], "the single org became DEV, the default");
    assert.strictEqual(await auth.appSecret(acme), "s3cret");
    assert.strictEqual(await auth.getToken(acme), "app-token");
    const doc = readJson(file);
    doc.tenants[0].environments[0].name = "Development";
    doc.tenants[0].defaultEnvironment = "Development";
    writeJson(file, doc);
    const renamed = clients.tenantsInFile(file, base)[0];
    assert.strictEqual(renamed.envName, "Development");
    assert.strictEqual(await auth.appSecret(renamed), "s3cret", "renaming the environment keeps the secret");
  });

  await test("Environment section follows Sign In As, and Refresh reloads every loaded section", async () => {
    const base = tmp();
    const root = path.join(base, "ws");
    const storage = path.join(base, "storage");
    fs.mkdirSync(root);
    writeJson(path.join(storage, "tenants.json"), { legacyImported: true, tenants: [{ name: "Acme", org: "https://acme.crm.dynamics.com", account: "old@acme.com" }] });
    S.workspaceFolders = [root];
    S.config.clientSettingsLocation = "global";
    S.accounts = ["old@acme.com", "new@acme.com"];
    activate(storage);
    S.quickPickAnswers.push("Acme");
    await run("selectTenant");
    const tree = S.treeViews["lantern.environment"].treeDataProvider;
    const section = async (name) => (await tree.getChildren()).find((node) => node.kind === "section" && node.section === name);
    const environment = async () => (await tree.getChildren(await section("environment"))).slice(0, 2).map((node) => node.value);
    assert.deepStrictEqual(await environment(), ["old@acme.com", "User 1 (x)"]);

    const jobLoads = () => requests.filter((url) => url.includes("asyncoperations")).length;
    await tree.getChildren(await section("jobs"));
    const loads = jobLoads();
    await tree.getChildren(await section("jobs"));
    assert.strictEqual(jobLoads(), loads, "redrawing uses the loaded jobs");
    await run("refresh");
    await tree.getChildren(await section("jobs"));
    assert.strictEqual(jobLoads(), loads + 1, "Refresh loads the jobs again");

    S.quickPickAnswers.push("new@acme.com");
    whoami = "2";
    await run("signInAs");
    assert.strictEqual(tc.activeTenant().config.account, "new@acme.com");
    assert.deepStrictEqual(await environment(), ["new@acme.com", "User 2 (x)"]);
  });

  await test("Switch Environment: a load still running on the old org doesn't hold the Solutions view on it", async () => {
    const base = tmp();
    const root = path.join(base, "ws");
    const storage = path.join(base, "storage");
    fs.mkdirSync(root);
    writeJson(path.join(storage, "tenants.json"), { legacyImported: true, tenants: [{ name: "Acme", account: "me@acme.com", solutions: ["Core"], defaultEnvironment: "DEV",
      environments: [{ name: "DEV", org: "https://acme-dev.crm.dynamics.com" }, { name: "TEST", org: "https://acme-test.crm.dynamics.com" }] }] });
    S.workspaceFolders = [root];
    S.config.clientSettingsLocation = "global";
    S.accounts = ["me@acme.com"];
    activate(storage);
    S.quickPickAnswers.push("Acme");
    await run("selectTenant");
    const tree = S.treeViews["lantern.clients"].treeDataProvider;
    const tablesPart = async () => {
      const [core] = await tree.getChildren();
      return (await tree.getChildren(core)).find((node) => node.part === "tables");
    };
    const devTables = await tablesPart();

    // DEV's table list doesn't come back until the test says so: like a big org, or a sign-in nobody answers.
    const realFetch = global.fetch;
    let release;
    const gate = new Promise((r) => (release = r));
    global.fetch = async (url, init) => {
      if (String(url).includes("acme-dev") && /EntityDefinitions/.test(url)) await gate;
      return realFetch(url, init);
    };
    try {
      const pending = tree.getChildren(devTables);
      await settle();
      const dv = auth.dataverseFor(tc.activeTenant());
      S.quickPickAnswers.push("TEST");
      await run("environments.switch");
      assert.strictEqual(tc.activeTenant().envName, "TEST");
      assert.deepStrictEqual(await Promise.race([pending, settle(1000).then(() => "still waiting on DEV")]), [], "the DEV load gives way");

      const testTables = await tree.getChildren(await tablesPart());
      assert.ok(requests.some((url) => url.includes("acme-test") && url.includes("EntityDefinitions")), "TEST's tables load");
      assert.strictEqual(testTables[0].text, "No tables in this solution");
      // The DEV load finishes in the background (into DEV's cache), before anything below can change sign-in.
      release();
      await settle(200);

      // A connection made on DEV still signs in to DEV after the switch.
      auth.clearTokenCache();
      await dv.whoAmI();
      assert.match(S.lastScopes[0], /^https:\/\/acme-dev\.crm\.dynamics\.com\//);
    } finally {
      release();
      global.fetch = realFetch;
      await settle(200);
    }
  });

  await test("an edited \"folder\" moves the active tenant there, on the environment it was on", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "old"));
    fs.mkdirSync(path.join(root, "new"));
    const file = path.join(root, ".lantern", "config.json");
    const config = (folder) => ({ defaultTenant: "Acme", tenants: [{ name: "Acme", folder, defaultEnvironment: "DEV",
      environments: [{ name: "DEV", org: "https://acme-dev.crm.dynamics.com" }, { name: "PROD", org: "https://acme-prod.crm.dynamics.com" }] }] });
    writeJson(file, config("old"));
    tc.configureTenantContext(path.join(root, "tenants.json"), "folder", () => [root]);
    tc.activeTenant().selectEnvironment("PROD");
    assert.strictEqual(tc.activeTenant().dir, path.join(root, "old"));
    writeJson(file, config("new"));
    // What saving the config in the editor does (extension.ts, onDidSaveTextDocument).
    tc.configureTenantContext(path.join(root, "tenants.json"), "folder", () => [root]);
    const acme = tc.activeTenant();
    assert.deepStrictEqual([acme.dir, acme.envName], [path.join(root, "new"), "PROD"]);
    assert.strictEqual(ctx.clientForPath(path.join(root, "new", "x.js")), acme);
  });

  await test("schema: the values Lantern writes by default are allowed", async () => {
    const base = tmp();
    const file = path.join(base, "tenants.json");
    tc.configureTenantContext(file, "global", () => []);
    const acme = tc.addTenant("Acme", { org: "https://acme.crm.dynamics.com", solutions: ["AcmeCore"] });
    acme.config.solutions.push("AcmeWeb");
    acme.save();
    const schema = readJson(path.join(__dirname, "..", "..", "schemas", "client.schema.json"));
    const entry = readJson(file).tenants[0];
    assert.ok(schema.properties.scriptModels.properties.language.enum.includes(entry.scriptModels.language), `scriptModels.language ${JSON.stringify(entry.scriptModels.language)}`);
    assert.ok(schema.properties.pluginDeploy.enum.includes(entry.pluginDeploy), `pluginDeploy ${JSON.stringify(entry.pluginDeploy)}`);
  });

  await test("connection check: opening a window never prompts to sign in, and offers Sign In As instead", async () => {
    const realGetSession = vscode.authentication.getSession;
    const asked = [];
    // VS Code with no session for these orgs: a silent request gets nothing.
    vscode.authentication.getSession = (provider, scopes, options) => {
      asked.push(options || {});
      return options && options.silent ? Promise.resolve(undefined) : realGetSession.call(vscode.authentication, provider, scopes, options);
    };
    try {
      for (const account of [undefined, "me@acme.com"]) {
        fresh();
        asked.length = 0;
        const base = tmp();
        const root = path.join(base, "ws");
        writeJson(path.join(root, ".lantern", "config.json"), { defaultTenant: "Acme", tenants: [{ name: "Acme", org: "https://acme.crm.dynamics.com", ...(account ? { account } : {}) }] });
        S.workspaceFolders = [root];
        S.config.clientSettingsLocation = "folder";
        activate(path.join(base, "storage"));
        await settle(50);
        assert.ok(asked.every((options) => options.silent === true), `${account ?? "unpinned"}: only silent sign-in requests, got ${JSON.stringify(asked)}`);
        assert.ok(S.messages.some((m) => m[0] === "warn" && /couldn't authenticate to acme\.crm\.dynamics\.com: Not signed in/.test(m[1])), `${account ?? "unpinned"}: offered Sign In As`);
      }
    } finally {
      vscode.authentication.getSession = realGetSession;
    }
  });

  await test("activation: a failure carrying over old settings is logged, not left unhandled", async () => {
    const base = tmp();
    const root = path.join(base, "ws");
    fs.mkdirSync(root);
    S.workspaceFolders = [root];
    S.config.clientSettingsLocation = "global";
    const failing = { get: (k, d) => { if (k === "lantern.migratedLegacySettings") throw new Error("global state unavailable"); return d; }, update: async () => {}, keys: () => [] };
    const before = (S.output || []).length;
    activate(path.join(base, "storage"), failing);
    await settle();
    assert.deepStrictEqual(unhandled.filter((e) => /global state unavailable/.test(e && e.message)), []);
    assert.ok((S.output || []).slice(before).some((line) => /global state unavailable/.test(line)), "written to the Lantern output");
  });

  console.log(`${passed} tenants regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  if (failures.length) process.exitCode = 1;
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* Lantern's log may still be open on Windows. */ }
  // Activation leaves timers and watchers running; the results are in.
  process.exit();
})();
