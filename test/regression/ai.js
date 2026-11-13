// Regression tests for the AI tools: Claude Code / Codex setup, the MCP server and bridge,
// the tools' inputs, flow search, security role privileges and environment names.
// Run with: npm run compile && node test/regression/ai.js (LANTERN_OUT=<dir> to test another build).
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
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

// Everything that reads a home or config folder looks in a temp one: ~/.lantern is fixed when
// mcp/bridge.js loads, so this comes before any of Lantern's modules.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-ai-"));
const HOME = path.join(SANDBOX, "home");
fs.mkdirSync(HOME, { recursive: true });
Object.assign(process.env, { HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), CODEX_HOME: path.join(HOME, "codex") });
// A claude CLI that always fails, first on PATH, in case the stub below ever misses.
const BIN = path.join(SANDBOX, "bin");
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, "claude.cmd"), "@exit /b 1\r\n");
fs.writeFileSync(path.join(BIN, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const vscode = require("vscode");
const S = vscode.__state;
const stub = async () => ({ code: -1, stdout: "", stderr: "", missing: true });
Object.defineProperty(out("core/process.js"), "run", { value: stub });
assert.strictEqual(out("core/process.js").run, stub, "the claude CLI stub is in place");

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

const port = () => 47000 + Math.floor(Math.random() * 2000);
const claudeFile = () => path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
const codexFile = () => path.join(process.env.CODEX_HOME, "config.toml");
/** Fresh Claude and Codex config folders for one test. */
const freshConfigs = () => {
  for (const d of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
};
const extension = (secrets) => ({
  secrets,
  extension: { packageJSON: { version: "9" } },
  extensionPath: path.dirname(OUT),
  extensionUri: vscode.Uri.file(path.dirname(OUT)),
});
function aiTools() {
  const { AiTools } = out("ui/aiTools.js");
  S.config["lantern.mcp.enabled"] = true;
  S.config["lantern.mcp.port"] = port();
  const secrets = new Map();
  return new AiTools(extension({ get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v) }), () => []);
}
function post(p, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const req = http.request({ host: "127.0.0.1", port: p, path: "/mcp", method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const reached = () => {
  throw new Error("reached the org");
};

(async () => {
  // ---------- Claude Code and Codex setup ----------
  const original = {
    oauthAccount: { emailAddress: "me@example.com" },
    projects: { "C:/work": { allowedTools: ["Bash"] } },
    mcpServers: { github: { type: "http", url: "https://example.com/mcp" } },
  };

  await test("claude setup: a ~/.claude.json with a BOM keeps everything else in it", async () => {
    freshConfigs();
    fs.writeFileSync(claudeFile(), String.fromCharCode(0xfeff) + JSON.stringify(original, null, 2));
    const ai = aiTools();
    try {
      await ai.setup("claude");
      const after = JSON.parse(fs.readFileSync(claudeFile(), "utf8"));
      assert.deepStrictEqual(after.oauthAccount, original.oauthAccount, "sign-in kept");
      assert.deepStrictEqual(after.projects, original.projects, "projects kept");
      assert.deepStrictEqual(Object.keys(after.mcpServers).sort(), ["github", "lantern"]);
    } finally {
      ai.dispose();
    }
  });

  await test("claude setup: an unreadable ~/.claude.json is left alone, with a way forward", async () => {
    for (const text of ["null", '{ "oauthAccount": { "emailAddress": "me@exa', "[]"]) {
      freshConfigs();
      fs.writeFileSync(claudeFile(), text);
      const ai = aiTools();
      try {
        await assert.rejects(ai.setup("claude"), /left the file alone[\s\S]*Copy Config/, `setup refuses ${text}`);
        assert.strictEqual(fs.readFileSync(claudeFile(), "utf8"), text, `${text} unchanged`);
      } finally {
        ai.dispose();
      }
    }
  });

  await test("config writes keep the file's permissions (0600 for a new file)", async () => {
    freshConfigs();
    fs.writeFileSync(codexFile(), 'model = "o3"\n');
    fs.chmodSync(codexFile(), 0o600);
    const before = fs.statSync(codexFile()).mode & 0o777;
    // What each temp file is created with: on Windows the mode can't be read back, so it's checked here.
    const modes = new Map();
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (file, data, options) {
      const m = /^(.*)\.\d+\.tmp$/.exec(String(file));
      if (m) modes.set(path.resolve(m[1]), options && typeof options === "object" ? options.mode : undefined);
      return realWrite.apply(this, arguments);
    };
    const ai = aiTools();
    try {
      await ai.setup("codex");
      await ai.setup("claude");
    } finally {
      fs.writeFileSync = realWrite;
      ai.dispose();
    }
    assert.strictEqual(modes.get(path.resolve(codexFile())), before, "config.toml's temp file has its mode");
    assert.strictEqual(modes.get(path.resolve(claudeFile())), 0o600, "a new ~/.claude.json is 0600");
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(codexFile()).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(claudeFile()).mode & 0o777, 0o600);
    }
  });

  await test("codex: removing Lantern's table keeps a [[array of tables]] after it", () => {
    const { withoutCodexServer } = out("ui/aiTools.js");
    const toml = [
      'model = "o3"', "", "[mcp_servers.lantern]", "command = 'x'", "", "[[hooks]]", 'event = "start"', 'run = "echo hi"', "",
      "[mcp_servers.lantern.env]", 'A = "1"', "", "[profiles.fast]", 'model = "o4-mini"', "",
    ].join("\n");
    assert.strictEqual(withoutCodexServer(toml), ['model = "o3"', "", "[[hooks]]", 'event = "start"', 'run = "echo hi"', "", "[profiles.fast]", 'model = "o4-mini"'].join("\n"));
  });

  await test("AI Tools: failures are reported, never swallowed or left unhandled", async () => {
    const { AiTools } = out("ui/aiTools.js");
    S.config["lantern.mcp.enabled"] = true;
    S.config["lantern.mcp.port"] = port();
    freshConfigs();
    // Set up before with this address, so showing the tab needs the token.
    fs.writeFileSync(claudeFile(), JSON.stringify({ mcpServers: { lantern: { type: "http", url: `http://127.0.0.1:${S.config["lantern.mcp.port"]}/mcp` } } }));
    const before = (S.configListeners || []).length;
    const ai = new AiTools(extension({ get: async () => { throw new Error("keychain locked"); }, store: async () => undefined }), () => []);
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    const settle = () => new Promise((r) => setTimeout(r, 100));
    try {
      S.messages.length = 0;
      S.configListeners[before]({ affectsConfiguration: (s) => s === "lantern.mcp" });
      await settle();
      assert.ok(S.messages.some(([kind, msg]) => kind === "error" && /keychain locked/.test(msg)), "a failed start after a settings change is shown");
      ai.open();
      await settle();
      await S.panels[S.panels.length - 1].webview.send({ type: "copy", id: "claude" });
      await settle();
      assert.deepStrictEqual(unhandled.map(String), [], "opening the tab and a failed copy");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      ai.dispose();
    }
  });

  // ---------- MCP server and bridge ----------
  const { LanternMcpServer } = out("mcp/server.js");
  const invalid = (id) => ({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });

  await test("mcp server: invalid requests get -32600; notifications and responses get nothing", async () => {
    const p = port();
    const server = new LanternMcpServer({ port: p, token: "tok", version: "1", tools: () => [] });
    assert.strictEqual((await server.start()).state, "listening");
    try {
      assert.deepStrictEqual(await server.dispatch({ jsonrpc: "2.0", id: 5 }), invalid(5), "an id but no method");
      assert.deepStrictEqual(await server.dispatch({ jsonrpc: "2.0", id: 6, method: 7 }), invalid(6), "a method that isn't a string");
      assert.deepStrictEqual(await server.dispatch(null), invalid(null));
      assert.strictEqual(await server.dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined, "a notification");
      assert.strictEqual(await server.dispatch({ jsonrpc: "2.0", id: 9, result: {} }), undefined, "a response");
      const empty = await post(p, "[]", "tok");
      assert.deepStrictEqual([empty.status, JSON.parse(empty.text)], [200, invalid(null)], "an empty batch");
      const batch = await post(p, '[1, {"jsonrpc":"2.0","method":"notifications/initialized"}, {"jsonrpc":"2.0","id":2,"method":"ping"}]', "tok");
      assert.deepStrictEqual(JSON.parse(batch.text), [invalid(null), { jsonrpc: "2.0", id: 2, result: {} }]);
    } finally {
      await server.stop();
    }
  });

  await test("bridge: a null line is answered and doesn't stop the requests after it", async () => {
    const p = port();
    const server = new LanternMcpServer({ port: p, token: "tok", version: "1", tools: () => [] });
    assert.strictEqual((await server.start()).state, "listening");
    const disc = path.join(SANDBOX, "mcp.json");
    fs.writeFileSync(disc, JSON.stringify({ port: p, token: "tok" }));
    try {
      const child = spawn(process.execPath, [path.join(OUT, "mcp", "bridge.js")], { env: { ...process.env, LANTERN_MCP_FILE: disc } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const exited = new Promise((r) => child.on("exit", r));
      child.stdin.write("null\n");
      // Sent once the bridge has had the null line, so a crash on it would leave this unanswered.
      await new Promise((r) => setTimeout(r, 300));
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      child.stdin.end();
      const code = await exited;
      assert.strictEqual(code, 0, stderr);
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
      assert.deepStrictEqual(lines, [invalid(null), { jsonrpc: "2.0", id: 1, result: {} }]);
    } finally {
      await server.stop();
    }
  });

  // ---------- the tools' inputs ----------
  const { selectTenant } = out("ui/tenantContext.js");
  const tenantDir = path.join(SANDBOX, "tenant");
  fs.mkdirSync(tenantDir, { recursive: true });
  selectTenant({
    name: "Contoso", envName: undefined, isProtected: false, orgHost: "contoso.crm.dynamics.com", dir: tenantDir, environments: [],
    config: { org: "https://contoso.crm.dynamics.com", solutions: [] },
  });
  const asked = [];
  const tools = out("ui/lanternTools.js").lanternTools(() => ({ forms: async (t) => (asked.push(t), reached()), tables: async () => reached() }));
  const tool = (name) => tools.find((t) => t.name === name);

  await test("lantern_query: FetchXML with an <?xml?> prolog or a leading comment runs as FetchXML", async () => {
    for (const q of ['<?xml version="1.0"?>\n<fetch><entity name="account"/></fetch>', '<!-- active accounts -->\n<fetch><entity name="account"/></fetch>']) {
      await assert.rejects(tool("lantern_query").invoke({ query: q }), /reached the org/, q);
    }
    await assert.rejects(tool("lantern_query").invoke({ query: "DELETE FROM account" }), /Only SELECT/);
  });

  await test("lantern_where_used and lantern_trace_column take only logical names", async () => {
    for (const name of ["lantern_where_used", "lantern_trace_column"]) {
      await assert.rejects(tool(name).invoke({ table: "account' or objecttypecode ne 'x", column: "name" }), /Pass the logical name/, `${name} table`);
      await assert.rejects(tool(name).invoke({ table: "account", column: "name') or (1 eq 1" }), /Pass the logical name/, `${name} column`);
      await assert.rejects(tool(name).invoke({ table: " Account ", column: "cr36f_Name" }), /reached the org/, `${name} takes logical names in any case`);
    }
    assert.deepStrictEqual(asked, ["account", "account"], "only the valid names reached the org");
  });

  await test("lantern_query: FetchXML that matches nothing says 0 rows instead of an empty table", async () => {
    const auth = out("ui/auth.js");
    const real = auth.dataverseFor;
    Object.defineProperty(auth, "dataverseFor", { value: () => ({ getJson: async () => ({ value: [] }) }), configurable: true, writable: true });
    try {
      const svc = () => ({ tables: async () => [{ logicalName: "account", entitySetName: "accounts", primaryId: "accountid" }] });
      const query = out("ui/lanternTools.js").lanternTools(svc).find((x) => x.name === "lantern_query");
      const md = await query.invoke({ query: '<fetch top="3"><entity name="account"><attribute name="name"/></entity></fetch>' });
      assert.strictEqual(md, "0 row(s) from Contoso.");
      assert.match(await query.invoke({ query: "SELECT name FROM account" }), /\| name \|/, "SQL still shows its columns");
    } finally {
      Object.defineProperty(auth, "dataverseFor", { value: real, configurable: true, writable: true });
    }
  });

  await test("where used / trace: a common column name lists 40 code lines, the table's files first", async () => {
    const refs = out("core/references.js");
    const dir = path.join(SANDBOX, "codehits");
    fs.mkdirSync(dir, { recursive: true });
    // 60 files that use "name" for another table, and one that names account.
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `q${String(i).padStart(2, "0")}.js`), `retrieve("queue", "name");\n`);
    fs.writeFileSync(path.join(dir, "zz.js"), `retrieve("account", "name");\n`);
    const code = refs.codeUsages(dir, "name", undefined, "account");
    assert.strictEqual(code.length, 61);
    const report = { table: "account", column: "name", forms: [], views: [], processes: [], steps: [], code, failures: [] };
    const md = refs.usageMarkdown(report, "account.name", (f, l) => `${f}:${l}`, dir, out("core/componentOutlines.js").TRACE_MAX_CODE_LINES);
    const listed = md.split("\n").filter((l) => l.startsWith("- ["));
    assert.strictEqual(listed.length, 40);
    assert.match(listed[0], /zz\.js:1\]/, "the file that names the table comes first");
    assert.match(md, /## Code in this client folder \(61\)/);
    assert.match(md, /\.\.\.and 21 more lines in 21 files/);
    assert.match(md, /Matched by column name/);
    const full = refs.usageMarkdown(report, "account.name", (f, l) => `${f}:${l}`, dir);
    assert.strictEqual(full.split("\n").filter((l) => l.startsWith("- [")).length, 61, "the VS Code document lists them all");
    assert.ok(!/more lines/.test(full));
  });

  await test("explain plugin: the tenant's assemblies are listed in full, Microsoft's on one line", async () => {
    const outlines = out("core/componentOutlines.js");
    const assemblies = [
      { pluginassemblyid: "1", name: "Microsoft.CDS.Catalog.Plugins", version: "9.0.0.0", ismanaged: true },
      { pluginassemblyid: "2", name: "Contoso.Plugins", version: "1.0.0.0", ismanaged: true },
      { pluginassemblyid: "3", name: "Contoso.Dev", version: "1.0.0.0", ismanaged: false },
    ];
    const types = [
      { plugintypeid: "a", typename: "Microsoft.CDS.Catalog.CatalogCreatePlugin", _pluginassemblyid_value: "1" },
      { plugintypeid: "b", typename: "Contoso.Plugins.AccountPreCreate", _pluginassemblyid_value: "2" },
    ];
    const dv = { getAll: async (p) => (p.startsWith("pluginassemblies") ? assemblies : p.startsWith("plugintypes") ? types : []) };
    const md = await outlines.outlinePlugin(dv, {}, SANDBOX);
    assert.match(md, /^Plug-in assemblies/);
    assert.match(md, /- Contoso\.Plugins 1\.0\.0\.0 \(managed\): AccountPreCreate/, "a client's managed assembly is still listed in full");
    assert.match(md, /- Contoso\.Dev 1\.0\.0\.0: no classes/);
    assert.match(md, /Also 1 managed Microsoft assembly: Microsoft\.CDS\.Catalog\.Plugins\./);
    assert.ok(!/CatalogCreatePlugin/.test(md), "Microsoft's classes aren't listed");
    await assert.rejects(outlines.outlinePlugin(dv, { assembly: "Nope" }, SANDBOX), /Registered \(besides Microsoft's\): Contoso\.Plugins, Contoso\.Dev\./);
  });

  // ---------- flow search ----------
  const fa = out("core/flowAnalysis.js");
  const api = (connector, operationId, extra = {}) => ({ type: "OpenApiConnection", inputs: { host: { apiId: `/providers/Microsoft.PowerApps/apis/${connector}`, operationId }, parameters: {} }, ...extra });
  const flow = (triggers, actions) => JSON.stringify({ properties: { connectionReferences: {}, definition: { triggers, actions } } });
  const matching = (cap, clientdata) => fa.parseFlow(clientdata).steps.filter((s) => cap.matches(s)).map((s) => s.name);

  await test("flow search: teams and email skip triggers and read operations", () => {
    const teams = flow(
      { On_message: { ...api("shared_teams", "OnNewChannelMessage"), type: "OpenApiConnectionWebhook" } },
      { Get_messages: api("shared_teams", "GetMessagesFromChannel"), Post: api("shared_teams", "PostMessageToConversation", { runAfter: { Get_messages: ["Succeeded"] } }) }
    );
    assert.deepStrictEqual(matching(fa.CAPABILITIES.teams, teams), ["Post"]);
    const email = flow(
      { On_shared_mail: { ...api("shared_office365", "SharedMailboxOnNewEmailV2"), type: "OpenApiConnectionWebhook" } },
      { Export: api("shared_office365", "ExportEmail_V2"), Send: api("shared_office365", "SendEmailV2", { runAfter: { Export: ["Succeeded"] } }) }
    );
    assert.deepStrictEqual(matching(fa.CAPABILITIES.email, email), ["Send"]);
  });

  await test("flow search: text in conditions, loop sources and trigger conditions is found", () => {
    const clientdata = flow(
      { Changed: { ...api("shared_commondataserviceforapps", "SubscribeWebhookTrigger"), conditions: [{ expression: "@equals(triggerOutputs()?['body/cr36f_stage'], 3)" }] } },
      {
        Check: { type: "If", expression: { and: [{ equals: ["@triggerOutputs()?['body/statuscode']", 2] }] }, actions: {}, else: { actions: {} } },
        Loop: { type: "Foreach", foreach: "@body('List_rows')?['value']", runAfter: { Check: ["Succeeded"] }, actions: {} },
      }
    );
    assert.deepStrictEqual(matching(fa.capabilityFor("statuscode"), clientdata), ["Check"]);
    assert.deepStrictEqual(matching(fa.capabilityFor("List_rows"), clientdata), ["Loop"]);
    assert.deepStrictEqual(matching(fa.capabilityFor("cr36f_stage"), clientdata), ["Changed"]);
  });

  await test("flow parsing: a connection reference whose api name isn't a string doesn't crash", () => {
    const clientdata = JSON.stringify({ properties: {
      connectionReferences: { shared_x: { api: { name: 42 }, id: "/providers/Microsoft.PowerApps/apis/shared_office365", connection: { connectionReferenceLogicalName: { odd: true } } } },
      definition: { triggers: {}, actions: { Send: { type: "OpenApiConnection", inputs: { host: { connectionName: "shared_x", operationId: "SendEmailV2" } } } } },
    } });
    const parsed = fa.parseFlow(clientdata);
    assert.deepStrictEqual(parsed.connectors, [{ connector: "shared_office365", reference: "shared_x" }]);
    assert.ok(typeof fa.outlineFlow({ workflowid: "w", name: "N", clientdata, statecode: 1 }) === "string");
  });

  // ---------- security roles ----------
  const sec = out("core/security.js");
  const table = (logicalName, schemaName, displayName) => ({ logicalName, schemaName, displayName, entitySetName: `${logicalName}s`, primaryId: `${logicalName}id`, primaryName: "name", isCustom: false, metadataId: "" });
  const roleDv = (privileges) => ({ getJson: async (url) => (url.startsWith("RetrieveRolePrivilegesRole") ? { RolePrivileges: privileges } : reached()) });

  await test("security: Activity, Note and User privileges reach their tables", async () => {
    const tables = [
      table("email", "Email", "Email"), table("task", "Task", "Task"), table("activitypointer", "ActivityPointer", "Activity"),
      table("annotation", "Annotation", "Note"), table("systemuser", "SystemUser", "User"), table("account", "Account", "Account"),
    ];
    const r = await sec.rolePrivileges(roleDv([{ PrivilegeName: "prvReadActivity", Depth: "Global" }, { PrivilegeName: "prvWriteNote", Depth: "Basic" }, { PrivilegeName: "prvReadUser", Depth: "Local" }]), "role", tables);
    assert.deepStrictEqual(Object.fromEntries(r.tables), { email: { Read: "Global" }, task: { Read: "Global" }, activitypointer: { Read: "Global" }, annotation: { Write: "Basic" }, systemuser: { Read: "Local" } });

    const dv = {
      getJson: async (url) => {
        if (url.includes("RetrievePrincipalAccess")) return { AccessRights: "ReadAccess" };
        if (url.startsWith("emails(")) return { _ownerid_value: "someone-else", _owningbusinessunit_value: "bu" };
        if (url.includes("teammembership_association")) return { value: [] };
        if (url.startsWith("systemusers(")) return { _businessunitid_value: "bu", systemuserroles_association: [{ roleid: "r", name: "Salesperson" }] };
        if (url.startsWith("RetrieveRolePrivilegesRole")) return { RolePrivileges: [{ PrivilegeName: "prvReadActivity", Depth: "Global" }] };
        throw new Error("unexpected " + url);
      },
    };
    const e = await sec.explainAccess(dv, "user-1", tables[0], "44444444-4444-4444-4444-444444444444", tables);
    assert.deepStrictEqual([e.canRead, e.readDepth], [true, "Global"]);
    assert.match(e.reasons[0], /give Read on Email across the organization/);
  });

  await test("security: prvAppendTopic is Append on Topic when Topic is a table", async () => {
    const tables = [table("topic", "Topic", "Topic"), table("pic", "Pic", "Pic")];
    let r = await sec.rolePrivileges(roleDv([{ PrivilegeName: "prvAppendTopic", Depth: "Global" }, { PrivilegeName: "prvAppendToTopic", Depth: "Basic" }]), "role", tables.slice(0, 1));
    assert.deepStrictEqual(Object.fromEntries(r.tables), { topic: { Append: "Global", AppendTo: "Basic" } });
    // When both readings are tables, AppendTo wins as before.
    r = await sec.rolePrivileges(roleDv([{ PrivilegeName: "prvAppendTopic", Depth: "Global" }]), "role", tables);
    assert.deepStrictEqual(Object.fromEntries(r.tables), { pic: { AppendTo: "Global" } });
  });

  // ---------- environment names ----------
  await test("environment names: production is recognised before anything else in the name", () => {
    const { suggestEnvironmentName: s } = out("core/discovery.js");
    assert.strictEqual(s("Contoso Valuation (Production)"), "PROD");
    assert.strictEqual(s("graduateprod"), "PROD");
    assert.strictEqual(s("Fabrikam Live", "fabrikamdevices"), "PROD");
    assert.strictEqual(s("contosolive"), "PROD");
    assert.strictEqual(s("contosodev"), "DEV");
    assert.strictEqual(s("Contoso (UAT)"), "UAT");
    assert.strictEqual(s("contoso-prd"), "PROD");
    assert.strictEqual(s("Delivery Dev"), "DEV", "live inside a word isn't production");
    assert.strictEqual(s("Contoso"), undefined);
  });

  selectTenant(undefined);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`${passed} ai regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  if (failures.length) process.exitCode = 1;
})();
