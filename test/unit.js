// Unit tests: edge cases for the core modules, run with the VS Code mock where a module needs it.
const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? require.resolve("./mock-vscode") : resolve.call(this, request, ...rest);
};
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
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
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-unit-"));
  fs.mkdirSync(path.join(dir, ".lantern"));
  return dir;
};

(async () => {
  // ---------- SQL ----------
  const sql = out("core/sql.js");
  const tr = (q) => sql.translate(q, { primaryIdOf: (t) => `${t}id` });
  const flat = (x) => x.replace(/\s*\n\s*/g, "");

  await test("sql: escaped quotes, negatives, exponents", () => {
    assert.match(flat(tr("SELECT name FROM account WHERE name = 'O''Brien'").fetchXml), /value="O&apos;Brien"|value="O'Brien"/);
    assert.match(flat(tr("SELECT name FROM account WHERE revenue > -5").fetchXml), /operator="gt" value="-5"/);
    assert.match(flat(tr("SELECT name FROM account WHERE revenue = 1.5e3").fetchXml), /value="1500"/);
  });
  await test("sql: NOT pushed down with De Morgan", () => {
    const x = flat(tr("SELECT name FROM account WHERE NOT (name = 'a' OR name IS NULL)").fetchXml);
    assert.match(x, /<filter type="and"><condition attribute="name" operator="ne" value="a" \/><condition attribute="name" operator="not-null" \/><\/filter>/);
  });
  await test("sql: AND binds tighter than OR", () => {
    const x = flat(tr("SELECT name FROM account WHERE statecode = 0 OR statecode = 1 AND name = 'x'").fetchXml);
    assert.match(x, /<filter type="or"><condition attribute="statecode" operator="eq" value="0" \/><filter type="and">/);
  });
  await test("sql: bracketed names, case-insensitive keywords and names", () => {
    assert.match(flat(tr("SELECT [name] FROM [account]").fetchXml), /<entity name="account"><attribute name="name" \/>/);
    assert.match(flat(tr("select Name from Account where NAME = 'x'").fetchXml), /<entity name="account"><attribute name="name" \/><filter><condition attribute="name"/);
  });
  await test("sql: comments and semicolons inside strings", () => {
    assert.match(flat(tr("SELECT name -- c\nFROM account /* b */ WHERE name = 'a;b'").fetchXml), /value="a;b"/);
    assert.deepStrictEqual(sql.splitStatements("SELECT 1 FROM a WHERE x = ';'; SELECT 2 FROM b\nGO\nSELECT 3 FROM c -- ; no\n; /* ; */ SELECT 4 FROM d"), [
      "SELECT 1 FROM a WHERE x = ';'",
      "SELECT 2 FROM b",
      "SELECT 3 FROM c -- ; no",
      "/* ; */ SELECT 4 FROM d",
    ]);
  });
  await test("sql: double-quoted text explains single quotes", () => {
    assert.throws(() => tr('SELECT name FROM account WHERE name = "x"'), /Text values take single quotes: 'x'/);
  });
  await test("sql: clear errors for incomplete queries", () => {
    assert.throws(() => tr("SELECT name, FROM account"), /Expected a column name near "FROM"/);
    assert.throws(() => tr("SELECT name FROM account WHERE"), /near the end of the query/);
    assert.throws(() => tr("SELECT name FROM account WHERE name IN ()"), /Expected a value/);
  });
  await test("sql: TOP on aggregates isn't put in FetchXML (applied to the results)", () => {
    const t = tr("SELECT TOP 5 industrycode, COUNT(*) AS c FROM account GROUP BY industrycode");
    assert.doesNotMatch(t.fetchXml, /top=/);
    assert.strictEqual(t.top, 5);
  });
  await test("sql: INSERT parses multiple rows; mismatched values are caught later", () => {
    const st = sql.parseStatement("INSERT INTO account (name, revenue) VALUES ('A', 1), ('B', NULL)");
    assert.deepStrictEqual(st, { kind: "insert", table: "account", alias: "account", columns: ["name", "revenue"], rows: [["A", 1], ["B", null]] });
    assert.throws(() => sql.parseStatement("INSERT INTO account (name) VALUES ('A'"), /Expected "\)"|Expected \)/);
  });
  await test("sql: UPDATE with alias and DELETE without WHERE", () => {
    const u = sql.parseStatement("UPDATE account a SET a.fax = '1' WHERE a.name = 'x'");
    assert.deepStrictEqual([u.kind, u.alias, u.sets], ["update", "a", [{ column: "fax", value: "1" }]]);
    assert.deepStrictEqual(sql.parseStatement("DELETE account"), { kind: "delete", table: "account", alias: "account", where: undefined });
  });

  // ---------- FetchXML detection ----------
  const query = out("core/query.js");
  await test("fetchxml: declaration and comments before <fetch> are allowed", () => {
    assert.strictEqual(query.fetchXmlStart("<fetch><entity name='a'/></fetch>"), 0);
    const t = '<?xml version="1.0"?>\n<!-- Dataverse: acme -->\n<fetch top="1">';
    assert.strictEqual(t.slice(query.fetchXmlStart(t)).slice(0, 6), "<fetch");
    assert.strictEqual(query.fetchXmlStart("SELECT 1"), -1);
    assert.strictEqual(query.fetchXmlStart("<fetchxml>"), -1);
  });

  // ---------- JS analysis ----------
  const ca = out("core/codeanalysis.js");
  const handlers = out("core/handlers.js");
  const tricky = [
    "// Old: function legacyOnLoad(ctx) { }",
    '/* this.disabled = function () { formContext.getAttribute("gone").getValue(); } */',
    'var msg = "call fake(x) { here }";',
    "Acme.Account = (function () {",
    "  function onLoad(executionContext) {",
    "    const fc = executionContext.getFormContext();",
    '    // fc.getAttribute("commentedout").setValue(1);',
    '    if (fc.getAttribute("name").getValue() === "}") { return; }',
    "    var re = /[{]/;",
    "    helper(fc);",
    "  }",
    "  function helper(fc) {",
    "    fc.getControl('name').setDisabled(true);",
    "    fc.getAttribute(`fax`).getValue();",
    "  }",
    "  return { onLoad: onLoad, helper: helper };",
    "})();",
    "class Thing {",
    '  static async onSave(ctx) { await Xrm.WebApi.updateRecord("account", "x", {}); }',
    "}",
    'export const arrow = async ctx => ctx.getFormContext().getAttribute("telephone1").getValue();',
  ].join("\n");
  await test("js: comments, strings, and regex literals are ignored", () => {
    const o = ca.outlineJs(tricky);
    assert.deepStrictEqual(o.map((f) => f.name), ["onLoad", "helper", "onSave", "arrow"]);
    const onLoad = ca.analyzeJsFunction(tricky, o[0], o);
    assert.deepStrictEqual(onLoad.columns.map((c) => c.name), ["name"], "a regex with { doesn't swallow the next function");
    assert.deepStrictEqual(onLoad.calls.map((c) => c.name), ["helper"]);
    assert.strictEqual(handlers.findFunction(tricky, "legacyOnLoad"), undefined, "a function in a comment isn't a definition");
    assert.strictEqual(handlers.findFunction(tricky, "fake"), undefined, "nor one in a string");
    assert.strictEqual(handlers.findFunction(tricky, "Acme.Account.onLoad").line, 4);
  });
  await test("js: masking keeps every offset", () => {
    const m = ca.maskJs(tricky);
    assert.strictEqual(m.noComments.length, tricky.length);
    assert.strictEqual(m.codeOnly.length, tricky.length);
    assert.strictEqual(m.noComments.split("\n").length, tricky.split("\n").length);
  });
  await test("js: division isn't mistaken for a regex", () => {
    const text = "function f(a, b) { var x = a / b / 2; return { y: x }; }\nfunction g() { formContext.getAttribute(\"fax\"); }";
    const o = ca.outlineJs(text);
    assert.deepStrictEqual(o.map((f) => f.name), ["f", "g"]);
    assert.strictEqual(ca.analyzeJsFunction(text, o[1], o).columns[0].name, "fax");
  });
  await test("js: escaped quotes in strings and templates with braces", () => {
    const text = "function a() { var s = 'it\\'s {'; var t = `${'}'}`; b(); }\nfunction b() {}";
    const o = ca.outlineJs(text);
    assert.deepStrictEqual(o.map((f) => f.name), ["a", "b"]);
    assert.deepStrictEqual(ca.analyzeJsFunction(text, o[0], o).calls.map((c) => c.name), ["b"]);
  });

  // ---------- records ----------
  const admin = out("core/admin.js");
  await test("records: the id parameter wins over other GUIDs in app URLs", () => {
    const rec = "aaaaaaaa-1111-2222-3333-444444444444";
    assert.deepStrictEqual(admin.parseRecordRef(`https://x.crm.dynamics.com/main.aspx?appid=11111111-2222-3333-4444-555555555555&pagetype=entityrecord&etn=account&id=${rec}`), { table: "account", id: rec });
    assert.deepStrictEqual(admin.parseRecordRef(`https://x.crm.dynamics.com/main.aspx?etn=contact&id=%7b${rec.toUpperCase()}%7d`), { table: "contact", id: rec });
    assert.strictEqual(admin.parseRecordRef("https://x.crm.dynamics.com/main.aspx?appid=11111111-2222-3333-4444-555555555555&etn=account"), undefined, "an app URL without a record isn't a record");
    assert.deepStrictEqual(admin.parseRecordRef(`{${rec.toUpperCase()}}`), { table: undefined, id: rec });
    assert.deepStrictEqual(admin.parseRecordRef(`cr36f_project:${rec}`), { table: "cr36f_project", id: rec });
    assert.deepStrictEqual(admin.parseRecordRef(` account / ${rec} `), { table: "account", id: rec });
  });
  await test("records: change data parsing tolerates junk", () => {
    assert.deepStrictEqual(admin.parseChangeData('{"changedAttributes":[{"logicalName":"fax","oldValue":null,"newValue":"1"}]}'), [{ logicalName: "fax", oldValue: undefined, newValue: "1" }]);
    assert.deepStrictEqual(admin.parseChangeData("garbage"), []);
    assert.deepStrictEqual(admin.parseChangeData(null), []);
  });

  // ---------- clients and environments ----------
  const clients = out("core/clients.js");
  await test("clients: internal mode never probes local configuration and removal preserves it", () => {
    const dir = tmp();
    const local = path.join(dir, ".lantern/config.json");
    const content = '{"org":"local.crm.dynamics.com"}';
    fs.writeFileSync(local, content);
    clients.useClientStore(path.join(dir, "internal-store"));
    const exists = fs.existsSync;
    const read = fs.readFileSync;
    const guard = (file) => assert.notEqual(path.resolve(String(file)), local, "internal mode must not access local config");
    fs.existsSync = (file) => { guard(file); return exists(file); };
    fs.readFileSync = (file, ...args) => { guard(file); return read(file, ...args); };
    try {
      assert.equal(clients.readClient(dir), undefined);
      const c = clients.ensureClientConfig(dir, { org: "internal.crm.dynamics.com" }, { jsconfig: false });
      assert.equal(c.orgHost, "internal.crm.dynamics.com");
      c.save();
      clients.removeClientConfig(dir);
      assert.equal(clients.readClient(dir), undefined);
    } finally {
      fs.existsSync = exists;
      fs.readFileSync = read;
      clients.useClientStore(undefined);
    }
    assert.equal(fs.readFileSync(local, "utf8"), content);
    assert.equal(clients.readClient(dir).orgHost, "local.crm.dynamics.com");
  });
  await test("clients: only .lantern/config.json is recognized as local configuration", () => {
    const dir = tmp();
    const otherNames = ["client.json", "config.json", "xdt.json", ".lantern/client.json"];
    for (const name of otherNames) fs.writeFileSync(path.join(dir, name), JSON.stringify({ org: "ignored.crm.dynamics.com" }));
    assert.equal(clients.readClient(dir), undefined);
    const c = clients.ensureClientConfig(dir, { org: "correct.crm.dynamics.com" }, { jsconfig: false });
    assert.equal(c.configFile, path.join(dir, ".lantern/config.json"));
    assert.equal(c.orgHost, "correct.crm.dynamics.com");
    assert.equal(clients.scanClients(dir).clients[0].configFile, c.configFile);
    for (const name of otherNames) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name))).org, "ignored.crm.dynamics.com");
  });
  await test("clients: environments resolve org, account, tenant, protection", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({
      org: "acme.crm.dynamics.com", account: "me@a.com", tenant: "t1",
      environments: [{ name: "DEV", org: "acme.crm.dynamics.com" }, { name: "PROD", org: "https://acme-prod.crm.dynamics.com/", protected: true, account: "old@p.com", tenant: "t2" }],
      environment: "PROD",
    }));
    const c = clients.readClient(dir);
    assert.deepStrictEqual([c.envName, c.config.org, c.config.account, c.config.tenant, c.isProtected], ["PROD", "https://acme-prod.crm.dynamics.com", "old@p.com", "t2", true]);
    const dev = c.withEnvironment("DEV");
    assert.deepStrictEqual([dev.envName, dev.config.org, dev.config.account, dev.config.tenant, dev.isProtected], ["DEV", "https://acme.crm.dynamics.com", "me@a.com", "t1", false]);
    assert.strictEqual(c.envName, "PROD", "withEnvironment doesn't change the original");
  });
  await test("clients: accounts save per environment, and unpinning sticks", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({ account: "me@a.com", environments: [{ name: "DEV", org: "a.crm.dynamics.com" }, { name: "PROD", org: "b.crm.dynamics.com" }], environment: "PROD" }));
    const c = clients.readClient(dir);
    c.config.account = "p@b.com";
    c.save();
    const file = () => JSON.parse(fs.readFileSync(path.join(dir, ".lantern/config.json"), "utf8"));
    assert.deepStrictEqual([file().accounts, file().account], [{ PROD: "p@b.com" }, "me@a.com"]);
    c.config.account = "";
    c.save();
    assert.strictEqual(clients.readClient(dir).config.account, "", "unpinned on PROD, even with a default account");
    assert.strictEqual(clients.readClient(dir).withEnvironment("DEV").config.account, "me@a.com");
  });
  await test("clients: edits to lists survive save; switching saves the environment", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({ environments: [{ name: "DEV", org: "a.crm.dynamics.com" }, { name: "TEST", org: "t.crm.dynamics.com" }] }));
    const c = clients.readClient(dir);
    assert.strictEqual(c.envName, "DEV", "defaults to the first environment");
    c.config.solutions.push("X");
    c.config.environment = "TEST";
    c.save();
    const again = clients.readClient(dir);
    assert.deepStrictEqual([again.config.solutions, again.envName, again.config.org], [["X"], "TEST", "https://t.crm.dynamics.com"]);
  });
  await test("clients: a single org ignores a stale environment name; bad JSON reads as no client", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({ org: "x.crm.dynamics.com", environment: "GHOST" }));
    const c = clients.readClient(dir);
    assert.deepStrictEqual([c.envName, c.config.org, c.isProtected], ["", "https://x.crm.dynamics.com", false]);
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), "{ not json");
    assert.strictEqual(clients.readClient(dir), undefined);
  });

  // ---------- CSV and values ----------
  const csv = out("core/csv.js");
  const write = out("core/write.js");
  await test("csv: semicolons, blank lines, BOM, quoted newlines, CRLF, trailing empty cell", () => {
    assert.deepStrictEqual(csv.parseCsv("a;b\n1;2\n"), [["a", "b"], ["1", "2"]]);
    assert.deepStrictEqual(csv.parseCsv("a,b\n\n\n1,2"), [["a", "b"], ["1", "2"]]);
    assert.deepStrictEqual(csv.parseCsv('\uFEFFname\n"multi\nline"\n'), [["name"], ["multi\nline"]]);
    assert.deepStrictEqual(csv.parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
    assert.deepStrictEqual(csv.parseCsv("a,b\n1,\n"), [["a", "b"], ["1", ""]]);
  });
  await test("values: money, numbers, yes/no, choices by label, blanks", () => {
    const col = (type, extra = {}) => ({ logicalName: "c", displayName: "C", type, ...extra });
    const opts = { options: [{ value: 1, label: "Accounting" }, { value: 2, label: "Agriculture" }] };
    assert.strictEqual(write.coerce(col("Money"), "1,000.50"), 1000.5);
    assert.strictEqual(write.coerce(col("Integer"), " 5 "), 5);
    assert.strictEqual(write.coerce(col("Boolean"), "Yes"), true);
    assert.strictEqual(write.coerce(col("Boolean"), 0), false);
    assert.strictEqual(write.coerce(col("Picklist", opts), "agriculture"), 2);
    assert.strictEqual(write.coerce(col("Picklist", opts), "1"), 1);
    assert.strictEqual(write.coerce(col("String"), ""), null);
    assert.strictEqual(write.coerce(col("String"), 12), "12");
    assert.throws(() => write.coerce(col("Integer"), "12abc"), /needs a number, not '12abc'/);
    assert.throws(() => write.coerce(col("Boolean"), "maybe"), /yes\/no/);
    assert.throws(() => write.coerce(col("Picklist", opts), "Nope"), /no choice labeled 'Nope'. Options: 1 Accounting, 2 Agriculture/);
  });

  // ---------- command bar ----------
  const ribbon = out("core/ribbon.js");
  await test("command bar: each function belongs to the element around it, not a referenced rule", () => {
    const xml = `<RibbonDiffXml><CommandDefinitions>
      <CommandDefinition Id="cmd.A"><EnableRules><EnableRule Id="rule.X" /></EnableRules><Actions>
        <JavaScriptFunction FunctionName="Acme.a" Library="$webresource:acme_/a.js"><CrmParameter Value="PrimaryControl" /></JavaScriptFunction></Actions></CommandDefinition>
      <CommandDefinition Id="cmd.B"><Actions><JavaScriptFunction Library="$webresource:acme_/a.js" FunctionName="Acme.b" /></Actions></CommandDefinition>
    </CommandDefinitions><RuleDefinitions>
      <DisplayRules><DisplayRule Id="disp.1"><CustomRule FunctionName="Acme.show" Library="$webresource:ACME_/a.js" /></DisplayRule></DisplayRules>
      <EnableRules><EnableRule Id="rule.X"><CustomRule FunctionName="Acme.canRun" Library="$webresource:acme_/a.js" Default="true" /></EnableRule></EnableRules>
    </RuleDefinitions><JavaScriptFunction FunctionName="isNaN" Library="isNaN" /></RibbonDiffXml>`;
    assert.deepStrictEqual(ribbon.ribbonUses(xml), [
      { fn: "Acme.a", kind: "command", where: "cmd.A", library: "acme_/a.js" },
      { fn: "Acme.b", kind: "command", where: "cmd.B", library: "acme_/a.js" },
      { fn: "Acme.show", kind: "display rule", where: "disp.1", library: "acme_/a.js" },
      { fn: "Acme.canRun", kind: "enable rule", where: "rule.X", library: "acme_/a.js" },
    ]);
    assert.deepStrictEqual(ribbon.ribbonLabels([{ fn: "Acme.a", kind: "command", where: "cmd.A" }], "this.a"), ["command bar command cmd.A"], "matches on the last name segment");
  });
  await test("command bar: scanning is cached briefly but explicit scans are fresh", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "Sol", "Other"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Sol", "Other", "Solution.xml"), "<UniqueName>Sol</UniqueName>");
    assert.strictEqual(ribbon.scanRibbonFunctions(dir).size, 0);
    fs.writeFileSync(path.join(dir, "Sol", "Other", "Customizations.xml"), '<CommandDefinition Id="c"><JavaScriptFunction FunctionName="f" Library="$webresource:x.js" /></CommandDefinition>');
    assert.strictEqual(ribbon.scanRibbonFunctions(dir).size, 0, "cached");
    assert.strictEqual(ribbon.scanRibbonFunctions(dir, true).get("x.js")[0].where, "c", "fresh");
  });

  // ---------- forms and metadata ----------
  const md = out("core/metadata.js");
  const formXml = `<form><tabs><tab name="T1" visible="false"><labels><label description="Onglet" languagecode="1036" /><label description="Tab &amp; One" languagecode="1033" /></labels><columns><column><sections>
    <section name="S1"><labels><label description="Sec" languagecode="1033"/></labels><rows>
      <row><cell><labels><label description="Name label" languagecode="1033"/></labels><control id="name" classid="{4273EDBD}" datafieldname="name" /></cell></row>
      <row><cell visible="false"><control id="Subgrid_contacts" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}" /></cell></row>
      <row><cell><control id="address1_composite" datafieldname="address1_composite" /></cell></row>
    </rows></section></sections></column></columns></tab>
    <tab><columns><column><sections><section name="S2"><rows><row><cell><control id="fax" datafieldname="fax"/></cell></row></rows></section></sections></column></columns></tab></tabs>
    <header><rows><row><cell><control id="header_ownerid" datafieldname="ownerid"/></cell></row></rows></header>
    <events><event name="onsave"><Handlers><Handler functionName="a.b" libraryName="lib1" enabled="false" passExecutionContext="true"/><Handler functionName="c" libraryName="lib2"/></Handlers></event>
    <event name="onload" application="true"><InternalHandlers><Handler functionName="x" libraryName="y"/></InternalHandlers></event></events>
    <formLibraries><Library name="lib1"/><Library name="lib2"/><Library name="lib1"/></formLibraries></form>`;
  await test("forms: labels prefer English, cells hide controls, composite parts, header, handlers, libraries", () => {
    const f = md.parseFormXml(formXml);
    assert.deepStrictEqual([f.tabs[0].name, f.tabs[0].label, f.tabs[0].visible], ["T1", "Tab & One", false]);
    const controls = f.tabs[0].sections[0].controls;
    assert.deepStrictEqual(controls[0], { id: "name", field: "name", label: "Name label", visible: true, kind: "field" });
    assert.deepStrictEqual([controls[1].id, controls[1].kind, controls[1].visible], ["Subgrid_contacts", "subgrid", false]);
    assert.ok(controls.some((c) => c.id === "address1_composite_compositionLinkControl_address1_line3"), "composite address parts");
    assert.deepStrictEqual(f.header.map((c) => c.field), ["ownerid"]);
    assert.deepStrictEqual(f.events, [{ name: "onsave", attribute: undefined, handlers: [
      { functionName: "a.b", libraryName: "lib1", enabled: false, passExecutionContext: true },
      { functionName: "c", libraryName: "lib2", enabled: true, passExecutionContext: false },
    ] }], "internal handlers are left out");
    assert.deepStrictEqual(f.libraries, ["lib1", "lib2"]);
  });
  await test("forms: guessing a script's table from its name", () => {
    const tables = [{ logicalName: "account" }, { logicalName: "contact" }, { logicalName: "cr36f_project" }, { logicalName: "task" }];
    const g = (n) => md.guessTable(n, tables);
    assert.deepStrictEqual(
      ["cr36f_AccountFormOnLoad", "acme_/scripts/contact.form.js", "account_main.js", "project.js", "Contoso.Account.js", "misc.js", "cr36f_project.js"].map(g),
      ["account", "contact", "account", "cr36f_project", "account", undefined, "cr36f_project"]
    );
    assert.strictEqual(md.tableFromAnnotation("/** @param {Form.cr36f_project.Main.Information} f */"), "cr36f_project");
  });

  // ---------- result shaping and export ----------
  await test("results: lookups, formatted values, link-entity columns, missing values, row ids", () => {
    const rows = [{
      "@odata.etag": "x", accountid: "a1", name: "A", _parentaccountid_value: "p1",
      "_parentaccountid_value@OData.Community.Display.V1.FormattedValue": "Parent",
      "_parentaccountid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "account",
      revenue: 5, "revenue@OData.Community.Display.V1.FormattedValue": "$5.00", "c.fullname": "Bob",
    }];
    const all = query.shape(rows, "all", "accountid");
    assert.deepStrictEqual(all.columns, ["accountid", "name", "parentaccountid", "revenue", "c.fullname"]);
    assert.deepStrictEqual(all.rows[0][2], { raw: "p1", formatted: "Parent", ref: { table: "account", id: "p1" } });
    const picked = query.shape(rows, [{ header: "c.fullname", entityAlias: "c", column: "fullname" }, { header: "missing", column: "missing" }], "accountid");
    assert.deepStrictEqual(picked.rows[0], [{ raw: "Bob" }, { raw: null }]);
    assert.deepStrictEqual(picked.rowIds, ["a1"]);
  });
  await test("results: CSV quotes commas, quotes, and newlines; formatted or stored values", () => {
    const set = { columns: ["a", "b"], rows: [[{ raw: 'x,"y"' }, { raw: null }], [{ raw: "line\nbreak" }, { raw: 5, formatted: "$5" }]] };
    assert.strictEqual(query.toCsv(set, true), 'a,b\r\n"x,""y""",\r\n"line\nbreak",$5\r\n');
    assert.strictEqual(query.toCsv(set, false).split("\r\n")[2], '"line\nbreak",5');
  });
  await test("results: paging cookie decoding and fetch attributes are escaped", () => {
    assert.strictEqual(query.pagingCookieFrom('<cookie pagenumber="2" pagingcookie="%253ccookie%2520page%253d%25221%2522%253e%253c%252fcookie%253e" />'), '<cookie page="1"></cookie>');
    assert.strictEqual(query.pagingCookieFrom(undefined), undefined);
    assert.match(query.withFetchAttributes("<fetch><entity name=\"a\"/></fetch>", { page: "2", "paging-cookie": '<cookie page="1"/>' }), /<fetch page="2" paging-cookie="&lt;cookie page=&quot;1&quot;\/&gt;">/);
  });

  // ---------- HAVING ----------
  await test("having: every comparison, joined with AND", () => {
    const h = (op, value) => [{ alias: "c", op, value }];
    const cases = [["gt", 1, 2, true], ["gt", 2, 2, false], ["ge", 2, 2, true], ["lt", 3, 2, true], ["le", 2, 2, true], ["eq", 2, 2, true], ["ne", 2, 2, false]];
    for (const [op, value, actual, expected] of cases) assert.strictEqual(sql.passesHaving({ c: actual }, h(op, value)), expected, `${actual} ${op} ${value}`);
    assert.strictEqual(sql.passesHaving({ c: 5 }, [{ alias: "c", op: "gt", value: 1 }, { alias: "c", op: "lt", value: 3 }]), false);
  });

  // ---------- code generation ----------
  const codegen = out("core/codegen.js");
  const gen = (format, text, isFetchXml = false) => codegen.generate(format, { text, isFetchXml, org: "https://a.crm.dynamics.com/", entitySetOf: (t) => `${t}s`, options: { primaryIdOf: (t) => `${t}id` } });
  await test("codegen: nested joins link from the right parent, aliases in conditions, orders on links", () => {
    const c = gen("csQuery", "SELECT a.name FROM account a JOIN contact c ON c.parentcustomerid = a.accountid JOIN systemuser u ON u.systemuserid = c.ownerid WHERE u.fullname = 'x' ORDER BY c.fullname DESC").code;
    assert.match(c, /var link1 = query\.AddLink\("contact", "accountid", "parentcustomerid", JoinOperator\.Inner\);/);
    assert.match(c, /var link2 = link1\.AddLink\("systemuser", "ownerid", "systemuserid", JoinOperator\.Inner\);/);
    assert.match(c, /query\.Criteria\.AddCondition\("u", "fullname", ConditionOperator\.Equal, "x"\);/);
    assert.match(c, /link1\.Orders\.Add\(new OrderExpression\("fullname", OrderType\.Descending\)\);/);
  });
  await test("codegen: NOT becomes its opposite; quotes are escaped for each language", () => {
    assert.match(gen("csQuery", "SELECT name FROM account WHERE NOT (name = 'a' AND statecode IN (0, 1))").code, /LogicalOperator\.Or[\s\S]*NotEqual, "a"[\s\S]*NotIn, 0, 1/);
    assert.match(gen("csQuery", "SELECT name FROM account WHERE name = 'say \"hi\"'").code, /"say \\"hi\\""/);
    assert.match(gen("csFetch", "SELECT name FROM account WHERE name = 'a'").code, /<entity name=""account"">/);
    assert.match(gen("xrmWebApi", "SELECT name FROM account WHERE name = '`${x}`'").code, /value="\\`\\\$\{x\}\\`"/);
  });
  await test("codegen: FetchXML input keeps only the <fetch> element; QueryExpression needs SQL", () => {
    const url = gen("webApiUrl", '<?xml version="1.0"?><!-- note --><fetch><entity name="account"/></fetch>', true).code;
    assert.strictEqual(url, "https://a.crm.dynamics.com/api/data/v9.2/accounts?fetchXml=%3Cfetch%3E%3Centity%20name%3D%22account%22%2F%3E%3C%2Ffetch%3E");
    assert.match(gen("csQuery", "<fetch><entity name='account'/></fetch>", true).error, /QueryExpression code is generated from SQL/);
  });

  // ---------- FetchXML context ----------
  const fx = out("ui/fetchXmlLanguage.js");
  await test("fetchxml: the entity around the cursor, and its parent for link-entity to", () => {
    assert.deepStrictEqual(fx.entityContext('<fetch><entity name="account"><attribute name="'), { current: "account", parent: undefined });
    assert.deepStrictEqual(fx.entityContext('<fetch><entity name="account"><link-entity name="contact" from="contactid" to="'), { current: "contact", parent: "account" });
    assert.deepStrictEqual(fx.entityContext('<fetch><entity name="account"><link-entity name="contact"><link-entity name="systemuser" from="'), { current: "systemuser", parent: "contact" });
    assert.deepStrictEqual(fx.entityContext('<fetch><entity name="account"><link-entity name="contact" /><attribute name="'), { current: "account", parent: undefined });
    assert.deepStrictEqual(fx.entityContext('<fetch><entity name="account"><link-entity name="contact"></link-entity><filter><condition attribute="'), { current: "account", parent: undefined });
  });

  // ---------- security ----------
  const sec = out("core/security.js");
  await test("security: privilege names, AppendTo before Append, best level across roles", () => {
    assert.deepStrictEqual(["prvAppendToAccount", "prvAppendAccount", "prvReadcr36f_Project", "prvFoo", "prvCreate"].map(sec.parsePrivilege), [
      { action: "AppendTo", schema: "Account" }, { action: "Append", schema: "Account" }, { action: "Read", schema: "cr36f_Project" }, undefined, undefined,
    ]);
    const role = (depth) => ({ tables: new Map([["account", { Read: depth }]]) });
    assert.strictEqual(sec.bestDepth([role("Basic"), role("Deep"), role("Local")], "account", "Read"), "Deep");
    assert.strictEqual(sec.bestDepth([role("Basic")], "contact", "Read"), undefined);
  });
  await test("security: access explanations for each Read level", async () => {
    const tables = [{ logicalName: "account", schemaName: "Account", entitySetName: "accounts", displayName: "Account" }];
    const fakeDv = (depth, rights, sameBu) => ({
      getJson: async (url) => {
        if (url.includes("RetrievePrincipalAccess")) return { AccessRights: rights };
        if (url.includes("?$select=_ownerid_value")) return { _ownerid_value: "owner-1", _owningbusinessunit_value: "bu-1" };
        if (url.includes("teammembership")) return { value: [] };
        if (url.startsWith("systemusers(")) return { _businessunitid_value: sameBu ? "bu-1" : "bu-2", systemuserroles_association: [{ roleid: "r", name: "Role" }] };
        if (url.includes("RetrieveRolePrivilegesRole")) return { RolePrivileges: depth ? [{ PrivilegeName: "prvReadAccount", Depth: depth }] : [] };
        throw new Error("unexpected " + url);
      },
    });
    const explain = (depth, rights, sameBu) => sec.explainAccess(fakeDv(depth, rights, sameBu), "user-1", tables[0], "rec", tables);
    let e = await explain(undefined, "None", true);
    assert.deepStrictEqual([e.canRead, e.readDepth], [false, undefined]);
    assert.match(e.reasons[0], /None of their security roles .* give Read on Account at all/);
    e = await explain("Global", "ReadAccess, WriteAccess", false);
    assert.deepStrictEqual([e.canRead, e.rights], [true, ["ReadAccess", "WriteAccess"]]);
    e = await explain("Local", "None", false);
    assert.match(e.reasons.join(" "), /different one[\s\S]*To give them access/);
    e = await explain("Basic", "ReadAccess", false);
    assert.match(e.reasons.join(" "), /been shared with them/, "Basic, not the owner, yet can read: it's shared");
  });

  // ---------- solution checker and zip ----------
  const zip = out("core/zip.js");
  const checker = out("core/checker.js");
  await test("zip: stored entries round-trip; deflated entries are inflated", () => {
    const z = zip.writeZip([{ name: "a/x.txt", data: Buffer.from("hello") }, { name: "b.bin", data: Buffer.from([0, 1, 2]) }]);
    assert.deepStrictEqual(zip.readZip(z).map((e) => [e.name, e.data.toString("hex")]), [["a/x.txt", "68656c6c6f"], ["b.bin", "000102"]]);
    assert.throws(() => zip.readZip(Buffer.from("not a zip")), /Not a zip file/);
  });
  await test("checker: SARIF in a zip or loose, BOM, rule details, missing fields", () => {
    const dir = tmp();
    const sarif = { runs: [{ tool: { driver: { rules: [{ id: "r1", shortDescription: { text: "Rule one" }, helpUri: "https://x" }] } }, results: [
      { ruleId: "r1", level: "error", message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri: "/WebResources/a.js" }, region: { startLine: 3 } } }] },
      { ruleId: "r2" },
    ] }] };
    fs.writeFileSync(path.join(dir, "out.zip"), zip.writeZip([{ name: "x.sarif", data: Buffer.from("\uFEFF" + JSON.stringify(sarif)) }]));
    assert.deepStrictEqual(checker.readCheckerOutput(dir), [
      { rule: "r1", description: "Rule one", level: "error", message: "m", artifact: "WebResources/a.js", line: 3, helpUri: "https://x" },
      { rule: "r2", description: "r2", level: "warning", message: "", artifact: undefined, line: undefined, helpUri: undefined },
    ]);
    assert.strictEqual(checker.readCheckerOutput(path.join(dir, "missing")), undefined);
  });

  // ---------- TypeScript ----------
  const tsmod = out("commands/typescript.js");
  await test("typescript: tsconfig with comments and trailing commas; outDir, rootDir, outFile", () => {
    const dir = tmp();
    const cfg = path.join(dir, "tsconfig.json");
    fs.writeFileSync(cfg, '{\n // comment\n "$schema": "https://json.schemastore.org/tsconfig",\n "compilerOptions": { "outDir": "../out", /* c */ "rootDir": "src", },\n}');
    assert.strictEqual(tsmod.outputFor(cfg, path.join(dir, "src", "a", "b.ts")), path.join(path.dirname(dir), "out", "a", "b.js"));
    fs.writeFileSync(cfg, '{ "compilerOptions": { "outFile": "bundle.js" } }');
    assert.strictEqual(tsmod.outputFor(cfg, path.join(dir, "x.ts")), path.join(dir, "bundle.js"));
    fs.writeFileSync(cfg, "{}");
    assert.strictEqual(tsmod.outputFor(cfg, path.join(dir, "x.ts")), path.join(dir, "x.js"));
    fs.mkdirSync(path.join(dir, "deep", "er"), { recursive: true });
    assert.strictEqual(tsmod.tsconfigFor(path.join(dir, "deep", "er", "y.ts"), dir), cfg);
    assert.strictEqual(tsmod.tsconfigFor(path.join(os.tmpdir(), "elsewhere.ts"), dir), undefined);
  });

  // ---------- pac ----------
  const pac = out("core/pac.js");
  await test("pac: the account on a profile, and profile names per environment", () => {
    const list = "Index Active Kind Name User\n[1] * UNIVERSAL acme nathan@a.com Public\n[2]   UNIVERSAL acme2 other@b.com Public\n[3]   UNIVERSAL spn  App Id: x";
    assert.strictEqual(pac.accountFromAuthList(list, "acme"), "nathan@a.com");
    assert.strictEqual(pac.accountFromAuthList(list, "ACME2"), "other@b.com");
    assert.strictEqual(pac.accountFromAuthList(list, "spn"), undefined, "service principals have no account");
    assert.strictEqual(pac.accountFromAuthList(list, "nope"), undefined);
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({ environments: [{ name: "UAT-2", org: "a.crm.dynamics.com" }] }));
    assert.strictEqual(pac.profileName(clients.readClient(dir)), `${path.basename(dir).replace(/[^a-zA-Z0-9]/g, "")}UAT2`.slice(0, 30));
  });

  // ---------- query history ----------
  const history = out("core/history.js");
  await test("history: newest first, duplicates move up, 30 per client, survives a corrupt file", () => {
    const file = path.join(tmp(), "h.json");
    const h = new history.QueryHistory(file);
    for (let i = 0; i < 35; i++) h.add("c", { sql: `SELECT ${i} FROM a`, when: "", environment: "", rows: i });
    h.add("c", { sql: "  SELECT 10 FROM a  ", when: "", environment: "DEV", rows: 1 });
    const list = h.list("c");
    assert.strictEqual(list.length, 30);
    assert.deepStrictEqual([list[0].sql, list[0].environment], ["SELECT 10 FROM a", "DEV"]);
    assert.strictEqual(list.filter((e) => e.sql === "SELECT 10 FROM a").length, 1);
    assert.deepStrictEqual(h.list("other"), []);
    fs.writeFileSync(file, "{oops");
    assert.deepStrictEqual(h.list("c"), []);
    h.add("c", { sql: "SELECT 1 FROM a", when: "", environment: "", rows: 0 });
    assert.strictEqual(h.list("c").length, 1);
  });

  // ---------- plug-in classes ----------
  const pluginCode = `namespace Acme {
  public class LeadPlugin : PluginBase {
    protected override void ExecuteDataversePlugin(ILocalPluginContext localContext) {
      var context = localContext.PluginExecutionContext;
      var target = context.InputParameters["Target"] as Entity;
      if (target.Attributes.Contains("emailaddress1")) { }
      var oldName = context.PreEntityImages["Pre"].GetAttributeValue<string>("fullname");
      var oldPhone = context.PreEntityImages["Pre"]["telephone1"];
      var first = ((Entity)context.InputParameters["Target"]).GetAttributeValue<string>("firstname");
      target.TryGetAttributeValue<string>("lastname", out var last);
      target["description"] = "x";
      if (target["companyname"] == null) { }
      var upd = new Entity("account", Guid.Empty);
      upd.Attributes["name"] = "n";
      upd.Attributes.Add("fax", "1");
    }
  }
  public class Other : IPlugin { public void Execute(IServiceProvider s) { var t = (Entity)ctx.InputParameters["Target"]; t["x"] = 1; } }
}`;
  await test("plug-ins: reads and writes through variables, chains, images, guarded reads", () => {
    const a = ca.analyzePluginClass(pluginCode, "LeadPlugin");
    const reads = Object.fromEntries(a.reads.map((r) => [r.column, `${r.source}${r.guarded ? " (guarded)" : ""}`]));
    assert.deepStrictEqual(reads, {
      emailaddress1: "Target (guarded)", lastname: "Target (guarded)", companyname: "Target", firstname: "Target",
      fullname: "PreImage:Pre", telephone1: "PreImage:Pre",
    });
    assert.deepStrictEqual(a.writes.map((w) => `${w.column}<${w.source}`), ["description<Target", "name<other", "fax<other"]);
    assert.deepStrictEqual(a.otherTables, [{ table: "account", how: "creates or updates", line: 12 }]);
    assert.deepStrictEqual(ca.analyzePluginClass(pluginCode, "Other").writes.map((w) => w.column), ["x"], "only the named class");
    assert.strictEqual(ca.analyzePluginClass(pluginCode, "Missing"), undefined);
    assert.strictEqual(ca.csMethodAt(pluginCode, 5), "ExecuteDataversePlugin");
  });
  await test("plug-ins: warnings skip guarded reads and columns the image includes", () => {
    const a = ca.analyzePluginClass(pluginCode, "LeadPlugin");
    const w = ca.pluginWarnings(a, { message: "Update", filtering: ["firstname"], images: [{ alias: "Pre", kind: "Pre", attributes: ["fullname"] }] });
    assert.deepStrictEqual(w, [
      'telephone1 is read from the "Pre" image (line 8), but that image only includes fullname.',
      "On Update, Target only contains the columns that changed. companyname is read from Target but not in the step's filtering columns, so the value may be missing. Read it from an image instead, or check Contains first.",
    ]);
    assert.deepStrictEqual(ca.pluginWarnings(a, { message: "Create", filtering: [], images: [{ alias: "Pre", kind: "Pre", attributes: [] }] }), [], "Create: Target has every column; an image with all columns has everything");
    assert.match(ca.pluginWarnings(a, { message: "Update", filtering: [], images: [] }).join("\n"), /pre-image "Pre", but this step has no pre-image[\s\S]*companyname, firstname are read from Target but can each be absent/);
  });

  // ---------- comparing environments ----------
  const compare = out("core/compare.js");
  const side = (label, o) => ({
    label,
    service: {
      solutionTables: async () => o.tables,
      columns: async (t) => o.columns[t] ?? [],
      forms: async (t) => o.forms[t] ?? [],
    },
    dv: {
      getAll: async (url) => {
        if (url.startsWith("solutions?")) return o.version ? [{ version: o.version }] : [];
        if (url.startsWith("sdkmessageprocessingsteps")) return o.steps;
        if (url.startsWith("environmentvariabledefinitions")) return o.vars;
        if (url.startsWith("solutions?$select=solutionid")) return [{ solutionid: "s" }];
        return [];
      },
      getJson: async () => ({ value: [] }),
      findWebResource: async (name) => (o.wr[name] !== undefined ? { name, content: Buffer.from(o.wr[name]).toString("base64") } : undefined),
    },
  });
  await test("compare: tables, columns, forms, steps, variables; secrets never compared", async () => {
    const col = (n, extra = {}) => ({ logicalName: n, displayName: n, type: "String", requiredLevel: "None", ...extra });
    const form = (events) => ({ name: "Main", type: "Main", tabs: [], header: [], events, libraries: [] });
    const step = (name, enabled, stage = "Post-operation") => ({ sdkmessageprocessingstepid: name, name, stage: stage === "Post-operation" ? 40 : 20, mode: 0, statecode: enabled ? 0 : 1, rank: 1, filteringattributes: null });
    const v = (schemaname, type, value) => ({ environmentvariabledefinitionid: schemaname, schemaname, displayname: schemaname, type, defaultvalue: null, environmentvariabledefinition_environmentvariablevalue: value === undefined ? [] : [{ environmentvariablevalueid: "x", value }] });
    const a = side("DEV", {
      version: "1.0.0.3", tables: ["account", "lead"],
      columns: { account: [col("name"), col("fax", { type: "String", maxLength: 50 }), col("only_dev"), col("namelookup", { attributeOf: "x" })] },
      forms: { account: [form([{ name: "onload", handlers: [] }])] },
      steps: [step("S1", true), step("S2", true)], vars: [v("acme_A", 100000000, "1"), v("acme_Secret", 100000005, "x")], wr: {},
    });
    const b = side("TEST", {
      version: undefined, tables: ["account"],
      columns: { account: [col("name", { requiredLevel: "ApplicationRequired" }), col("fax", { maxLength: 100 })] },
      forms: { account: [form([])] },
      steps: [step("S1", false), step("S3", true)], vars: [v("acme_A", 100000000, "2"), v("acme_Secret", 100000005, "y")], wr: {},
    });
    const r = await compare.compareEnvironments(a, b, "Core");
    const d = r.differences.map((x) => `${x.kind}|${x.name}|${x.status}|${x.detail ?? ""}`);
    assert.deepStrictEqual(r.versions, { a: "1.0.0.3", b: undefined });
    assert.deepStrictEqual(d, [
      "Column|account.name|differs|required None vs ApplicationRequired",
      "Column|account.fax|differs|max length 50 vs 100",
      "Column|account.only_dev|only-a|",
      "Form|account: Main (Main)|differs|event handlers differ",
      "Table|lead|only-a|",
      "Plug-in step|S1|differs|on vs off",
      "Plug-in step|S2|only-a|",
      "Plug-in step|S3|only-b|",
      "Environment variable|acme_A|differs|\"1\" vs \"2\"",
    ]);
    const md = compare.comparisonMarkdown(r);
    assert.match(md, /Solution version: \*\*1\.0\.0\.3\*\* in DEV, \*\*not installed\*\* in TEST\./);
    assert.match(md, /\*\*9 differences\.\*\*/);
  });

  await test("compare: a side that fails is reported as not compared, never as differences", async () => {
    const ok = side("DEV", { version: "1", tables: ["account"], columns: { account: [{ logicalName: "name", type: "String" }] }, forms: {}, steps: [], vars: [], wr: {} });
    const broken = side("TEST", { version: "1", tables: [], columns: {}, forms: {}, steps: [], vars: [], wr: {} });
    broken.service.solutionTables = async () => { throw new Error("403 Forbidden"); };
    broken.dv.getAll = async (url) => {
      if (url.startsWith("solutions?")) return [{ version: "1" }];
      throw new Error("403 Forbidden");
    };
    const r = await compare.compareEnvironments(ok, broken, "Core");
    assert.deepStrictEqual(r.differences, [], "nothing invented");
    assert.deepStrictEqual(r.skipped.map((x) => x.part), ["Tables, columns, and forms", "Web resources", "Plug-in steps", "Environment variables"]);
    assert.match(r.skipped[0].reason, /^TEST: 403 Forbidden$/);
    const md = compare.comparisonMarkdown(r);
    assert.match(md, /\*\*No differences in what could be compared\.\*\*/);
    assert.match(md, /## Not compared[\s\S]*- \*\*Plug-in steps\*\*: TEST: 403 Forbidden/);

    const down = side("TEST", { tables: [], columns: {}, forms: {}, steps: [], vars: [], wr: {} });
    down.dv.getAll = async () => { throw new Error("Couldn't reach acme-test.crm.dynamics.com"); };
    await assert.rejects(compare.compareEnvironments(ok, down, "Core"), /Couldn't read TEST: Couldn't reach acme-test/);
  });

  // ---------- CSV import mapping ----------
  const csvImport = out("commands/csvImport.js");
  await test("csv import: headers by logical, schema, or display name; the ID column means update", () => {
    const table = { logicalName: "account", primaryId: "accountid" };
    const cols = [{ logicalName: "name", schemaName: "Name", displayName: "Account Name" }, { logicalName: "fax", schemaName: "Fax", displayName: "Fax" }, { logicalName: "nameyomi", displayName: "Yomi", attributeOf: "name" }];
    const plan = csvImport.planCsv(table, cols, [["Account Name", "FAX", "AccountId", "Yomi", "junk"], ["A", "1", "", "", ""]]);
    assert.deepStrictEqual(plan.mapping.map((c) => c?.logicalName), ["name", "fax", undefined, undefined, undefined]);
    assert.strictEqual(plan.idIndex, 2);
    assert.deepStrictEqual(plan.ignored, ["Yomi", "junk"], "derived columns like *yomi aren't writable");
  });

  // ---------- lookups ----------
  await test("values: lookups bind by navigation property; customer lookups need a table; NULL clears", async () => {
    const ctx = {
      dv: { getJson: async (url) => ({ value: url.includes("'parentcustomerid'") ? [{ ReferencingEntityNavigationPropertyName: "parentcustomerid_account", ReferencedEntity: "account" }, { ReferencingEntityNavigationPropertyName: "parentcustomerid_contact", ReferencedEntity: "contact" }] : [{ ReferencingEntityNavigationPropertyName: "ParentAccountId", ReferencedEntity: "account" }] }) },
      entitySetOf: async (t) => `${t}s`,
    };
    const table = { logicalName: "contact" };
    const cols = [{ logicalName: "parentcustomerid", type: "Customer" }, { logicalName: "cr_account", type: "Lookup" }, { logicalName: "fax", type: "String" }];
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    const p = await write.prepareValues(table, cols, [{ column: "parentcustomerid", value: `Contact:${id.toUpperCase()}` }, { column: "cr_account", value: id }, { column: "FAX", value: "1" }], ctx, new write.LookupResolver(ctx));
    assert.deepStrictEqual(p.body, { "parentcustomerid_contact@odata.bind": `/contacts(${id.toUpperCase()})`, "ParentAccountId@odata.bind": `/accounts(${id})`, fax: "1" });
    const cleared = await write.prepareValues(table, cols, [{ column: "parentcustomerid", value: null }], ctx, new write.LookupResolver(ctx));
    assert.deepStrictEqual(cleared.clears, ["parentcustomerid_account", "parentcustomerid_contact"]);
    await assert.rejects(write.prepareValues(table, cols, [{ column: "parentcustomerid", value: id }], ctx, new write.LookupResolver(ctx)), /can point to account or contact; write it as 'account:/);
    await assert.rejects(write.prepareValues(table, cols, [{ column: "parentcustomerid", value: `task:${id}` }], ctx, new write.LookupResolver(ctx)), /can't point to task/);
    await assert.rejects(write.prepareValues(table, cols, [{ column: "nope", value: 1 }], ctx, new write.LookupResolver(ctx)), /contact has no column named nope/);
  });

  // ---------- where functions run ----------
  const refs = out("core/references.js");
  await test("registrations: by library and function, namespaced names, duplicates merged", () => {
    const forms = [
      { name: "Main", type: "Main", events: [{ name: "onload", handlers: [{ functionName: "Acme.Account.onLoad", libraryName: "Acme_/a.js" }] }, { name: "onchange", attribute: "fax", handlers: [{ functionName: "onFax", libraryName: "acme_/a.js" }, { functionName: "onFax", libraryName: "acme_/a.js" }] }] },
      { name: "Quick", type: "Quick Create", events: [{ name: "onsave", handlers: [{ functionName: "onLoad", libraryName: "other.js" }] }] },
    ];
    assert.deepStrictEqual(refs.registrationsOf(forms, "acme_/a.js", "onLoad"), ["Main (Main) OnLoad"]);
    assert.deepStrictEqual(refs.registrationsOf(forms, "acme_/a.js", "onFax"), ["Main (Main) OnChange of fax"]);
    assert.deepStrictEqual(refs.registrationsOf(forms, undefined, "onFax"), []);
  });

  // ---------- live warnings ----------
  const diag = out("ui/diagnostics.js");
  await test("warnings: composite parts and header count; commented code doesn't; handlers checked", () => {
    const cols = ["name", "fax", "address1_composite", "ownerid", "telephone1"].map((n) => ({ logicalName: n }));
    const forms = [{ name: "Main", type: "Main", libraries: [], events: [{ name: "onload", handlers: [{ functionName: "Acme.onLoad", libraryName: "lib.js" }, { functionName: "gone", libraryName: "lib.js" }, { functionName: "elsewhere", libraryName: "other.js" }] }],
      header: [{ id: "header_ownerid", field: "ownerid" }],
      tabs: [{ name: "T", sections: [{ name: "S", controls: [{ id: "name", field: "name" }, { id: "address1_composite_compositionLinkControl_address1_line1", field: "address1_line1" }] }] }] }];
    const text = [
      "var Acme = { onLoad: function (c) {",
      '  c.getFormContext().getControl("address1_composite_compositionLinkControl_address1_line1").setVisible(false);',
      '  c.getFormContext().getControl("header_ownerid").setDisabled(true);',
      '  c.getFormContext().getAttribute("ownerid").getValue();',
      '  // c.getFormContext().getAttribute("ghost").getValue();',
      '  c.getFormContext().ui.tabs.get("T").sections.get("S").setVisible(true);',
      '  c.getFormContext().getAttribute("telephone1").getValue();',
      "} };",
    ].join("\n");
    const problems = diag.findScriptProblems(text, "account", cols, forms, "lib.js");
    assert.deepStrictEqual(problems.map((p) => p.message), [
      "telephone1 isn't on any account form, so getAttribute returns null at runtime. Add it to the form (it can be hidden).",
      "Main (Main) onload calls gone, which isn't defined in this file. That handler fails when the event fires.",
    ]);
    const t1 = problems[0];
    assert.strictEqual(text.slice(t1.start, t1.end), "telephone1", "the squiggle covers just the name");
  });

  // ---------- dependency names ----------
  const deps = out("core/dependencies.js");
  await test("dependencies: names for each component type, merged duplicates, unknown types kept", async () => {
    const tables = [{ logicalName: "account", displayName: "Account", metadataId: "T-ACCOUNT" }];
    const dv = {
      getAll: async (url) => (url.startsWith("RetrieveDependentComponents")
        ? [
            { dependentcomponentobjectid: "F1", dependentcomponenttype: 60 },
            { dependentcomponentobjectid: "f1", dependentcomponenttype: 60 },
            { dependentcomponentobjectid: "C1", dependentcomponenttype: 2, dependentcomponentparentid: "t-account" },
            { dependentcomponentobjectid: "W1", dependentcomponenttype: 61 },
            { dependentcomponentobjectid: "Z", dependentcomponenttype: 12345 },
            { dependentcomponentobjectid: "GONE", dependentcomponenttype: 26 },
          ]
        : [{ requiredcomponentobjectid: "t-account", requiredcomponenttype: 1 }]),
      getJson: async (url) => {
        if (url.startsWith("systemforms(F1)")) return { name: "Main", objecttypecode: "account" };
        if (url.startsWith("EntityDefinitions(T-ACCOUNT)/Attributes(C1)")) return { LogicalName: "fax", DisplayName: { UserLocalizedLabel: { Label: "Fax" } } };
        if (url.startsWith("webresourceset(W1)")) return { name: "acme_/a.js" };
        throw new Error("404");
      },
    };
    const r = await deps.fetchDependencies(dv, "x", 1, tables);
    assert.deepStrictEqual(r.usedBy.map((d) => `${d.typeLabel}: ${d.name}${d.detail ? ` (${d.detail})` : ""}`), [
      "Column: Fax (account.fax)", "Component type 12345: Z", "Form: Main (account)", "View: GONE", "Web resource: acme_/a.js",
    ]);
    assert.deepStrictEqual(r.uses.map((d) => d.name), ["Account"]);
  });

  // ---------- metadata cache ----------
  await test("metadata cache: memory, disk, corrupt files, silent loads don't fail visible ones", async () => {
    const dir = tmp();
    let calls = 0;
    const dvFor = (silent) => ({
      getAll: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        if (silent) throw new Error("Not signed in yet");
        return [{ LogicalName: "account", DisplayName: { UserLocalizedLabel: { Label: "Account" } }, EntitySetName: "accounts", PrimaryIdAttribute: "accountid", PrimaryNameAttribute: "name", MetadataId: "m", SchemaName: "Account", IsCustomEntity: false }];
      },
    });
    const svc = new md.MetadataService(dir, dvFor);
    const silent = svc.tables({ silent: true });
    const visible = svc.tables();
    await assert.rejects(silent, /Not signed in yet/);
    const tables = await visible;
    assert.strictEqual(tables[0].logicalName, "account", "the visible load retried and signed in");
    const before = calls;
    assert.strictEqual((await svc.tables())[0].logicalName, "account");
    assert.strictEqual(calls, before, "served from memory");
    const fresh = new md.MetadataService(dir, dvFor);
    assert.strictEqual((await fresh.tables())[0].logicalName, "account", "served from disk");
    assert.strictEqual(calls, before);
    fs.writeFileSync(path.join(dir, "tables.json"), "{corrupt");
    const again = new md.MetadataService(dir, dvFor);
    assert.strictEqual((await again.tables())[0].logicalName, "account", "a corrupt cache file is refetched");
    assert.ok(calls > before);
  });
  await test("metadata cache: a write failure doesn't lose fetched data", async () => {
    const blocked = path.join(tmp(), "file-not-dir");
    fs.writeFileSync(blocked, "x");
    const svc = new md.MetadataService(blocked, () => ({ getAll: async () => [] }));
    assert.deepStrictEqual(await svc.tables(), []);
  });

  // ---------- Web API client ----------
  const dvMod = out("core/dataverse.js");
  await test("web api: a rejected token is replaced once; throttling waits for Retry-After; network errors are clear", async () => {
    const realFetch = global.fetch;
    const waits = [];
    dvMod.timing.sleep = async (ms) => void waits.push(ms);
    const tokens = [];
    const reply = (status, body = {}, headers = {}) => ({ ok: status < 300, status, headers: { get: (h) => headers[h] ?? null }, json: async () => body });
    try {
      let script = [reply(401), reply(200, { ok: 1 })];
      global.fetch = async () => script.shift();
      const client = new dvMod.DataverseClient("https://a.crm.dynamics.com", async (_org, fresh) => (tokens.push(fresh ? "fresh" : "cached"), "t"));
      assert.deepStrictEqual(await client.getJson("x"), { ok: 1 });
      assert.deepStrictEqual(tokens, ["cached", "fresh"]);

      script = [reply(401, { error: { message: "No access" } }), reply(401, { error: { message: "No access" } })];
      await assert.rejects(client.getJson("x"), /rejected the sign-in \(401\)\. No access/, "only one retry");

      script = [reply(429, {}, { "Retry-After": "7" }), reply(429), reply(200, { done: true })];
      assert.deepStrictEqual(await client.getJson("x"), { done: true });
      assert.deepStrictEqual(waits, [7000, 10000], "Retry-After, then a growing default");

      waits.length = 0;
      script = [reply(429, {}, { "Retry-After": "600" }), reply(429), reply(429), reply(429, { error: { message: "Busy" } })];
      await assert.rejects(client.getJson("x"), /throttling requests \(429\)[\s\S]*Busy/);
      assert.deepStrictEqual(waits, [60000, 10000, 15000], "waits are capped");

      global.fetch = async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; };
      await assert.rejects(client.getJson("x"), /Couldn't reach a\.crm\.dynamics\.com \(ENOTFOUND\)\. Check the org URL/);

      global.fetch = async () => reply(404, { error: { message: "Not there" } });
      await assert.rejects(client.getJson("accounts(1)?$select=name"), /Dataverse returned 404 for GET accounts\(1\)\. Not there/);
    } finally {
      global.fetch = realFetch;
    }
  });

  // ---------- sign-in ----------
  await test("sign-in: cached per org and account; a rejected token gets a new session; pinned accounts are enforced", async () => {
    const vscode = require("./mock-vscode");
    const S = vscode.__state;
    const auth = out("ui/auth.js");
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({ org: "a.crm.dynamics.com" }));
    const client = clients.readClient(dir);
    S.sessionOptions = [];
    S.accounts = ["me@a.com", "other@a.com"];
    auth.clearTokenCache();
    await auth.getToken(client);
    await auth.getToken(client);
    assert.strictEqual(S.sessionOptions.length, 1, "second call is cached");
    await auth.getToken(client, { fresh: true });
    assert.strictEqual(S.sessionOptions.length, 2, "a rejected token isn't reused");
    assert.deepStrictEqual(auth.accountInUse(client), { account: "nathan@acme.com", pinned: false });

    client.config.account = "other@a.com";
    await auth.getToken(client);
    assert.strictEqual(S.sessionOptions[S.sessionOptions.length - 1].account.label, "other@a.com", "the pinned account is asked for by name");
    assert.deepStrictEqual(auth.accountInUse(client), { account: "other@a.com", pinned: true });

    client.config.account = "missing@a.com";
    await assert.rejects(auth.getToken(client, { silent: true }), /Not signed in as missing@a\.com yet/, "silent never prompts");
    S.newSignInAccount = "someone@else.com";
    await assert.rejects(auth.getToken(client), /Signed in as someone@else\.com, but .*config\.json says to use missing@a\.com/);
    delete S.newSignInAccount;

    const dataverse = auth.dataverseFor(client);
    assert.strictEqual(dataverse.orgUrl, "https://a.crm.dynamics.com");
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({}));
    assert.throws(() => auth.dataverseFor(clients.readClient(dir)), /Set "org" in .*config\.json first/);
    auth.clearTokenCache();
  });

  // ---------- Custom APIs ----------
  const capi = out("core/customapi.js");
  await test("custom apis: validation catches what Dataverse would reject", () => {
    assert.deepStrictEqual(capi.validateDef({ uniquename: "acme_Ok", requestParameters: [{ uniquename: "A", type: "String" }] }), []);
    const problems = capi.validateDef({
      uniquename: "NoPrefix", binding: "entity", allowedStepType: "maybe",
      requestParameters: [{ uniquename: "A", type: "Text" }, { uniquename: "A", type: "String" }, { uniquename: "bad name", type: "String" }],
    });
    assert.deepStrictEqual(problems, [
      '"uniquename" needs a publisher prefix, like acme_CalculateDiscount.',
      "A bound Custom API needs \"boundEntity\".",
      '"allowedStepType" is none, async, or sync.',
      "request parameter A: \"type\" must be one of Boolean, DateTime, Decimal, Entity, EntityCollection, EntityReference, Float, Integer, Money, Picklist, String, StringArray, Guid.",
      'A request parameter needs a "uniquename" of letters, digits, and underscores.',
      "A appears twice.",
    ]);
  });
  await test("custom apis: TypeScript client for a bound function with entity references", () => {
    const ts = capi.typescriptClient({
      uniquename: "acme_GetScore", binding: "entity", boundEntity: "account", isFunction: true,
      requestParameters: [{ uniquename: "Owner", type: "EntityReference", entity: "systemuser" }, { uniquename: "Tags", type: "StringArray", optional: true }],
      responseProperties: [{ uniquename: "Score", type: "Integer" }],
    });
    assert.match(ts, /export async function getScore\(target: \{ entityType: string; id: string \}, request: GetScoreRequest\)/);
    assert.match(ts, /boundParameter: "entity",/);
    assert.match(ts, /entity: \{ typeName: "mscrm\.account", structuralProperty: 5 \},/);
    assert.match(ts, /Owner: \{ typeName: "mscrm\.systemuser", structuralProperty: 5 \},/);
    assert.match(ts, /Tags: \{ typeName: "Collection\(Edm\.String\)", structuralProperty: 4 \},/);
    assert.match(ts, /operationType: 1,/);
    const none = capi.typescriptClient({ uniquename: "acme_Ping" });
    assert.match(none, /export async function ping\(request: PingRequest = \{\}\): Promise<PingResponse>/);
    assert.match(none, /return \{\} as PingResponse;/);
  });
  await test("custom apis: C# handler reads nullable values and reference types correctly", () => {
    const cs = capi.csharpHandler({ uniquename: "acme_X", binding: "entity", boundEntity: "account", requestParameters: [{ uniquename: "When", type: "DateTime" }, { uniquename: "Choice", type: "Picklist" }] }, "Acme.Plugins", "XHandler");
    assert.match(cs, /namespace Acme\.Plugins[\s\S]*public class XHandler : IPlugin/);
    assert.match(cs, /var target = \(EntityReference\)context\.InputParameters\["Target"\];/);
    assert.match(cs, /var when = context\.InputParameters\.Contains\("When"\) \? \(DateTime\?\)context\.InputParameters\["When"\] : null;/);
    assert.match(cs, /var choice = context\.InputParameters\.Contains\("Choice"\) \? \(OptionSetValue\)context\.InputParameters\["Choice"\] : null;/);
  });

  // ---------- form handler registration ----------
  const formReg = out("core/formRegistration.js");
  await test("form registration: adds to existing events, creates missing ones, leaves tab events and duplicates alone", () => {
    const base = '<form><tabs><tab name="T"><events><event name="tabstatechange"><Handlers /></event></events></tab></tabs><events><event name="onload" application="false" active="false"><Handlers><Handler functionName="old" libraryName="lib.js" /></Handlers></event><event name="onchange" attribute="fax"><Handlers /></event><event name="onsave" /></events><formLibraries><Library name="lib.js" libraryUniqueId="{2}" /></formLibraries></form>';
    const add = (xml, h) => formReg.addHandler(xml, { passExecutionContext: true, ...h });
    let r = add(base, { library: "lib.js", functionName: "Acme.onLoad", event: "onload" });
    assert.ok(r.changed && !r.already);
    assert.match(r.xml, /<Handler functionName="old" libraryName="lib\.js" \/><Handler functionName="Acme\.onLoad" libraryName="lib\.js"/);
    assert.ok(r.xml.includes('<event name="tabstatechange"><Handlers /></event>'), "the tab's events are untouched");
    assert.strictEqual(add(r.xml, { library: "lib.js", functionName: "Acme.onLoad", event: "onload" }).already, true);
    r = add(base, { library: "new.js", functionName: "onFax", event: "onchange", attribute: "fax", passExecutionContext: false });
    assert.match(r.xml, /<event name="onchange" attribute="fax"><Handlers><Handler functionName="onFax" libraryName="new\.js"[^>]*passExecutionContext="false" \/><\/Handlers><\/event>/);
    assert.match(r.xml, /<Library name="new\.js" libraryUniqueId="\{[0-9a-f-]{36}\}" \/><\/formLibraries>/);
    r = add(base, { library: "lib.js", functionName: "onSave", event: "onsave" });
    assert.ok(!r.xml.includes('<event name="onsave" />'), "a self-closing event gets handlers");
    r = add(base, { library: "lib.js", functionName: "onTel", event: "onchange", attribute: "telephone1" });
    assert.strictEqual((r.xml.match(/<events>/g) ?? []).length, 2, "added to the form's events, not a new element");
    assert.match(add("<form><tabs/></form>", { library: "a&b.js", functionName: "go", event: "onload" }).xml, /^<form><tabs\/><events>.*libraryName="a&amp;b\.js".*<\/events><formLibraries><Library name="a&amp;b\.js"/);
  });

  // ---------- FetchXML in code ----------
  const fic = out("core/fetchInCode.js");
  await test("fetchxml in code: every literal style, + chains, comments skipped, placeholders, round trips", () => {
    const js = 'x = `<fetch top="1"><entity name="a"/></fetch>`; // "<fetch>in a comment</fetch>"\ny = "<fetch><entity name=\\"b\\">" + v + "</entity></fetch>";\nz = "nothing";';
    const found = fic.findFetchLiterals(js, "js");
    assert.deepStrictEqual(found.map((l) => [l.kind, l.concatenated, l.line, fic.placeholders(l)]), [["template", false, 0, []], ["double", true, 1, ["{{v}}"]]]);
    assert.strictEqual(found[1].text, '<fetch><entity name="b">{{v}}</entity></fetch>');
    assert.strictEqual(fic.encodeLiteral(found[1].text, "double", "js"), '`<fetch><entity name="b">${v}</entity></fetch>`');
    const cs = 'var a = @"<fetch><entity name=""x"" /></fetch>";\nvar b = $@"<fetch value=""{id}""/>";\nvar c = string.Format("<fetch v=\'{0}\'/>", 1);';
    const lits = fic.findFetchLiterals(cs, "cs");
    assert.deepStrictEqual(lits.map((l) => [l.kind, l.text, fic.placeholders(l)]), [
      ["verbatim", '<fetch><entity name="x" /></fetch>', []],
      ["interpolated", '<fetch value="{id}"/>', ["{id}"]],
      ["double", "<fetch v='{0}'/>", ["{0}"]],
    ]);
    assert.strictEqual(fic.encodeLiteral('<fetch a="1">{{x}}</fetch>', "verbatim", "cs"), '$@"<fetch a=""1"">{x}</fetch>"', "a + chain becomes an interpolated string");
    assert.strictEqual(fic.fillPlaceholders("a {{x}} b {{x}} ${y}", { "{{x}}": "1", "${y}": "2" }), "a 1 b 1 2");
  });

  // ---------- scaffolding ----------
  const scaffold = out("commands/scaffold.js");
  await test("scaffolding: templates per kind, PluginBase when the project has it, namespaces, packable folders", () => {
    assert.match(scaffold.classTemplate("plugin", "Ns", "P", false), /public class P : IPlugin[\s\S]*TryGetValue\("Target"/);
    assert.match(scaffold.classTemplate("plugin", "Ns", "P", true), /public class P : PluginBase[\s\S]*base\(typeof\(P\)\)/);
    assert.match(scaffold.classTemplate("customapi", "Ns", "Q", false), /OutputParameters/);
    assert.match(scaffold.classTemplate("workflow", "Ns", "W", true), /: CodeActivity/, "workflow activities never use PluginBase");
    const dir = tmp();
    const proj = path.join(dir, "A.csproj");
    fs.writeFileSync(proj, "<Project><PropertyGroup><AssemblyName>Acme.Asm</AssemblyName></PropertyGroup></Project>");
    assert.strictEqual(scaffold.projectNamespace(proj), "Acme.Asm");
    fs.writeFileSync(proj, "<Project><PropertyGroup><RootNamespace>Acme.Root</RootNamespace><AssemblyName>X</AssemblyName></PropertyGroup></Project>");
    assert.strictEqual(scaffold.projectNamespace(proj), "Acme.Root");
    fs.mkdirSync(path.join(dir, "Sol", "src", "Other"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Sol", "src", "Other", "Solution.xml"), "<x/>");
    assert.strictEqual(scaffold.packableFolder(path.join(dir, "Sol")), path.join(dir, "Sol", "src"));
    assert.strictEqual(scaffold.packableFolder(path.join(dir, "Nope")), undefined);
  });

  // ---------- pac helpers and app registrations ----------
  await test("pac: secrets masked in logs; app registrations get their own profile; sites parsed", () => {
    assert.strictEqual(pac.loggedArgs(["auth", "create", "--clientSecret", "s", "--password", "p", "--tenant", "t"]), "auth create --clientSecret ******** --password ******** --tenant t");
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({ environments: [{ name: "PROD", org: "p.crm.dynamics.com", appId: "abcd1234-0000-0000-0000-000000000000" }] }));
    const c = clients.readClient(dir);
    assert.strictEqual(c.config.appId, "abcd1234-0000-0000-0000-000000000000", "app registrations can be per environment");
    assert.ok(pac.profileName(c).endsWith("PRODappabcd") && pac.profileName(c).length <= 30);
    assert.deepStrictEqual(pac.parsePagesList("Index Website Id Friendly Name\n[1] AAAA1111-2222-3333-4444-555555555555 Contoso Portal\n\n"), [{ id: "aaaa1111-2222-3333-4444-555555555555", name: "Contoso Portal" }]);
  });

  // ---------- the extension manifest ----------
  await test("manifest: every menu, keybinding, view, icon, and context key reference resolves", () => {
    const pkg = require("../package.json");
    const c = pkg.contributes;
    const cmds = new Set(c.commands.map((x) => x.command));
    const views = new Set(Object.values(c.views).flat().map((v) => v.id));
    const submenus = new Set((c.submenus ?? []).map((x) => x.id));
    const problems = [];
    for (const [menu, items] of Object.entries(c.menus)) {
      if (!menu.includes("/") && menu !== "commandPalette" && !submenus.has(menu)) problems.push(`menu ${menu} isn't a submenu`);
      for (const it of items) {
        if (it.command && !cmds.has(it.command)) problems.push(`${menu}: unknown command ${it.command}`);
        if (it.submenu && !submenus.has(it.submenu)) problems.push(`${menu}: unknown submenu ${it.submenu}`);
        for (const m of (it.when ?? "").matchAll(/view == ([\w.]+)/g)) if (!views.has(m[1])) problems.push(`${menu}: unknown view ${m[1]}`);
        for (const m of (it.when ?? "").matchAll(/webviewId == '([\w.]+)'/g)) if (!views.has(m[1])) problems.push(`${menu}: unknown webview ${m[1]}`);
        if (it.group && !/^[\w.-]+(@\d+)?$/.test(it.group)) problems.push(`${menu}: group ${it.group}`);
      }
    }
    for (const k of c.keybindings ?? []) if (!cmds.has(k.command)) problems.push(`keybinding ${k.command}`);
    const dupes = c.commands.map((x) => x.command).filter((x, i, a) => a.indexOf(x) !== i);
    if (dupes.length) problems.push(`duplicate commands ${dupes}`);
    for (const k of Object.keys(c.configuration.properties)) if (!k.startsWith("lantern.")) problems.push(`setting ${k}`);
    const root = path.join(__dirname, "..");
    for (const f of [pkg.icon, ...[...c.viewsContainers.activitybar, ...(c.viewsContainers.panel ?? [])].map((v) => v.icon), ...(c.jsonValidation ?? []).map((j) => j.url), ...(c.snippets ?? []).map((x) => x.path)]) {
      if (!fs.existsSync(path.join(root, f))) problems.push(`missing file ${f}`);
    }
    // Custom context keys in when-clauses must be set by the code somewhere.
    const source = fs.readdirSync(path.join(root, "src"), { recursive: true }).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(root, "src", f), "utf8")).join("\n");
    const keys = new Set([...JSON.stringify(c.menus).matchAll(/\b(lantern\.(?:active\w+|reviewActive))\b/g)].map((m) => m[1]));
    for (const k of keys) if (!source.includes(`"setContext", "${k}"`)) problems.push(`context key never set: ${k}`);
    // The walkthrough's pages exist and its links run real commands.
    for (const w of c.walkthroughs ?? []) {
      for (const st of w.steps) {
        if (st.media?.markdown && !fs.existsSync(path.join(root, st.media.markdown))) problems.push(`walkthrough page ${st.media.markdown}`);
        for (const m of st.description.matchAll(/\(command:([\w.]+)\)/g)) if (!cmds.has(m[1])) problems.push(`walkthrough link ${m[1]}`);
        for (const e of st.completionEvents ?? []) if (e.startsWith("onCommand:") && !cmds.has(e.slice(10))) problems.push(`walkthrough event ${e}`);
      }
    }
    // Every declared Copilot tool is registered by the code, and the other way round.
    const declared = (c.languageModelTools ?? []).map((t) => t.name).sort();
    const registered = [...source.matchAll(/registerTool\(\s*"([\w]+)"/g)].map((m) => m[1]).sort();
    if (JSON.stringify(declared) !== JSON.stringify(registered)) problems.push(`Copilot tools declared ${declared} but registered ${registered}`);
    assert.deepStrictEqual(problems, []);
  });

  // ---------- plug-in assemblies ----------
  const asm = out("core/assembly.js");
  const sn = out("core/strongname.js");
  const { writeAssembly } = require("./fakes/assembly-writer");
  const key = sn.readKeyFile(sn.generateKeyFile());

  await test("assembly: name, version, token and plug-in classes by the Plugin Registration Tool's rules", () => {
    const dll = writeAssembly({ name: "Acme.Plugins", version: "1.2.3.4", publicKey: key.publicKey, types: [
      { ns: "Acme", name: "PluginBase", abstract: true, interfaces: ["IPlugin"] },
      { ns: "Acme", name: "AccountPlugin", base: "PluginBase" },
      { ns: "Acme", name: "Outer" },
      { ns: "", name: "Inner", nestedIn: "Outer", interfaces: ["IPlugin"] },
      { ns: "Acme", name: "Hidden", public: false, interfaces: ["IPlugin"] },
      { ns: "Acme", name: "IMyPlugin", interface: true, interfaces: ["IPlugin"] },
      { ns: "Acme", name: "ViaInterface", interfaces: ["IMyPlugin"] },
      { ns: "Acme", name: "SetName", base: "CodeActivity" },
      { ns: "Acme.Model", name: "Account", base: "Entity" },
    ] });
    const m = asm.readAssembly(dll);
    assert.strictEqual(m.name, "Acme.Plugins");
    assert.strictEqual(m.version, "1.2.3.4");
    assert.strictEqual(m.culture, "neutral");
    assert.strictEqual(m.publicKeyToken, key.token);
    assert.strictEqual(m.signed, true);
    assert.deepStrictEqual(m.pluginClasses, [
      { typeName: "Acme.AccountPlugin", kind: "plugin" },
      { typeName: "Acme.Outer+Inner", kind: "plugin" },
      { typeName: "Acme.ViaInterface", kind: "plugin" },
      { typeName: "Acme.SetName", kind: "workflow" },
    ], "abstract, internal and interface types are skipped; nested types use +; early-bound entities aren't plug-ins");
    assert.deepStrictEqual(m.references.map((r) => `${r.name}/${r.publicKeyToken}`), ["mscorlib/b77a5c561934e089", "Microsoft.Xrm.Sdk/31bf3856ad364e35", "System.Activities/31bf3856ad364e35"]);
  });
  await test("assembly: unsigned and delay-signed builds, and files that aren't assemblies", () => {
    const unsigned = asm.readAssembly(writeAssembly({ name: "X", types: [{ ns: "X", name: "P", interfaces: ["IPlugin"] }] }));
    assert.strictEqual(unsigned.publicKeyToken, undefined);
    assert.strictEqual(unsigned.signed, false);
    const delay = asm.readAssembly(writeAssembly({ name: "X", publicKey: key.publicKey, signed: false, types: [] }));
    assert.strictEqual(delay.publicKeyToken, key.token);
    assert.strictEqual(delay.signed, false, "a public key with a zeroed signature is delay-signed");
    assert.throws(() => asm.readAssembly(Buffer.from("MZ\0")), asm.NotAnAssemblyError);
    assert.throws(() => asm.readAssembly(Buffer.alloc(4096)), /Not a \.NET assembly: no MZ header/);
  });
  await test("strong-name keys: generated key pairs work, public-only files read, tokens agree", () => {
    const file = sn.generateKeyFile();
    assert.strictEqual(file.length, 596, "the size sn -k makes for a 1024-bit key");
    const k = sn.readKeyFile(file);
    assert.ok(k.hasPrivateKey);
    assert.strictEqual(k.publicKey.subarray(0, 32).toString("hex"), "0024000004800000940000000602000000240000525341310004000001000100");
    const priv = sn.privateKeyFromKeyFile(file);
    const crypto = require("crypto");
    assert.ok(crypto.verify("sha1", Buffer.from("x"), crypto.createPublicKey(priv), crypto.sign("sha1", Buffer.from("x"), priv)));
    const pub = sn.readKeyFile(k.publicKey);
    assert.deepStrictEqual([pub.token, pub.hasPrivateKey], [k.token, false]);
    assert.throws(() => sn.readKeyFile(Buffer.from("not a key")), /Not a strong-name key file/);
  });
  await test("strong-name keys: turning on signing in a project, and finding a key by token", () => {
    const dir = tmp();
    const csproj = path.join(dir, "P.csproj");
    fs.writeFileSync(csproj, '<Project Sdk="Microsoft.NET.Sdk">\r\n  <PropertyGroup>\r\n    <TargetFramework>net462</TargetFramework>\r\n  </PropertyGroup>\r\n</Project>\r\n');
    fs.mkdirSync(path.join(dir, "keys"));
    fs.writeFileSync(path.join(dir, "keys", "a.snk"), sn.generateKeyFile());
    sn.useSigningKey(csproj, path.join(dir, "keys", "a.snk"));
    const text = fs.readFileSync(csproj, "utf8");
    assert.match(text, /<SignAssembly>true<\/SignAssembly>\r\n/);
    assert.match(text, /<AssemblyOriginatorKeyFile>keys\\a\.snk<\/AssemblyOriginatorKeyFile>/);
    assert.strictEqual(sn.signingKeyOf(csproj), path.join(dir, "keys", "a.snk"));
    fs.writeFileSync(path.join(dir, "b.snk"), sn.generateKeyFile());
    sn.useSigningKey(csproj, path.join(dir, "b.snk"));
    assert.strictEqual((fs.readFileSync(csproj, "utf8").match(/AssemblyOriginatorKeyFile>/g) || []).length, 2, "replaced, not added twice");
    const token = sn.readKeyFile(fs.readFileSync(path.join(dir, "keys", "a.snk"))).token;
    assert.deepStrictEqual(sn.findKeysWithToken([dir], token), [path.join(dir, "keys", "a.snk")]);
    fs.writeFileSync(path.join(dir, "bad.snk"), "nope");
    assert.deepStrictEqual(sn.findKeysWithToken([dir], token.toUpperCase()), [path.join(dir, "keys", "a.snk")], "unreadable .snk files are skipped; tokens compare case-insensitively");
    const bare = path.join(dir, "Old.csproj");
    fs.writeFileSync(bare, "<Project>\n</Project>\n");
    sn.useSigningKey(bare, path.join(dir, "b.snk"));
    assert.match(fs.readFileSync(bare, "utf8"), /^<Project>\n  <PropertyGroup>\n    <SignAssembly>true<\/SignAssembly>\n    <AssemblyOriginatorKeyFile>b\.snk<\/AssemblyOriginatorKeyFile>\n  <\/PropertyGroup>\n<\/Project>\n$/, "a project without a PropertyGroup gets one");
  });

  const cs = out("core/csharp.js");
  await test("C#: full type names, nesting, partial classes, bases through the project", () => {
    const a = cs.csharpTypes([
      "using Microsoft.Xrm.Sdk;",
      "// public class Commented : IPlugin {}",
      "namespace Acme.Plugins",
      "{",
      "    [System.Serializable]",
      "    public abstract class PluginBase : IPlugin { public void Execute(System.IServiceProvider s) { var t = \"class Nope : IPlugin {\"; char c = '{'; foreach (var record in new int[0]) { } } }",
      "    public sealed class AccountPostUpdate : PluginBase",
      "    {",
      "        private string x = @\"a \"\" { b\";",
      "        public class Inner : Microsoft.Xrm.Sdk.IPlugin { public void Execute(System.IServiceProvider p) {} }",
      "        class Hidden : IPlugin { public void Execute(System.IServiceProvider p) {} }",
      "    }",
      "    internal class NotExported : IPlugin { public void Execute(System.IServiceProvider p) {} }",
      "    public partial class Split { }",
      "    public class Generic<T> : PluginBase where T : class { }",
      "    public class Wf : System.Activities.CodeActivity { protected override void Execute(System.Activities.CodeActivityContext c) {} }",
      "    #region helpers",
      "    public static class Helpers { }",
      "    #endregion",
      "}",
    ].join("\n"), "a.cs");
    const b = cs.csharpTypes("namespace Acme.Plugins;\npublic partial class Split : IPlugin { public void Execute(System.IServiceProvider s) {} }\npublic record class Rec(int A) : PluginBase;\n", "b.cs");
    const byName = Object.fromEntries([...a, ...b].map((t) => [`${t.file}:${t.fullName}`, t]));
    assert.deepStrictEqual(Object.keys(byName), [
      "a.cs:Acme.Plugins.PluginBase", "a.cs:Acme.Plugins.AccountPostUpdate", "a.cs:Acme.Plugins.AccountPostUpdate+Inner", "a.cs:Acme.Plugins.AccountPostUpdate+Hidden",
      "a.cs:Acme.Plugins.NotExported", "a.cs:Acme.Plugins.Split", "a.cs:Acme.Plugins.Generic`1", "a.cs:Acme.Plugins.Wf", "a.cs:Acme.Plugins.Helpers",
      "b.cs:Acme.Plugins.Split", "b.cs:Acme.Plugins.Rec",
    ]);
    assert.deepStrictEqual([byName["a.cs:Acme.Plugins.AccountPostUpdate"].line, byName["a.cs:Acme.Plugins.AccountPostUpdate"].column], [6, 24]);
    const interpolated = cs.csharpTypes('namespace N {\n  public class Helper { string s = $"{(x ? "{" : "b")}"; string t = $@"{{x}} {a["k"]}"; }\n  public class MyPlugin : IPlugin { }\n}');
    assert.deepStrictEqual(interpolated.map((t) => t.fullName), ["N.Helper", "N.MyPlugin"], "braces inside interpolation holes don't nest the next class");
    const typing = cs.csharpTypes('namespace N {\n  public class A { string s = $"{x\n  }\n  public class B : IPlugin { }\n}');
    assert.deepStrictEqual(typing.map((t) => t.fullName), ["N.A", "N.B"], "a half-typed interpolation doesn't hide the classes after it");
    assert.deepStrictEqual(cs.pluginClassesIn([...a, ...b]).map((p) => `${p.fullName}:${p.pluginKind}`), [
      "Acme.Plugins.AccountPostUpdate:plugin", "Acme.Plugins.AccountPostUpdate+Inner:plugin", "Acme.Plugins.Split:plugin", "Acme.Plugins.Wf:workflow", "Acme.Plugins.Rec:plugin",
    ], "abstract, static, internal, nested-private and open generic classes aren't registrable");
  });
  await test("C#: a project's files include linked files and shared projects; bases resolve through a shared library", () => {
    const dir = tmp();
    const proj = path.join(dir, "Plugins", "P");
    const shared = path.join(dir, "Shared");
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(proj, "P.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="..\\..\\Shared\\Linked.cs" Link="Linked.cs" /></ItemGroup><Import Project="..\\..\\Shared\\Shared.projitems" Label="Shared" /></Project>');
    fs.writeFileSync(path.join(shared, "Shared.projitems"), '<Project><ItemGroup><Compile Include="$(MSBuildThisFileDirectory)FromShared.cs" /></ItemGroup></Project>');
    fs.writeFileSync(path.join(shared, "Linked.cs"), "namespace S { public class LinkedPlugin : Base { } }");
    fs.writeFileSync(path.join(shared, "FromShared.cs"), "namespace S { public class SharedPlugin : Microsoft.Xrm.Sdk.IPlugin { } }");
    fs.mkdirSync(path.join(dir, "Lib"));
    fs.writeFileSync(path.join(dir, "Lib", "Base.cs"), "namespace S { public abstract class Base : IPlugin { } }");
    fs.writeFileSync(path.join(proj, "Own.cs"), "namespace P { public class OwnPlugin : Base { } }");
    const files = cs.projectSourceFiles(path.join(proj, "P.csproj")).map((f) => path.relative(dir, f)).sort();
    assert.deepStrictEqual(files, [path.join("Plugins", "P", "Own.cs"), path.join("Shared", "FromShared.cs"), path.join("Shared", "Linked.cs")]);
    assert.deepStrictEqual(cs.projectPluginClasses(path.join(proj, "P.csproj"), dir).map((c) => c.fullName).sort(), ["P.OwnPlugin", "S.LinkedPlugin", "S.SharedPlugin"]);
    assert.strictEqual(cs.findType("S.SharedPlugin", cs.projectSourceFiles(path.join(proj, "P.csproj"))).file, path.join(shared, "FromShared.cs"));
    assert.strictEqual(cs.findType("OwnPlugin", [path.join(proj, "Own.cs")]).fullName, "P.OwnPlugin", "a bare class name still finds it");
  });

  const reg = out("core/pluginRegistration.js");
  await test("plug-in update plan: what Dataverse would refuse is caught before sending anything", () => {
    const meta = (o = {}) => ({ name: "Acme", version: "1.0.0.5", culture: "neutral", publicKeyToken: "aaaa", signed: true, references: [], unresolvedBases: [],
      pluginClasses: [{ typeName: "Acme.A", kind: "plugin" }, { typeName: "Acme.W", kind: "workflow" }], ...o });
    const target = (o = {}) => ({ pluginassemblyid: "id1", name: "Acme", version: "1.0.0.1", culture: "neutral", publickeytoken: "AAAA", isolationmode: 2, ismanaged: false, _packageid_value: null, ...o });
    const types = [
      { plugintypeid: "t1", typename: "Acme.A", isworkflowactivity: false, workflowactivitygroupname: null },
      { plugintypeid: "t2", typename: "Acme.Gone", isworkflowactivity: false, workflowactivitygroupname: null },
      { plugintypeid: "t3", typename: "Acme.W2", isworkflowactivity: true, workflowactivitygroupname: "Acme (1.0.0.1)" },
    ];
    const plan = reg.planUpdate(meta(), target(), types);
    assert.deepStrictEqual(plan.blockers, [], "token case and build/revision changes are fine");
    assert.deepStrictEqual(plan.newClasses.map((c) => c.typeName), ["Acme.W"]);
    assert.deepStrictEqual(plan.missing.map((t) => t.typename), ["Acme.Gone", "Acme.W2"]);
    assert.deepStrictEqual(plan.groupRenames, [], "only types still in the build get the new group name");
    const kinds = (m, t) => reg.planUpdate(m, t, []).blockers.map((b) => b.kind);
    assert.deepStrictEqual(kinds(meta({ version: "1.1.0.0" }), target()), ["version"]);
    assert.deepStrictEqual(kinds(meta({ publicKeyToken: "bbbb" }), target()), ["token"]);
    assert.deepStrictEqual(kinds(meta({ publicKeyToken: undefined, signed: false }), target()), ["unsigned"]);
    assert.deepStrictEqual(kinds(meta({ culture: "en-US" }), target()), ["culture"]);
    assert.deepStrictEqual(kinds(meta(), target({ ismanaged: true })), ["managed"]);
    assert.deepStrictEqual(kinds(meta(), target({ _packageid_value: "p1" })), ["package"]);
    assert.deepStrictEqual(kinds(meta({ pluginClasses: [] }), undefined), ["empty"]);
    assert.deepStrictEqual(kinds(meta({ publicKeyToken: undefined, pluginClasses: [{ typeName: "Acme.W", kind: "workflow" }] }), undefined), [], "workflow-only assemblies don't have to be signed");
    const workflowOnly = { publicKeyToken: undefined, signed: false, pluginClasses: [{ typeName: "Acme.W", kind: "workflow" }] };
    assert.deepStrictEqual(kinds(meta(workflowOnly), target()), ["token"], "signed registration, unsigned build");
    assert.match(reg.planUpdate(meta(workflowOnly), target(), []).blockers[0].message, /This build isn't signed, but the registered Acme is/);
    assert.deepStrictEqual(kinds(meta(), target({ publickeytoken: null })), ["token"], "unsigned registration, signed build");
    assert.deepStrictEqual(kinds(meta({ signed: false }), target()), ["delaySigned"]);
    const keep = reg.planUpdate(meta({ unresolvedBases: [{ typeName: "Acme.Gone", base: "Shared.PluginBase" }] }), target(), types);
    assert.deepStrictEqual(keep.missing.map((t) => t.typename), ["Acme.W2"], "a class whose base is in another assembly is never offered for removal");
    const renames = reg.planUpdate(meta({ pluginClasses: [{ typeName: "Acme.W2", kind: "workflow" }] }), target(), [types[2]]).groupRenames;
    assert.deepStrictEqual(renames, [{ id: "t3", name: "Acme (1.0.0.5)" }], "workflow groups named after the old version follow the new one");
  });
  await test("plug-in update target: saved ID first, then same major.minor, never a guess between several", () => {
    const m = { name: "Acme", version: "2.0.1.0" };
    const a1 = { pluginassemblyid: "1", version: "1.0.0.0" };
    const a2 = { pluginassemblyid: "2", version: "2.0.0.0" };
    assert.strictEqual(reg.chooseTarget(m, { byName: [a1, a2] }), a2);
    assert.strictEqual(reg.chooseTarget(m, { byId: a1, byName: [a1, a2] }), a2, "a saved ID on another version line doesn't win over a copy that can take the update");
    const k1 = { pluginassemblyid: "k1", version: "2.0.0.0", publickeytoken: "1111", culture: "neutral" };
    const k2 = { pluginassemblyid: "k2", version: "2.0.0.0", publickeytoken: "2222", culture: "neutral" };
    assert.strictEqual(reg.chooseTarget({ ...m, publicKeyToken: "2222", culture: "neutral" }, { byId: k1, byName: [k1, k2] }), k2, "same key beats the saved ID");
    assert.strictEqual(reg.chooseTarget({ name: "Acme", version: "3.0.0.0" }, { byId: a1, byName: [a1, a2] }), a1, "no copy on the line: the saved one, so the version check explains");
    assert.strictEqual(reg.chooseTarget({ name: "Acme", version: "3.0.0.0" }, { byName: [a1, a2] }), undefined);
    assert.strictEqual(reg.chooseTarget({ name: "Acme", version: "3.0.0.0" }, { byName: [a1] }), a1, "one registered copy: it's the target (and the version check explains)");
  });
  await test("plug-in packages: id and version from the .nuspec", () => {
    const { writeZip } = out("core/zip.js");
    const nupkg = writeZip([{ name: "acme_Tools.nuspec", data: Buffer.from("<package><metadata><id>acme_Tools</id><version>1.2.0</version></metadata></package>") }, { name: "lib/net462/Acme.Tools.dll", data: Buffer.from("x") }]);
    assert.deepStrictEqual(reg.readPackage(nupkg), { id: "acme_Tools", version: "1.2.0" });
    assert.throws(() => reg.readPackage(writeZip([{ name: "x.txt", data: Buffer.from("") }])), /no \.nuspec/);
  });

  const dc = out("core/decompile.js");
  await test("decompiled project file: SDK packages, framework references, signing, packages", () => {
    const refs = ["mscorlib", "System", "System.Core", "Microsoft.Xrm.Sdk", "Microsoft.Xrm.Sdk.Workflow", "System.Activities", "System.ServiceModel", "Newtonsoft.Json", "Acme.Common"].map((name) => ({ name, version: "1.0.0.0" }));
    const { xml, unresolved } = dc.pluginCsproj({ assembly: "Acme.Plugins", references: refs, keyFile: path.join("..", "keys", "acme.snk"), libraries: ["Acme.Common.dll"] });
    assert.match(xml, /<AssemblyName>Acme\.Plugins<\/AssemblyName>/);
    assert.match(xml, /<SignAssembly>true<\/SignAssembly>\s*<AssemblyOriginatorKeyFile>\.\.\\keys\\acme\.snk<\/AssemblyOriginatorKeyFile>/);
    assert.match(xml, /Microsoft\.CrmSdk\.CoreAssemblies/);
    assert.match(xml, /Microsoft\.CrmSdk\.Workflow/);
    assert.match(xml, /<Reference Include="System\.Activities" \/>/);
    assert.match(xml, /<Reference Include="System\.ServiceModel" \/>/);
    assert.ok(!/Include="System\.Core"|Include="mscorlib"|Include="Microsoft\.Xrm\.Sdk"/.test(xml), "implicit and SDK-package references aren't repeated");
    assert.match(xml, /<Reference Include="Acme\.Common">\s*<HintPath>lib\\Acme\.Common\.dll<\/HintPath>/);
    assert.deepStrictEqual(unresolved, ["Newtonsoft.Json"]);
    const crafted = dc.pluginCsproj({ assembly: "Acme", references: [{ name: 'X"/><Target Name="Build"><Exec Command="calc"/></Target><!--', version: "1.0" }, { name: "Y --> <Exec/>", version: "1.0" }], libraries: ["bad\"name.dll"] });
    assert.ok(!/<Target[\s>]|<Exec|calc"/.test(crafted.xml.replace(/<!--[\s\S]*?-->/g, "")), "names from the DLL can't add MSBuild targets");
    assert.strictEqual((crafted.xml.match(/-->/g) || []).length, 3, "every comment closes where it should, and no earlier");
    assert.throws(() => dc.pluginCsproj({ assembly: "../x", references: [] }), /can't be used as a project name/);
    const pkg = dc.pluginCsproj({ assembly: "Acme.Tools", references: [], pluginPackage: { id: "acme_Tools", version: "1.2.0" } }).xml;
    assert.match(pkg, /<PackageId>acme_Tools<\/PackageId>[\s\S]*Microsoft\.PowerApps\.MSBuild\.Plugin/);
    assert.ok(!/SignAssembly/.test(pkg));
  });
  await test("decompiled trees compare file by file, ignoring project files and line endings", () => {
    const a = tmp();
    const b = tmp();
    const w = (root, f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    w(a, "X.csproj", "a"); w(b, "X.csproj", "b");
    w(a, "Acme/Same.cs", "x\r\ny"); w(b, "Acme/Same.cs", "x\ny");
    w(a, "Acme/Changed.cs", "1"); w(b, "Acme/Changed.cs", "2");
    w(a, "Acme/Gone.cs", "g"); w(b, "Acme/New.cs", "n");
    assert.deepStrictEqual(dc.compareTrees(a, b).map((d) => `${d.file.split(path.sep).join("/")}:${d.status}`), ["Acme/Changed.cs:changed", "Acme/Gone.cs:onlyDeployed", "Acme/New.cs:onlyLocal"]);
  });

  console.log(`${passed} unit tests passed${failures.length ? `, ${failures.length} failed` : ""}.`);
  if (failures.length) process.exit(1);
})();
