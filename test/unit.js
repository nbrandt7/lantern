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
  await test("sql: OPTION (BYPASS ...) hints on UPDATE, DELETE and INSERT; not on SELECT", () => {
    const u = sql.parseStatement("UPDATE incident SET title = 'x' WHERE statecode = 0 OPTION (BYPASS PLUGINS, BYPASS FLOWS)");
    assert.deepStrictEqual([u.kind, u.where.kind, u.hints], ["update", "cmp", ["bypass plugins", "bypass flows"]]);
    assert.deepStrictEqual(sql.parseStatement("DELETE FROM incident OPTION (BYPASS SYNC PLUGINS, BYPASS ASYNC PLUGINS, BYPASS SYNC PLUGINS);").hints, ["bypass sync plugins", "bypass async plugins"]);
    assert.deepStrictEqual(sql.parseStatement("UPDATE i SET i.title = 'x' FROM incident i WHERE i.statecode = 0 OPTION (BYPASS FLOWS)").hints, ["bypass flows"]);
    assert.deepStrictEqual(sql.parseStatement("INSERT INTO account (name) VALUES ('A') OPTION (BYPASS PLUGINS)").hints, ["bypass plugins"]);
    assert.strictEqual("hints" in sql.parseStatement("DELETE FROM incident"), false, "no hints key without OPTION");
    assert.throws(() => sql.parseStatement("DELETE FROM incident OPTION (NOLOCK)"), /OPTION takes BYPASS PLUGINS, BYPASS SYNC PLUGINS, BYPASS ASYNC PLUGINS or BYPASS FLOWS, not near "NOLOCK"/);
    assert.throws(() => sql.parseStatement("DELETE FROM incident OPTION (BYPASS WORKFLOWS)"), /BYPASS takes PLUGINS, SYNC PLUGINS, ASYNC PLUGINS or FLOWS, not near "WORKFLOWS"/);
    assert.throws(() => sql.parseStatement("SELECT name FROM account OPTION (BYPASS PLUGINS)"), /OPTION \(BYPASS \.\.\.\) goes on UPDATE, DELETE and INSERT; a SELECT runs no plug-ins or flows/);
  });
  await test("sql: UPDATE with alias and DELETE without WHERE", () => {
    const u = sql.parseStatement("UPDATE account a SET a.fax = '1' WHERE a.name = 'x'");
    assert.deepStrictEqual([u.kind, u.alias, u.sets], ["update", "a", [{ column: "fax", value: "1" }]]);
    assert.deepStrictEqual(sql.parseStatement("DELETE account"), { kind: "delete", table: "account", alias: "account", where: undefined });
  });
  await test("sql: SQL Server's UPDATE alias ... FROM table alias and DELETE alias FROM table alias", () => {
    const u = sql.parseStatement("UPDATE i SET i.acme_document = NULL FROM incident i WHERE i.title LIKE 'B%' AND i.acme_document IS NOT NULL");
    assert.deepStrictEqual([u.kind, u.table, u.alias, u.sets, u.where.kind], ["update", "incident", "i", [{ column: "acme_document", value: null }], "and"]);
    assert.deepStrictEqual(sql.parseStatement("UPDATE incident SET title = 'x' FROM incident"), { kind: "update", table: "incident", alias: "incident", sets: [{ column: "title", value: "x" }], where: undefined });
    const d = sql.parseStatement("DELETE i FROM incident AS i WHERE i.statecode = 1");
    assert.deepStrictEqual([d.kind, d.table, d.alias], ["delete", "incident", "i"]);
    assert.throws(() => sql.parseStatement("UPDATE x SET title = 'x' FROM incident i"), /UPDATE x doesn't match FROM incident i\. Write UPDATE i \.\.\. FROM incident i, or leave FROM out/);
    assert.throws(() => sql.parseStatement("UPDATE i SET title = 'x' FROM incident i JOIN account a ON a.accountid = i.customerid"), /UPDATE \.\.\. FROM takes one table/);
    assert.throws(() => sql.parseStatement("UPDATE i SET i.title = 'x' FROM incident WHERE i.statecode = 0"), /UPDATE i doesn't match FROM incident\. Write FROM incident i so i is its alias, or UPDATE incident \.\.\. FROM incident\./);
  });

  await test("sql: EXISTS becomes a link-entity of type any inside the filter", () => {
    const x = flat(tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid AND contact.statecode = 0)").fetchXml);
    assert.match(x, /<entity name="account"><attribute name="name" \/><filter><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any"><filter><condition attribute="statecode" operator="eq" value="0" \/><\/filter><\/link-entity><\/filter><\/entity>/);
  });
  await test("sql: NOT EXISTS with no other conditions is a self-closing not any link", () => {
    const x = flat(tr("SELECT name FROM account a WHERE NOT EXISTS (SELECT * FROM contact c WHERE c.parentcustomerid = a.accountid)").fetchXml);
    assert.match(x, /<filter><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="not any" \/><\/filter>/);
  });
  await test("sql: IN (SELECT col) puts the selected column in from and the outer column in to", () => {
    const x = flat(tr("SELECT name FROM account WHERE accountid IN (SELECT parentcustomerid FROM contact WHERE firstname LIKE 'A%')").fetchXml);
    assert.match(x, /<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any"><filter><condition attribute="firstname" operator="like" value="A%" \/><\/filter><\/link-entity>/);
    const y = flat(tr("SELECT name FROM account a WHERE a.accountid NOT IN (SELECT c.parentcustomerid FROM contact c)").fetchXml);
    assert.match(y, /<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="not any" \/>/);
  });
  await test("sql: subqueries compose with AND, OR and NOT (De Morgan flips any and not any)", () => {
    const x = flat(tr("SELECT name FROM account WHERE statecode = 1 OR EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid)").fetchXml);
    assert.match(x, /<filter type="or"><condition attribute="statecode" operator="eq" value="1" \/><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any" \/><\/filter>/);
    const y = flat(tr("SELECT name FROM account WHERE NOT (statecode = 1 OR accountid IN (SELECT parentcustomerid FROM contact))").fetchXml);
    assert.match(y, /<filter type="and"><condition attribute="statecode" operator="ne" value="1" \/><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="not any" \/><\/filter>/);
    // An outer NOT doesn't reach into the subquery's own WHERE, and NOT NOT cancels out.
    const z = flat(tr("SELECT name FROM account WHERE NOT NOT EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid AND NOT (contact.statecode = 1))").fetchXml);
    assert.match(z, /link-type="any"><filter><condition attribute="statecode" operator="ne" value="1" \/><\/filter><\/link-entity>/);
    const w = flat(tr("SELECT name FROM account WHERE statecode = 0 AND NOT EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid AND (statecode = 0 OR firstname = 'x'))").fetchXml);
    assert.match(w, /<filter type="and"><condition attribute="statecode" operator="eq" value="0" \/><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="not any"><filter type="or"><condition attribute="statecode" operator="eq" value="0" \/><condition attribute="firstname" operator="eq" value="x" \/><\/filter><\/link-entity><\/filter>/);
  });
  await test("sql: subquery correlation on aliases, either way round, bracketed and case-insensitive", () => {
    const x = flat(tr("SELECT a.name FROM account AS a WHERE exists (select 1 from [contact] AS c where A.AccountId = C.ParentCustomerId)").fetchXml);
    assert.match(x, /<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any" \/>/);
    // The outer table's own name qualifies its columns, and a self-referencing subquery needs an alias.
    const y = flat(tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM account child WHERE child.parentaccountid = account.accountid AND child.statecode = 0)").fetchXml);
    assert.match(y, /<link-entity name="account" from="parentaccountid" to="accountid" link-type="any"><filter><condition attribute="statecode" operator="eq" value="0" \/><\/filter><\/link-entity>/);
    // Joined tables keep their entityname conditions beside the subquery.
    const z = flat(tr("SELECT a.name FROM account a JOIN contact c ON c.contactid = a.primarycontactid WHERE c.statecode = 0 AND EXISTS (SELECT 1 FROM task t WHERE t.regardingobjectid = a.accountid)").fetchXml);
    assert.match(z, /<filter type="and"><condition entityname="c" attribute="statecode" operator="eq" value="0" \/><link-entity name="task" from="regardingobjectid" to="accountid" link-type="any" \/><\/filter>/);
  });
  await test("sql: a subquery inside a subquery nests the links", () => {
    const x = flat(tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact c WHERE c.parentcustomerid = account.accountid AND NOT EXISTS (SELECT 1 FROM task t WHERE t.regardingobjectid = c.contactid AND t.statecode = 0))").fetchXml);
    assert.match(x, /<filter><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any"><filter><link-entity name="task" from="regardingobjectid" to="contactid" link-type="not any"><filter><condition attribute="statecode" operator="eq" value="0" \/><\/filter><\/link-entity><\/filter><\/link-entity><\/filter>/);
  });
  await test("sql: JOINs inside a subquery nest inside its link, with their conditions in their own filter", () => {
    const x = flat(tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact c JOIN systemuser u ON u.systemuserid = c.ownerid WHERE c.parentcustomerid = account.accountid AND u.isdisabled = 0 AND c.statecode = 0)").fetchXml);
    assert.match(x, /<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any"><filter><condition attribute="statecode" operator="eq" value="0" \/><\/filter><link-entity name="systemuser" from="systemuserid" to="ownerid" alias="u" link-type="inner"><filter><condition attribute="isdisabled" operator="eq" value="0" \/><\/filter><\/link-entity><\/link-entity>/);
    // IN with a JOIN: the selected column still comes from the subquery's own table.
    const y = flat(tr("SELECT name FROM account WHERE accountid IN (SELECT c.parentcustomerid FROM contact c JOIN systemuser u ON u.systemuserid = c.ownerid WHERE u.isdisabled = 0)").fetchXml);
    assert.match(y, /<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any"><link-entity name="systemuser" from="systemuserid" to="ownerid" alias="u" link-type="inner"><filter><condition attribute="isdisabled" operator="eq" value="0" \/><\/filter><\/link-entity><\/link-entity>/);
  });
  await test("sql: a subquery linked to an INNER JOINed table goes inside that join", () => {
    const x = flat(tr("SELECT a.name FROM account a JOIN contact c ON c.contactid = a.primarycontactid WHERE a.statecode = 0 AND NOT EXISTS (SELECT 1 FROM task t WHERE t.regardingobjectid = c.contactid)").fetchXml);
    assert.match(x, /<entity name="account"><attribute name="name" \/><filter><condition attribute="statecode" operator="eq" value="0" \/><\/filter><link-entity name="contact" from="contactid" to="primarycontactid" alias="c" link-type="inner"><filter><link-entity name="task" from="regardingobjectid" to="contactid" link-type="not any" \/><\/filter><\/link-entity><\/entity>/);
    // The WHERE's other conditions on the joined table stay in the root filter with entityname, as before.
    const y = flat(tr("SELECT a.name FROM account a JOIN contact c ON c.contactid = a.primarycontactid WHERE c.statecode = 0 AND c.contactid IN (SELECT regardingobjectid FROM task)").fetchXml);
    assert.match(y, /<filter><condition entityname="c" attribute="statecode" operator="eq" value="0" \/><\/filter><link-entity name="contact"[^>]*link-type="inner"><filter><link-entity name="task" from="regardingobjectid" to="contactid" link-type="any" \/><\/filter><\/link-entity>/);
  });
  await test("sql: subqueries in UPDATE and DELETE", () => {
    const st = sql.parseStatement("DELETE FROM contact WHERE NOT EXISTS (SELECT 1 FROM account WHERE account.accountid = contact.parentcustomerid)");
    const select = { distinct: false, items: [{ kind: "all" }], from: { table: "contact", alias: "contact" }, joins: [], where: st.where, groupBy: [], orderBy: [] };
    assert.match(flat(sql.translateQuery(select).fetchXml), /<filter><link-entity name="account" from="accountid" to="parentcustomerid" link-type="not any" \/><\/filter>/);
    const u = sql.parseStatement("UPDATE account SET fax = NULL WHERE accountid IN (SELECT parentcustomerid FROM contact WHERE statecode = 1)");
    assert.strictEqual(u.where.kind, "sub");
  });
  await test("sql: clear errors for subqueries FetchXML can't express", () => {
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE statecode = 0)"), /needs a condition linking it to account, like WHERE contact\.<column> = account\.accountid/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE contact.createdon > account.createdon)"), /linked to the outer query with =, not >/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid AND account.statecode = 0)"), /can only filter contact's columns; account\.statecode belongs to the outer query/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid OR contact.statecode = 0)"), /must be joined to the rest with AND, not OR/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE parentcustomerid = accountid)"), /Comparing two columns of contact isn't supported/);
    assert.throws(() => tr("SELECT name FROM account WHERE accountid IN (SELECT parentcustomerid FROM contact WHERE contact.ownerid = account.ownerid)"), /one condition linking it to the outer query; contact\.ownerid = account\.ownerid is a second one/);
    assert.throws(() => tr("SELECT name FROM account WHERE accountid IN (SELECT * FROM contact)"), /IN \(SELECT \.\.\.\) needs exactly one column/);
    assert.throws(() => tr("SELECT name FROM account WHERE accountid IN (SELECT a.accountid FROM contact c)"), /must come from c, not a/);
    assert.throws(() => tr("SELECT name FROM account WHERE revenue = (SELECT MAX(revenue) FROM account)"), /= \(SELECT \.\.\.\) isn't supported\. Use column IN/);
    assert.throws(() => tr("SELECT name, (SELECT COUNT(*) FROM contact) FROM account"), /Subqueries in SELECT aren't supported/);
    assert.throws(() => tr("SELECT name FROM (SELECT name FROM account) x"), /Subqueries in FROM aren't supported/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM account WHERE account.parentaccountid = account.accountid)"), /alias "account" is already used by the outer query/);
    assert.throws(() => tr("SELECT a.name FROM account a WHERE EXISTS (SELECT 1 FROM contact c JOIN task a ON a.regardingobjectid = c.contactid WHERE c.parentcustomerid = a.accountid)"), /alias "a" is already used by the outer query/);
    // Linked to a joined table: INNER JOIN and AND only.
    assert.throws(() => tr("SELECT a.name FROM account a LEFT JOIN contact c ON c.contactid = a.primarycontactid WHERE EXISTS (SELECT 1 FROM task t WHERE t.regardingobjectid = c.contactid)"), /can't be linked to c, a LEFT JOINed table/);
    assert.throws(() => tr("SELECT a.name FROM account a JOIN contact c ON c.contactid = a.primarycontactid WHERE a.statecode = 1 OR EXISTS (SELECT 1 FROM task t WHERE t.regardingobjectid = c.contactid)"), /linked to the joined table c must be combined with the rest of the WHERE using AND, not OR/);
    // Inside a subquery: INNER JOIN only, conditions on the joined table with AND, the link through the subquery's own table, to the query directly around it.
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact c LEFT JOIN systemuser u ON u.systemuserid = c.ownerid WHERE c.parentcustomerid = account.accountid)"), /A subquery supports INNER JOIN only/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact c JOIN systemuser u ON u.systemuserid = c.ownerid WHERE c.parentcustomerid = account.accountid AND (u.isdisabled = 0 OR c.statecode = 1))"), /condition on the joined table u \(u\.isdisabled\) must be combined with the rest of the subquery's WHERE using AND/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact c JOIN task t ON t.regardingobjectid = c.contactid WHERE t.ownerid = account.ownerid)"), /links to the outer query through t, a table it JOINs/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact c WHERE c.parentcustomerid = account.accountid AND EXISTS (SELECT 1 FROM task t WHERE t.regardingobjectid = account.accountid))"), /linked to the query directly around it \(c\), not to account further out/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid ORDER BY createdon)"), /ORDER isn't supported in a subquery/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT COUNT(*) FROM contact WHERE contact.parentcustomerid = account.accountid)"), /COUNT\(\) isn't supported in a subquery/);
    assert.throws(() => tr("SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid"), /Expected "\)" near the end of the query/);
    // Outside a subquery, column = column still gets the old explanation.
    assert.throws(() => tr("SELECT name FROM account WHERE name = fullname"), /Expected a value/);
    assert.throws(() => tr("SELECT name FROM account WHERE name = account.fullname"), /Comparing one column to another isn't supported/);
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

  // ---------- command bar model (Open Command Bar…) ----------
  const rm = out("core/ribbonModel.js");
  const RIBBON_XML = `<RibbonDefinitions><RibbonDefinition><UI><Ribbon><Tabs>
    <Tab Id="Mscrm.Form.account.MainTab" Command="Mscrm.FormTab" Title="$Resources:Ribbon.Form.MainTab" Sequence="10"><Groups>
      <Group Id="Mscrm.Form.account.MainTab.Save" Command="Mscrm.Enabled" Sequence="10" Title="$Resources:Ribbon.Form.MainTab.Save"><Controls Id="Mscrm.Form.account.MainTab.Save.Controls">
        <Button Id="Mscrm.Form.account.Save" Command="Mscrm.SavePrimary" Sequence="10" LabelText="$Resources:Ribbon.Form.MainTab.Save" Image16by16="/_imgs/ribbon/Save_16.png" ModernImage="Save" />
        <Button Id="acme.account.Approve.Button" Command="acme.account.Approve.Command" Sequence="25" LabelText="$LocLabels:acme.account.Approve.Button.LabelText" ToolTipTitle="$LocLabels:acme.account.Approve.Button.ToolTipTitle" TemplateAlias="o1" />
        <SplitButton Id="Mscrm.Form.account.Delete.Split" Command="Mscrm.DeletePrimaryRecord" Sequence="30" LabelText="$Resources:Ribbon.HomepageGrid.Delete"><Menu Id="Mscrm.Form.account.Delete.Menu"><MenuSection Id="Mscrm.Form.account.Delete.Section" Sequence="10" Title="$Resources:Ribbon.Section"><Controls Id="c"><Button Id="Mscrm.Form.account.Delete.Item" Command="Mscrm.DeletePrimaryRecord" LabelText="$Resources:Ribbon.Delete" /></Controls></MenuSection></Menu></SplitButton>
        <FlyoutAnchor Id="Mscrm.Form.account.Flows" Command="Mscrm.Flows" Sequence="40" LabelText="$Resources:Ribbon.Flows" PopulateDynamically="true" PopulateQueryCommand="Mscrm.Flows.Populate" />
      </Controls></Group>
      <Group Id="Mscrm.Form.account.MainTab.Actions" Sequence="20" Title="$Resources:Ribbon.Form.MainTab.Actions"><Controls Id="x" /></Group>
    </Groups></Tab></Tabs></Ribbon></UI>
    <CommandDefinitions>
      <CommandDefinition Id="acme.account.Approve.Command"><EnableRules><EnableRule Id="acme.account.CanApprove" /><EnableRule Id="Mscrm.FormStateExisting" /></EnableRules><DisplayRules><DisplayRule Id="acme.account.ApproverOnly" /></DisplayRules><Actions><JavaScriptFunction FunctionName="Acme.Account.approve" Library="$webresource:acme_/account/ribbon.js"><CrmParameter Value="PrimaryControl" /><StringParameter Value="fast" /></JavaScriptFunction></Actions></CommandDefinition>
      <CommandDefinition Id="Mscrm.SavePrimary"><EnableRules><EnableRule Id="Mscrm.CanSavePrimary" /></EnableRules><Actions><JavaScriptFunction FunctionName="Mscrm.RibbonActions.saveForm" Library="/_static/_common/scripts/RibbonActions.js"><CrmParameter Value="PrimaryControl" /></JavaScriptFunction></Actions></CommandDefinition>
      <CommandDefinition Id="Mscrm.Flows"><Actions><Url Address="https://flow.microsoft.com" PassParams="true" /></Actions></CommandDefinition>
    </CommandDefinitions>
    <RuleDefinitions>
      <EnableRules>
        <EnableRule Id="acme.account.CanApprove"><CustomRule FunctionName="Acme.Account.canApprove" Library="$webresource:acme_/account/ribbon.js" Default="false"><CrmParameter Value="PrimaryControl" /></CustomRule><ValueRule Field="statecode" Value="0" /></EnableRule>
        <EnableRule Id="Mscrm.FormStateExisting"><FormStateRule State="Existing" /></EnableRule>
        <EnableRule Id="Mscrm.CanSavePrimary"><FormStateRule State="ReadOnly" InvertResult="true" /><SelectionCountRule Minimum="1" Maximum="1" AppliesTo="SelectedEntity" /></EnableRule>
      </EnableRules>
      <DisplayRules><DisplayRule Id="acme.account.ApproverOnly"><EntityPrivilegeRule EntityName="account" PrivilegeType="Write" PrivilegeDepth="Local" /><OrRule><Or><CrmClientTypeRule Type="Web" /><HideForTabletExperienceRule /></Or><Or><CrmClientTypeRule Type="Outlook" InvertResult="true" /></Or></OrRule></DisplayRule></DisplayRules>
    </RuleDefinitions>
    <LocLabels><LocLabel Id="acme.account.Approve.Button.LabelText"><Titles><Title languagecode="1031" description="Genehmigen" /><Title languagecode="1033" description="Approve &amp; close" /></Titles></LocLabel><LocLabel Id="acme.account.Approve.Button.ToolTipTitle"><Titles><Title languagecode="1031" description="Genehmigt den Datensatz" /></Titles></LocLabel></LocLabels>
  </RibbonDefinition></RibbonDefinitions>`;
  const RIBBON_DIFF = `<RibbonDiffXml>
    <CustomActions>
      <CustomAction Id="acme.account.Approve.CustomAction" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="25"><CommandUIDefinition><Button Id="acme.account.Approve.Button" Command="acme.account.Approve.Command" LabelText="$LocLabels:acme.account.Approve.Button.LabelText" ToolTipTitle="$LocLabels:acme.account.Approve.Button.ToolTipTitle" TemplateAlias="o1" /></CommandUIDefinition></CustomAction>
      <CustomAction Id="acme.account.Reject.CustomAction" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="45"><CommandUIDefinition><Button Id="acme.account.Reject.Button" Command="acme.account.Reject.Command" LabelText="Reject" /></CommandUIDefinition></CustomAction>
      <CustomAction Id="acme.account.Lost.CustomAction" Location="Mscrm.HomepageGrid.account.MainTab.Nope.Controls._children" Sequence="10"><CommandUIDefinition><Button Id="acme.account.Lost.Button" Command="acme.account.Reject.Command" LabelText="Lost" /></CommandUIDefinition></CustomAction>
    </CustomActions>
    <HideCustomActions><HideCustomAction HideActionId="Mscrm.Form.account.Assign" Location="Mscrm.Form.account.MainTab.Actions.Controls._children" /></HideCustomActions>
    <CommandDefinitions>
      <CommandDefinition Id="acme.account.Approve.Command"><EnableRules><EnableRule Id="acme.account.CanApprove" /></EnableRules><Actions><JavaScriptFunction FunctionName="Acme.Account.approve" Library="$webresource:acme_/account/ribbon.js" /></Actions></CommandDefinition>
      <CommandDefinition Id="acme.account.Reject.Command"><Actions><JavaScriptFunction FunctionName="Acme.Account.reject" Library="$webresource:acme_/missing.js" /></Actions></CommandDefinition>
    </CommandDefinitions>
    <RuleDefinitions><EnableRules><EnableRule Id="acme.account.CanApprove"><CustomRule FunctionName="Acme.Account.canApprove" Library="$webresource:acme_/account/ribbon.js" /></EnableRule></EnableRules><DisplayRules /></RuleDefinitions>
    <LocLabels><LocLabel Id="acme.account.Approve.Button.LabelText"><Titles><Title languagecode="1033" description="Approve &amp; close" /><Title languagecode="1031" description="Genehmigen" /></Titles></LocLabel></LocLabels>
  </RibbonDiffXml>`;
  const loaded = () => rm.applyDiff(rm.parseRibbonXml(RIBBON_XML, "account", "Form"), rm.parseRibbonDiff(RIBBON_DIFF));
  const clone = (x) => JSON.parse(JSON.stringify(x));

  await test("command bar model: tabs, groups and controls in sequence order, with menus, labels and commands", () => {
    const m = rm.parseRibbonXml(RIBBON_XML, "account", "Form");
    assert.deepStrictEqual(m.tabs.map((t) => [t.id, t.location, t.label, t.origin, t.groups.map((g) => g.label)]), [["Mscrm.Form.account.MainTab", "Form", "MainTab", "microsoft", ["Save", "Actions"]]]);
    const save = m.tabs[0].groups[0];
    assert.deepStrictEqual(save.controls.map((c) => [c.id, c.kind, c.tag, c.label, c.origin, c.sequence]), [
      ["Mscrm.Form.account.Save", "button", "Button", "Save", "microsoft", 10],
      ["acme.account.Approve.Button", "button", "Button", "Approve & close", "other", 25],
      ["Mscrm.Form.account.Delete.Split", "splitButton", "SplitButton", "Delete", "microsoft", 30],
      ["Mscrm.Form.account.Flows", "flyout", "FlyoutAnchor", "Flows", "microsoft", 40],
    ]);
    assert.strictEqual(save.controls[1].tooltipTitle, "Genehmigt den Datensatz", "a label without English takes the first language");
    assert.deepStrictEqual([save.controls[0].image16, save.controls[0].modernImage, save.controls[0].attrs.Image16by16], ["/_imgs/ribbon/Save_16.png", "Save", "/_imgs/ribbon/Save_16.png"]);
    assert.deepStrictEqual(save.controls[2].children.map((s) => [s.kind, s.label, s.children.map((b) => [b.kind, b.id, b.command])]), [["menuSection", "Section", [["button", "Mscrm.Form.account.Delete.Item", "Mscrm.DeletePrimaryRecord"]]]]);
    assert.strictEqual(save.controls[3].populateQueryCommand, "Mscrm.Flows.Populate");
    const cmd = m.commands["acme.account.Approve.Command"];
    assert.deepStrictEqual([cmd.enableRules, cmd.displayRules, cmd.origin], [["acme.account.CanApprove", "Mscrm.FormStateExisting"], ["acme.account.ApproverOnly"], "other"]);
    assert.deepStrictEqual(cmd.actions.map((a) => [a.kind, a.functionName, a.webResource, a.parameters.map((p) => p.kind + "=" + p.value)]), [["JavaScriptFunction", "Acme.Account.approve", "acme_/account/ribbon.js", ["CrmParameter=PrimaryControl", "StringParameter=fast"]]]);
    assert.strictEqual(m.commands["Mscrm.SavePrimary"].actions[0].webResource, undefined, "a platform script isn't a web resource");
    assert.deepStrictEqual(m.commands["Mscrm.Flows"].actions.map((a) => [a.kind, a.url]), [["Url", "https://flow.microsoft.com"]]);
    assert.strictEqual(rm.parseRibbonXml(RIBBON_XML, "account").tabs[0].location, "Form", "without a location filter, the tab's Id says where it is");
    assert.deepStrictEqual([rm.locationOfId("Mscrm.HomepageGrid.account.MainTab"), rm.locationOfId("Mscrm.SubGrid.account.MainTab"), rm.locationOfId("acme.tab")], ["HomepageGrid", "SubGrid", "Other"]);
    assert.strictEqual(rm.resolveLabel("$Resources:Ribbon.HomepageGrid.MainTab.Management.Assign", {}), "Assign");
  });
  await test("command bar model: rules in words", () => {
    const m = rm.parseRibbonXml(RIBBON_XML, "account", "Form");
    assert.deepStrictEqual(m.enableRules["acme.account.CanApprove"].steps.map((s) => [s.kind, s.text, s.webResource, s.functionName]), [
      ["CustomRule", "Acme.Account.canApprove in acme_/account/ribbon.js returns true (false until it answers).", "acme_/account/ribbon.js", "Acme.Account.canApprove"],
      ["ValueRule", 'statecode is "0".', undefined, undefined],
    ]);
    assert.deepStrictEqual(m.enableRules["Mscrm.CanSavePrimary"].steps.map((s) => s.text), ["The form is not read-only.", "exactly 1 row is selected in the subgrid."]);
    assert.deepStrictEqual(m.displayRules["acme.account.ApproverOnly"].steps.map((s) => s.text), [
      "The user can write account records (at least their business unit's).",
      "Any of: The client is Web and Hidden on tablets; or The client isn't Outlook.",
    ]);
    const words = (xml) => rm.explainRule(rm.parseXml(xml).children[0]);
    assert.strictEqual(words('<FormStateRule State="Create" InvertResult="true" />'), "The form is not a new record.");
    assert.strictEqual(words('<RecordPrivilegeRule PrivilegeType="Delete" AppliesTo="SelectedEntity" />'), "The user can delete this record (the selected row).");
    assert.strictEqual(words('<EntityRule EntityName="contact" AppliesTo="SelectedEntity" Context="SubGridStandard" />'), "The selected rows' table is contact in a sub grid standard.");
    assert.strictEqual(words('<SelectionCountRule Minimum="1" />'), "at least 1 row is selected.");
    assert.strictEqual(words('<ValueRule Field="ownerid" Value="null" InvertResult="true" />'), "ownerid isn't empty.");
    assert.strictEqual(words('<SomethingNewRule Foo="1" InvertResult="true" />'), "SomethingNewRule (Foo=1), inverted.");
    // A step edited on the page is explained from its fields, parameters included.
    assert.strictEqual(rm.explainStep({ kind: "CustomRule", attrs: { Default: "true" }, functionName: "Acme.ok", webResource: "acme_/x.js", parameters: [{ kind: "CrmParameter", value: "PrimaryControl" }], text: "" }), "Acme.ok in acme_/x.js returns true (true until it answers).");
    assert.strictEqual(rm.explainStep({ kind: "FormStateRule", attrs: { State: "Existing", InvertResult: "true" }, parameters: [], text: "" }), "The form is not an existing record.");
  });
  await test("command bar model: the client's RibbonDiffXml marks its controls, commands and rules, adds local-only buttons and lists hidden ones", () => {
    const m = rm.parseRibbonXml(RIBBON_XML, "account", "Form");
    const diff = rm.parseRibbonDiff(RIBBON_DIFF);
    assert.deepStrictEqual(diff.customActions.map((c) => [c.id, c.location, c.sequence, c.element.attrs.Id]), [
      ["acme.account.Approve.CustomAction", "Mscrm.Form.account.MainTab.Save.Controls._children", 25, "acme.account.Approve.Button"],
      ["acme.account.Reject.CustomAction", "Mscrm.Form.account.MainTab.Save.Controls._children", 45, "acme.account.Reject.Button"],
      ["acme.account.Lost.CustomAction", "Mscrm.HomepageGrid.account.MainTab.Nope.Controls._children", 10, "acme.account.Lost.Button"],
    ]);
    assert.deepStrictEqual(diff.locLabels["acme.account.Approve.Button.LabelText"], [{ languagecode: "1033", description: "Approve & close" }, { languagecode: "1031", description: "Genehmigen" }]);
    assert.strictEqual(rm.groupOfLocation("Mscrm.Form.account.MainTab.Save.Controls._children"), "Mscrm.Form.account.MainTab.Save");
    rm.applyDiff(m, diff);
    const save = m.tabs[0].groups[0];
    assert.deepStrictEqual(save.controls.map((c) => [c.id, c.origin, !!c.localOnly]), [
      ["Mscrm.Form.account.Save", "microsoft", false],
      ["acme.account.Approve.Button", "client", false],
      ["Mscrm.Form.account.Delete.Split", "microsoft", false],
      ["Mscrm.Form.account.Flows", "microsoft", false],
      ["acme.account.Reject.Button", "client", true],
    ], "the Reject button is in the diff but not in the environment yet; the Lost button's group doesn't exist, so it's left out");
    assert.strictEqual(save.controls[4].label, "Reject");
    assert.deepStrictEqual([m.commands["acme.account.Approve.Command"].origin, m.commands["acme.account.Reject.Command"].origin, m.commands["Mscrm.SavePrimary"].origin], ["client", "client", "microsoft"]);
    assert.strictEqual(m.commands["acme.account.Approve.Command"].enableRules.length, 1, "the client's own command replaces the environment's: the local file may hold edits not imported yet");
    assert.deepStrictEqual([m.enableRules["acme.account.CanApprove"].origin, m.displayRules["acme.account.ApproverOnly"].origin, m.enableRules["Mscrm.FormStateExisting"].origin], ["client", "other", "microsoft"]);
    assert.deepStrictEqual(m.hidden, [{ id: "Mscrm.Form.account.Assign", location: "Mscrm.Form.account.MainTab.Actions.Controls._children", origin: "client" }]);
    assert.strictEqual(m.customActions.length, 3, "the client's custom actions are kept for writing back");
    assert.strictEqual(rm.applyDiff(m, diff).hidden.length, 1, "applying the same diff twice doesn't repeat the hidden control");
    assert.strictEqual(m.customActions.length, 3);
  });
  await test("command bar model: JavaScript references are checked against the workspace's web resources", () => {
    const m = loaded();
    m.modern.push({ uniqueName: "acme_account_Go", name: "Go", label: "Go", location: 0, type: 0, hidden: false, disabled: false, onClick: { type: 2, functionName: "Acme.Account.go", library: "acme_/account/ribbon.js" }, visibility: { type: 0 }, icon: {} });
    const handlers = out("core/handlers.js");
    const files = { "acme_/account/ribbon.js": { file: "C:/acme/WebResources/acme_/account/ribbon.js", text: "var Acme = Acme || {};\nAcme.Account = {\n  approve: function (primaryControl) {},\n};\n// Acme.Account.canApprove = function () {}\n" } };
    const problems = rm.checkRibbonReferences(m, (wr) => files[wr], (text, fn) => !!handlers.findFunction(text, fn));
    assert.deepStrictEqual(problems.map((p) => [p.kind, p.id, p.index, p.text, p.file && path.basename(p.file)]), [
      ["command", "acme.account.Reject.Command", 0, "acme_/missing.js isn't a web resource in the workspace.", undefined],
      ["enable rule", "acme.account.CanApprove", 0, "Acme.Account.canApprove isn't defined in ribbon.js.", "ribbon.js"],
      ["modern command", "acme_account_Go", 0, "Acme.Account.go isn't defined in ribbon.js.", "ribbon.js"],
    ], "platform scripts (/_static/…) are never checked; a commented-out definition doesn't count");
    assert.deepStrictEqual(rm.problemCounts(problems), { "command:acme.account.Reject.Command": 1, "enable rule:acme.account.CanApprove": 1, "modern command:acme_account_Go": 1 });
    const panel = out("ui/panels/commandBarPanel.js");
    assert.deepStrictEqual(problems.map(panel.problemKey), ["action:acme.account.Reject.Command:0", "rule:enable:acme.account.CanApprove:0", "modern:acme_account_Go"]);
    const draft = { model: m, publish: false, solution: "", writeLocal: true };
    assert.deepStrictEqual(panel.commandBarStatus(draft, clone(m), "acme", problems), { problems: [], summary: "No changes yet · 3 JavaScript warnings", blocked: true }, "warnings don't block; no change means nothing to save");
    const d2 = clone(draft);
    d2.publish = true;
    d2.model.hidden.push({ id: "Mscrm.Form.account.Save", location: "Mscrm.Form.account.MainTab.Save.Controls._children", origin: "client" });
    assert.deepStrictEqual(panel.commandBarStatus(d2, m, "acme", []), { problems: [{ field: "solution", text: "Pick the solution to publish through." }], summary: "1 change · JavaScript references resolve", blocked: false });
  });
  await test("command bar model: the client's layer is written back as RibbonDiffXml and reads back the same", () => {
    const m = loaded();
    const layer = rm.serializeRibbonDiff(m);
    assert.deepStrictEqual(layer.counts, { controls: 3, hidden: 1, commands: 2, rules: 1, labels: 2 });
    const again = rm.parseRibbonDiff(layer.xml);
    assert.deepStrictEqual(again.customActions.map((c) => [c.id, c.location, c.sequence, c.element.name, c.element.attrs.Id, c.element.attrs.LabelText, c.element.attrs.Command, c.element.attrs.TemplateAlias, c.element.attrs.Sequence]), [
      ["acme.account.Approve.CustomAction", "Mscrm.Form.account.MainTab.Save.Controls._children", 25, "Button", "acme.account.Approve.Button", "$LocLabels:acme.account.Approve.Button.LabelText", "acme.account.Approve.Command", "o1", "25"],
      ["acme.account.Reject.CustomAction", "Mscrm.Form.account.MainTab.Save.Controls._children", 45, "Button", "acme.account.Reject.Button", "Reject", "acme.account.Reject.Command", "o1", "45"],
      ["acme.account.Lost.CustomAction", "Mscrm.HomepageGrid.account.MainTab.Nope.Controls._children", 10, "Button", "acme.account.Lost.Button", "Lost", "acme.account.Reject.Command", undefined, undefined],
    ], "the Lost button (its group isn't in the loaded ribbon) is written back as read; the Reject button keeps its custom action Id");
    assert.deepStrictEqual(again.hidden, [{ id: "Mscrm.Form.account.Assign", location: "Mscrm.Form.account.MainTab.Actions.Controls._children" }]);
    assert.deepStrictEqual(Object.keys(again.commands).sort(), ["acme.account.Approve.Command", "acme.account.Reject.Command"]);
    assert.deepStrictEqual(again.commands["acme.account.Approve.Command"].enableRules, ["acme.account.CanApprove"], "the client's own command is what's written");
    assert.deepStrictEqual(again.commands["acme.account.Approve.Command"].actions[0].parameters.map((p) => p.kind + "=" + p.value), []);
    assert.deepStrictEqual(Object.keys(again.enableRules), ["acme.account.CanApprove"]);
    assert.deepStrictEqual(again.enableRules["acme.account.CanApprove"].steps.map((s) => [s.kind, s.attrs.Default, s.parameters.length]), [["CustomRule", undefined, 0]]);
    assert.deepStrictEqual(Object.keys(again.displayRules), [], "the display rule came from another solution, so it isn't the client's to write");
    assert.deepStrictEqual(again.locLabels, {
      "acme.account.Approve.Button.LabelText": [{ languagecode: "1033", description: "Approve & close" }, { languagecode: "1031", description: "Genehmigen" }],
      "acme.account.Approve.Button.ToolTipTitle": [{ languagecode: "1033", description: "Genehmigt den Datensatz" }],
    }, "every language of a label is kept; a label the diff didn't have gets the text the environment shows");
    assert.match(layer.xml, /<Templates>\s*<RibbonTemplates Id="Mscrm.Templates" \/>\s*<\/Templates>/);
    assert.match(layer.xml, /description="Approve &amp; close"/);
    assert.match(layer.xml, /^<RibbonDiffXml xmlns:xsi=/);
    assert.deepStrictEqual(rm.serializeRibbonDiff(rm.parseRibbonDiff(layer.xml) && rm.applyDiff(rm.parseRibbonXml(RIBBON_XML, "account", "Form"), again)).xml, layer.xml, "writing what was read gives the same text");
    // A tab the diff adds is written back as it was read, with its label.
    const tabDiff = rm.parseRibbonDiff('<RibbonDiffXml><CustomActions><CustomAction Id="acme.Tab.CA" Location="Mscrm.Tabs._children" Sequence="500"><CommandUIDefinition><Tab Id="acme.account.Tab" Title="$LocLabels:acme.account.Tab.Title" Sequence="500"><Scaling Id="acme.account.Tab.Scaling"><MaxSize Id="acme.account.Tab.MaxSize" GroupId="acme.account.Tab.Group" Sequence="10" Size="LargeMedium" /></Scaling><Groups Id="acme.account.Tab.Groups"><Group Id="acme.account.Tab.Group" Sequence="10" Title="$LocLabels:acme.account.Tab.Group.Title" Template="Mscrm.Templates.Flexible2"><Controls Id="acme.account.Tab.Group.Controls"><Button Id="acme.account.Tab.Go" Command="acme.Go" Sequence="10" LabelText="$LocLabels:acme.account.Tab.Go.LabelText" TemplateAlias="o1" /></Controls></Group></Groups></Tab></CommandUIDefinition></CustomAction></CustomActions><LocLabels><LocLabel Id="acme.account.Tab.Go.LabelText"><Titles><Title languagecode="1033" description="Go" /></Titles></LocLabel></LocLabels></RibbonDiffXml>');
    const withTab = rm.applyDiff(rm.parseRibbonXml(RIBBON_XML, "account", "Form"), tabDiff);
    const tabLayer = rm.serializeRibbonDiff(withTab);
    assert.match(tabLayer.xml, /<CustomAction Id="acme.Tab.CA" Location="Mscrm.Tabs._children" Sequence="500">\s*<CommandUIDefinition>\s*<Tab Id="acme.account.Tab"[\s\S]*<MaxSize[\s\S]*<Button Id="acme.account.Tab.Go"/);
    assert.deepStrictEqual(tabLayer.counts, { controls: 0, hidden: 0, commands: 0, rules: 0, labels: 1 });
  });
  await test("command bar model: edits show up as changes; what Dataverse would reject is a problem on its field", () => {
    const m = loaded();
    const before = clone(m);
    const save = m.tabs[0].groups[0];
    const approve = save.controls[1];
    approve.label = "Approve now";
    m.labels["acme.account.Approve.Button.LabelText"] = "Approve now";
    m.hidden.push({ id: "Mscrm.Form.account.Save", location: "Mscrm.Form.account.MainTab.Save.Controls._children", origin: "client" });
    const b = rm.newButton(m, save.id, "acme", "Escalate");
    assert.deepStrictEqual([b.id, b.sequence, b.labelKey, b.origin, b.fresh, b.localOnly], ["acme.account.Escalate.Button", 55, "$LocLabels:acme.account.Escalate.Button.LabelText", "client", true, true]);
    save.controls.push(b);
    assert.deepStrictEqual(rm.ribbonChanges(before, m), ["changed Approve now", "added New button", "hid Save"]);
    assert.deepStrictEqual(rm.ribbonEditProblems(m, { prefix: "acme" }), [{ field: "control:acme.account.Escalate.Button:command", text: "Pick or create the command the button runs." }]);
    b.command = "acme.account.Approve.Command";
    assert.deepStrictEqual(rm.ribbonEditProblems(m, { prefix: "acme" }), []);
    b.id = "other.account.Escalate.Button";
    b.sequence = undefined;
    assert.deepStrictEqual(rm.ribbonEditProblems(m, { prefix: "acme" }).map((p) => p.text), ["Start the Id with acme (the publisher prefix).", "Give the button a sequence (its place in the group)."]);
    b.id = "acme.account.Approve.Button";
    b.sequence = 55;
    assert.deepStrictEqual(rm.ribbonEditProblems(m, { prefix: "acme" }).map((p) => p.text), ["Another control has this Id.", "Another control has this Id."]);
    b.id = "acme.account.Escalate.Button";
    m.commands["acme.account.Nothing"] = { id: "acme.account.Nothing", enableRules: ["acme.account.Gone"], displayRules: [], actions: [], origin: "client", fresh: true };
    m.enableRules["acme.Empty"] = { id: "acme.Empty", kind: "enable", steps: [{ kind: "CustomRule", attrs: {}, functionName: "", library: "", webResource: "", parameters: [], text: "" }], origin: "client", fresh: true };
    assert.deepStrictEqual(rm.ribbonEditProblems(m, { prefix: "acme" }).map((p) => [p.field, p.text]), [
      ["command:acme.account.Nothing:actions", "The command needs at least one action."],
      ["command:acme.account.Nothing:enableRules", "There's no enable rule named acme.account.Gone."],
      ["rule:enable:acme.Empty:step:0:function", "Name the function."],
      ["rule:enable:acme.Empty:step:0:library", "Name the web resource that defines the function."],
    ]);
    const modern = { uniqueName: "x", name: "x", label: "", location: 0, type: 0, hidden: false, disabled: false, onClick: { type: 2, functionName: "bad name", library: "" }, visibility: { type: 0 }, icon: {}, fresh: true };
    assert.deepStrictEqual(rm.ribbonEditProblems({ ...rm.emptyModel("account"), modern: [modern] }, { prefix: "acme" }).map((p) => p.text), [
      "Start the unique name with acme_ (the publisher prefix).", "The button needs a label.", "Pick the app the command belongs to.", "Use a JavaScript name like Acme.Account.approve.", "Name the JavaScript web resource.",
    ]);
    assert.deepStrictEqual(rm.ribbonChanges(before, { ...before, modern: [{ ...modern, removed: false }] }), ["added modern command x"]);
  });
  await test("command bar model: the table's RibbonDiffXml is found in unpacked solutions and in customizations.xml", () => {
    const dir = tmp();
    const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
    w("Sol/Other/Solution.xml", "<ImportExportXml><SolutionManifest><UniqueName>AcmeCore</UniqueName></SolutionManifest></ImportExportXml>");
    w("Sol/Entities/Account/Entity.xml", '<Entity><Name LocalizedName="Account" OriginalName="Account">Account</Name></Entity>');
    w("Sol/Entities/Account/RibbonDiff.xml", RIBBON_DIFF);
    w("Sol/Entities/Contact/Entity.xml", '<Entity><Name LocalizedName="Contact" OriginalName="Contact">Contact</Name></Entity>');
    w("Sol/Entities/Contact/RibbonDiff.xml", '<RibbonDiffXml><HideCustomActions><HideCustomAction HideActionId="Mscrm.Form.contact.Delete" Location="x" /></HideCustomActions></RibbonDiffXml>');
    w("Sol/Entities/Lead/Entity.xml", '<Entity><Name LocalizedName="Lead" OriginalName="Lead">Lead</Name></Entity>');
    w("Packed/Other/Solution.xml", "<UniqueName>AcmePacked</UniqueName>");
    w("Packed/Other/Customizations.xml", `<ImportExportXml><Entities><Entity><Name LocalizedName="Contact">Contact</Name><RibbonDiffXml><CustomActions /></RibbonDiffXml></Entity><Entity><Name LocalizedName="Account">Account</Name><RibbonDiffXml><HideCustomActions><HideCustomAction HideActionId="Mscrm.Form.account.Delete" Location="y" /></HideCustomActions></RibbonDiffXml></Entity></Entities></ImportExportXml>`);
    const found = rm.findRibbonDiffs(dir, "account").sort((a, b) => a.solution.localeCompare(b.solution));
    assert.deepStrictEqual(found.map((f) => [f.solution, path.basename(f.file), f.diff.customActions.length, f.diff.hidden.map((h) => h.id)]), [
      ["AcmeCore", "RibbonDiff.xml", 3, ["Mscrm.Form.account.Assign"]],
      ["AcmePacked", "Customizations.xml", 0, ["Mscrm.Form.account.Delete"]],
    ]);
    assert.strictEqual(rm.findRibbonDiffs(dir, "lead").length, 0);
    assert.strictEqual(rm.ribbonDiffPathFor(dir, "lead"), path.join(dir, "Sol", "Entities", "Lead", "RibbonDiff.xml"), "a table folder without a diff yet is where a new one goes");
    assert.strictEqual(rm.ribbonDiffPathFor(dir, "opportunity"), undefined);
  });
  await test("command bar: the ribbon XML is read out of the zip RetrieveEntityRibbon returns, one call per location", async () => {
    const { writeZip } = out("core/zip.js");
    const cb = out("commands/commandBar.js");
    const zip = writeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types />") }, { name: "RibbonXml.xml", data: Buffer.from("\uFEFF<RibbonDefinitions />") }]);
    assert.strictEqual(cb.ribbonXmlFromZip(zip.toString("base64")), "<RibbonDefinitions />");
    assert.throws(() => cb.ribbonXmlFromZip(writeZip([{ name: "readme.txt", data: Buffer.from("") }]).toString("base64")), /no XML/);
    // The three locations are fetched with the Web API's enum literal and merged in form, main grid, subgrid order.
    const asked = [];
    const dv = { getJson: async (p) => { asked.push(decodeURIComponent(p)); const loc = /Filters'(\w+)'/.exec(decodeURIComponent(p))[1]; return { CompressedEntityXml: writeZip([{ name: "RibbonXml.xml", data: Buffer.from(`<RibbonDefinitions><RibbonDefinition><UI><Ribbon><Tabs><Tab Id="Mscrm.${loc}.account.MainTab" Sequence="10" /></Tabs></Ribbon></UI></RibbonDefinition></RibbonDefinitions>`) }]).toString("base64") }; } };
    const m = await cb.loadCommandBar(dv, "account");
    assert.deepStrictEqual(asked, ["Form", "HomepageGrid", "SubGrid"].map((l) => `RetrieveEntityRibbon(EntityName=@p1,RibbonLocationFilter=@p2)?@p1='account'&@p2=Microsoft.Dynamics.CRM.RibbonLocationFilters'${l}'`));
    assert.deepStrictEqual(m.tabs.map((t) => t.location), ["Form", "HomepageGrid", "SubGrid"]);
  });
  await test("command bar: the RibbonDiffXml is written to RibbonDiff.xml or into the table's entity of a customizations.xml, keeping line endings", () => {
    const cb = out("commands/commandBar.js");
    const dir = tmp();
    const f = path.join(dir, "Sol", "Entities", "Account", "RibbonDiff.xml");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '<?xml version="1.0"?>\r\n<RibbonDiffXml />\r\n');
    cb.writeLocalRibbonDiff(f, "account", "<RibbonDiffXml>\n  <CustomActions />\n</RibbonDiffXml>");
    assert.strictEqual(fs.readFileSync(f, "utf8"), '<?xml version="1.0" encoding="utf-8"?>\r\n<RibbonDiffXml>\r\n  <CustomActions />\r\n</RibbonDiffXml>\r\n');
    const fresh = path.join(dir, "Sol", "Entities", "Lead", "RibbonDiff.xml");
    cb.writeLocalRibbonDiff(fresh, "lead", "<RibbonDiffXml />");
    assert.strictEqual(fs.readFileSync(fresh, "utf8"), '<?xml version="1.0" encoding="utf-8"?>\n<RibbonDiffXml />\n', "a new file gets LF");
    const c = path.join(dir, "Packed", "Other", "Customizations.xml");
    fs.mkdirSync(path.dirname(c), { recursive: true });
    fs.writeFileSync(c, "<ImportExportXml><Entities><Entity><Name>Account</Name><EntityInfo><entity Name=\"Account\"><attributes><attribute><Name>name</Name></attribute></attributes></entity></EntityInfo><FormXml /></Entity></Entities></ImportExportXml>");
    cb.writeLocalRibbonDiff(c, "account", "<RibbonDiffXml><X /></RibbonDiffXml>");
    assert.match(fs.readFileSync(c, "utf8"), /<FormXml \/><RibbonDiffXml><X \/><\/RibbonDiffXml>\n<\/Entity>/);
    cb.writeLocalRibbonDiff(c, "account", "<RibbonDiffXml><Y /></RibbonDiffXml>");
    const twice = fs.readFileSync(c, "utf8");
    assert.ok(twice.includes("<RibbonDiffXml><Y /></RibbonDiffXml>") && !twice.includes("<X />"), "the second write replaces the first");
    assert.throws(() => cb.writeLocalRibbonDiff(c, "lead", "<RibbonDiffXml />"), /no <Entity> for lead/);
  });
  await test("command bar publish: the exported solution gets the table's RibbonDiffXml, the import job is waited for, the table is published", async () => {
    const pub = out("core/ribbonPublish.js");
    const { writeZip, readZip } = out("core/zip.js");
    const customizations = `<ImportExportXml><Entities><Entity><Name LocalizedName="Contact">Contact</Name><RibbonDiffXml><CustomActions /></RibbonDiffXml></Entity><Entity><Name LocalizedName="Account" OriginalName="Account">Account</Name><EntityInfo><entity Name="Account"><attributes><attribute PhysicalName="Name"><Name>name</Name></attribute></attributes></entity></EntityInfo><FormXml /></Entity></Entities></ImportExportXml>`;
    const zip = writeZip([{ name: "solution.xml", data: Buffer.from("<x />") }, { name: "customizations.xml", data: Buffer.from("\uFEFF" + customizations) }]);
    const patched = readZip(pub.patchSolutionZip(zip, "Sol", "account", "<RibbonDiffXml><HideCustomActions /></RibbonDiffXml>"));
    const text = patched.find((e) => e.name === "customizations.xml").data.toString("utf8");
    assert.match(text, /^\uFEFF<ImportExportXml>/, "the byte order mark stays");
    assert.match(text, /Account<\/Name><EntityInfo>[\s\S]*<FormXml \/><RibbonDiffXml><HideCustomActions \/><\/RibbonDiffXml>\n<\/Entity>/);
    assert.match(text, /Contact<\/Name><RibbonDiffXml><CustomActions \/>/, "the other table's diff is untouched");
    assert.strictEqual(patched.find((e) => e.name === "solution.xml").data.toString(), "<x />");
    assert.throws(() => pub.patchSolutionZip(zip, "Sol", "lead", "<RibbonDiffXml />"), /Solution Sol doesn't contain the lead table/);
    assert.match(rm.replaceEntityRibbonDiff(customizations, "contact", "<RibbonDiffXml><X /></RibbonDiffXml>"), /Contact<\/Name><RibbonDiffXml><X \/><\/RibbonDiffXml><\/Entity>/, "an existing diff is replaced in place");
    const dvm = out("core/dataverse.js");
    const sleepWas = dvm.timing.sleep;
    dvm.timing.sleep = async () => {};
    try {
      const calls = [];
      let polls = 0;
      const dv = {
        actionJson: async (name, body) => { calls.push([name, Object.keys(body)]); return name === "ExportSolution" ? { ExportSolutionFile: zip.toString("base64") } : { AsyncOperationId: "op1", ImportJobKey: "k" }; },
        getJson: async () => { polls++; return polls < 3 ? { statecode: 2, statuscode: 20 } : { statecode: 3, statuscode: 30 }; },
        action: async (name, body) => calls.push([name, body.ParameterXml]),
      };
      const lines = [];
      await pub.publishRibbonDiff(dv, "Sol", "account", "<RibbonDiffXml />", (l) => lines.push(l));
      assert.deepStrictEqual(calls, [
        ["ExportSolution", ["SolutionName", "Managed"]],
        ["ImportSolutionAsync", ["CustomizationFile", "OverwriteUnmanagedCustomizations", "PublishWorkflows", "ImportJobId"]],
        ["PublishXml", "<importexportxml><entities><entity>account</entity></entities></importexportxml>"],
      ]);
      assert.strictEqual(polls, 3);
      assert.deepStrictEqual(lines.filter((l) => !/^Import running/.test(l)), ["Exporting Sol", "Importing Sol with the new command bar", "Publishing account"]);
      await assert.rejects(pub.importSolutionZip({ ...dv, getJson: async () => ({ statecode: 3, statuscode: 31, message: "The ribbon is broken." }) }, zip), /import failed\. The ribbon is broken\./);
    } finally {
      dvm.timing.sleep = sleepWas;
    }
  });
  await test("modern commands: rows map to commands and back, only changed rows are written, the apps touched are published", async () => {
    const mc = out("core/modernCommands.js");
    const row = {
      appactionid: "a1", name: "Approve", uniquename: "acme_account_Approve", buttonlabeltext: "Approve", buttontooltiptitle: null, buttontooltipdescription: null, location: 0, type: 0, sequence: 20, hidden: false, isdisabled: false, grouptitle: null, fonticon: "Approve",
      onclickeventtype: 2, onclickeventjavascriptfunctionname: "Acme.Account.approve", onclickeventjavascriptparameters: "PrimaryControl", onclickeventformulafunctionname: null, onclickeventformulacomponentname: null, onclickeventformulacomponentlibrary: null,
      visibilitytype: 0, visibilityformulafunctionname: null, visibilityformulacomponentname: null, visibilityformulacomponentlibrary: null,
      _appmoduleid_value: "app1", _parentappactionid_value: null, _iconwebresourceid_value: null, _onclickeventjavascriptwebresourceid_value: "w1",
      appmoduleid: { appmoduleid: "app1", name: "Sales Hub", uniquename: "acme_SalesHub" }, iconwebresourceid: null, onclickeventjavascriptwebresourceid: { webresourceid: "w1", name: "acme_/account/ribbon.js" },
    };
    const cmd = mc.rowToCommand(row);
    assert.deepStrictEqual([cmd.id, cmd.label, cmd.app.name, cmd.onClick.type, cmd.onClick.functionName, cmd.onClick.library, cmd.onClick.libraryId, cmd.icon.fontIcon, cmd.hidden], ["a1", "Approve", "Sales Hub", 2, "Acme.Account.approve", "acme_/account/ribbon.js", "w1", "Approve", false]);
    const body = mc.commandBody(cmd, "account");
    assert.deepStrictEqual([body.uniquename, body.context, body.contextvalue, body.location, body.onclickeventtype, body.onclickeventjavascriptfunctionname, body.onclickeventformulafunctionname, body.fonticon], ["acme_account_Approve", 1, "account", 0, 2, "Acme.Account.approve", null, "Approve"]);
    const before = [cmd, mc.rowToCommand({ ...row, appactionid: "a2", uniquename: "acme_x", buttonlabeltext: "X" })];
    const after = clone(before);
    after[0].label = "Approve now";
    after[1].removed = true;
    after.push({ uniqueName: "acme_account_New", name: "New", label: "New", location: 1, type: 0, sequence: 30, app: { id: "app2", name: "Service" }, hidden: false, disabled: false, onClick: { type: 2, functionName: "Acme.go", library: "acme_/go.js" }, visibility: { type: 0 }, icon: { webResource: "acme_/icons/go.svg" }, fresh: true });
    const ch = mc.modernChanges(before, after);
    assert.deepStrictEqual([ch.create.map((c) => c.uniqueName), ch.update.map((c) => c.uniqueName), ch.remove.map((c) => c.uniqueName)], [["acme_account_New"], ["acme_account_Approve"], ["acme_x"]]);
    const calls = [];
    const dv = {
      remove: async (p) => calls.push(["DELETE", p]),
      create: async (set, body, headers) => { calls.push(["POST", set, body, headers]); return "new1"; },
      update: async (p, body) => calls.push(["PATCH", p, body]),
      getAll: async (p) => (p.startsWith("entities?") ? [{ entityid: "e1" }] : []),
      action: async (name, body) => calls.push([name, body.ParameterXml]),
    };
    const ids = await mc.saveModernCommands(dv, ch, { table: "account", solution: "AcmeCore", webResourceId: async (n) => ({ "acme_/account/ribbon.js": "w1", "acme_/go.js": "w2", "acme_/icons/go.svg": "w3" })[n] });
    assert.deepStrictEqual(ids, { acme_account_New: "new1" });
    assert.deepStrictEqual(calls[0], ["DELETE", "appactions(a2)"]);
    const post = calls.find((c) => c[0] === "POST");
    assert.deepStrictEqual([post[1], post[2]["appmoduleid@odata.bind"], post[2]["onclickeventjavascriptwebresourceid@odata.bind"], post[2]["iconwebresourceid@odata.bind"], post[2]["contextentity@odata.bind"], post[2].contextvalue, post[3]], ["appactions", "/appmodules(app2)", "/webresourceset(w2)", "/webresourceset(w3)", "/entities(e1)", "account", { "MSCRM.SolutionUniqueName": "AcmeCore" }]);
    const patch = calls.find((c) => c[0] === "PATCH");
    assert.deepStrictEqual([patch[1], patch[2].buttonlabeltext, patch[2]["onclickeventjavascriptwebresourceid@odata.bind"], "contextentity@odata.bind" in patch[2]], ["appactions(a1)", "Approve now", "/webresourceset(w1)", false]);
    assert.deepStrictEqual(calls[calls.length - 1], ["PublishXml", "<importexportxml><appmodules><appmodule>{app1}</appmodule><appmodule>{app2}</appmodule></appmodules></importexportxml>"]);
    await assert.rejects(mc.saveModernCommands(dv, { create: [after[2]], update: [], remove: [] }, { table: "account", webResourceId: async () => undefined }), /The library acme_\/go\.js isn't a web resource in the environment/);
    // Clearing a lookup removes the reference, since a PATCH can't null it.
    const cleared = clone(cmd);
    cleared.onClick.library = "";
    const calls2 = [];
    await mc.saveModernCommands({ ...dv, update: async (p, body) => calls2.push(["PATCH", p]), remove: async (p) => calls2.push(["DELETE", p]), action: async () => calls2.push(["PublishXml"]) }, { create: [], update: [cleared], remove: [] }, { table: "account", webResourceId: async () => undefined });
    assert.deepStrictEqual(calls2, [["PATCH", "appactions(a1)"], ["DELETE", "appactions(a1)/onclickeventjavascriptwebresourceid/$ref"], ["PublishXml"]]);
    assert.deepStrictEqual(await mc.fetchModernCommands({ getAll: async () => { throw new Error("Resource not found for the segment 'appactions'."); } }, "account"), [], "an environment without the table has no modern commands");
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
  await test("codegen: subqueries become AnyAllFilterLinkEntity links, nested, joined and on a joined table", () => {
    const c = gen("csQuery", "SELECT a.name FROM account a JOIN contact c ON c.contactid = a.primarycontactid WHERE a.statecode = 0 AND NOT EXISTS (SELECT 1 FROM task t WHERE t.regardingobjectid = c.contactid) AND (a.name = 'x' OR a.accountid IN (SELECT o.parentcustomerid FROM contact o JOIN systemuser u ON u.systemuserid = o.ownerid WHERE u.isdisabled = 0 AND o.statecode = 0))").code;
    assert.match(c, /var sub1 = new LinkEntity\("contact", "task", "contactid", "regardingobjectid", JoinOperator\.NotAny\);\nvar filter1 = new FilterExpression\(LogicalOperator\.And\) \{ AnyAllFilterLinkEntity = sub1 \};\nlink1\.LinkCriteria\.AddFilter\(filter1\);/);
    assert.match(c, /var sub2 = new LinkEntity\("account", "contact", "accountid", "parentcustomerid", JoinOperator\.Any\);\nvar sub2Link1 = sub2\.AddLink\("systemuser", "ownerid", "systemuserid", JoinOperator\.Inner\);\nsub2Link1\.EntityAlias = "u";\nsub2Link1\.LinkCriteria\.AddCondition\("isdisabled", ConditionOperator\.Equal, 0\);\nsub2\.LinkCriteria\.AddCondition\("statecode", ConditionOperator\.Equal, 0\);/);
    assert.match(c, /filter3\.AddFilter\(filter4\);/);
    assert.match(gen("csQuery", "SELECT name FROM account WHERE (statecode = 0 OR statecode = 1) AND (name = 'a' OR name = 'b')").code, /var filter1 = [\s\S]*var filter2 = [\s\S]*var filter3 = /);
    assert.throws(() => gen("csQuery", "SELECT name FROM account WHERE EXISTS (SELECT 1 FROM contact WHERE statecode = 0)"), /needs a condition linking it to account/);
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
      script = [reply(429, {}, { "Retry-After": "1" }), reply(429), reply(429), reply(429, { error: { message: "Busy" } })];
      await assert.rejects(client.getJson("x"), /throttling requests \(429\) and kept throttling after three waits[\s\S]*Busy/);
      assert.deepStrictEqual(waits, [1000, 10000, 15000], "three waits, then it gives up");

      // A wait longer than the cap isn't cut short and retried early (that only earns more 429s): it fails at once,
      // and the whole wait is recorded so batches starting meanwhile hold off.
      waits.length = 0;
      script = [reply(429, { error: { message: "Busy" } }, { "Retry-After": "600" })];
      const before = Date.now();
      await assert.rejects(client.getJson("x"), /asked to wait 10 minutes[\s\S]*Busy/);
      assert.deepStrictEqual(waits, []);
      assert.ok(client.throttledUntil >= before + 600_000, "throttledUntil covers the whole Retry-After");
      waits.length = 0;
      script = [reply(429, {}, { "Retry-After": new Date(Date.now() + 4000).toUTCString() }), reply(200, { ok: 2 })];
      assert.deepStrictEqual(await client.getJson("x"), { ok: 2 });
      assert.ok(waits.length === 1 && waits[0] > 2000 && waits[0] <= 4000, `an HTTP-date Retry-After is honoured: ${waits}`);

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
    await assert.rejects(auth.getToken(client), /Signed in as someone@else\.com, but .*'s tenant configuration says to use missing@a\.com/);
    delete S.newSignInAccount;

    const dataverse = auth.dataverseFor(client);
    assert.strictEqual(dataverse.orgUrl, "https://a.crm.dynamics.com");
    fs.writeFileSync(path.join(dir, ".lantern/config.json"), JSON.stringify({}));
    assert.throws(() => auth.dataverseFor(clients.readClient(dir)), /Set "org" in the .* tenant configuration first/);
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
  await test("scaffolding: templates per kind, PluginBase when the project has it, namespaces", () => {
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
    // A plain walk: readdirSync({ recursive: true }) silently returns only the top level before Node 20.
    const tsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    const source = tsFiles(path.join(root, "src")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
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
    // Copilot reads the declarations; MCP clients get the code's: they must say the same thing.
    const tools = out("ui/lanternTools.js").lanternTools(() => ({}));
    const declared = (c.languageModelTools ?? []).map((t) => t.name).sort();
    const registered = tools.map((t) => t.name).sort();
    if (JSON.stringify(declared) !== JSON.stringify(registered)) problems.push(`Copilot tools declared ${declared} but registered ${registered}`);
    for (const t of tools) {
      const d = (c.languageModelTools ?? []).find((x) => x.name === t.name);
      if (d && (d.modelDescription !== t.description || JSON.stringify(d.inputSchema) !== JSON.stringify(t.inputSchema))) problems.push(`${t.name}: package.json and lanternTools.ts disagree`);
    }
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
  await test("plug-in packages: the unique name gets the publisher prefix, and both spellings find the package", () => {
    assert.strictEqual(reg.packageUniqueName("OHCP.CRM.Plugins.Approval", "ohcp"), "ohcp_OHCP.CRM.Plugins.Approval");
    assert.strictEqual(reg.packageUniqueName("acme_Pkg", "acme"), "acme_Pkg", "already prefixed");
    assert.ok(reg.isPackageFor({ uniquename: "ohcp_OHCP.CRM.Plugins.Approval", name: "Approvals" }, "OHCP.CRM.Plugins.Approval"));
    assert.ok(reg.isPackageFor({ uniquename: "acme_Pkg", name: null }, "ACME_PKG"));
    assert.ok(reg.isPackageFor({ uniquename: "x_Renamed", name: "Pkg" }, "Pkg"), "the Plugin Registration Tool names it by the package ID");
    assert.ok(!reg.isPackageFor({ uniquename: "acme_Other_Pkg", name: "Other_Pkg" }, "Pkg"), "a different package that ends the same way");
  });

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

  // ---------- batched writes ----------
  await test("batch: the request body is CRLF parts, and responses parse per item (errors, headers, change sets)", () => {
    const body = dvMod.buildBatchBody(
      [{ method: "DELETE", path: "accounts(a1)" }, { method: "PATCH", path: "accounts(a2)", body: { fax: "1" }, headers: { "If-Match": "*" } }],
      "batch_x",
      "https://a.crm.dynamics.com/api/data/v9.2/"
    );
    assert.strictEqual(
      body,
      [
        "--batch_x", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "DELETE https://a.crm.dynamics.com/api/data/v9.2/accounts(a1) HTTP/1.1", "",
        "--batch_x", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "PATCH https://a.crm.dynamics.com/api/data/v9.2/accounts(a2) HTTP/1.1", "If-Match: *", "Content-Type: application/json; type=entry", "", '{"fax":"1"}',
        "--batch_x--", "",
      ].join("\r\n")
    );
    assert.ok(!/[^\r]\n/.test(body), "only CRLF line endings");
    const response = [
      "--batchresponse_1", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "HTTP/1.1 204 No Content", "OData-Version: 4.0", "OData-EntityId: https://a.crm.dynamics.com/api/data/v9.2/accounts(11111111-1111-1111-1111-111111111111)", "", "",
      "--batchresponse_1", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "HTTP/1.1 404 Not Found", "Content-Type: application/json; odata.metadata=minimal", "OData-Version: 4.0", "",
      '{"error":{"code":"0x80040217","message":"account With Id = a2 Does Not Exist"}}',
      "--batchresponse_1", "Content-Type: multipart/mixed; boundary=changesetresponse_2", "",
      "--changesetresponse_2", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "Content-ID: 1", "",
      "HTTP/1.1 204 No Content", "OData-Version: 4.0", "", "",
      "--changesetresponse_2--",
      "--batchresponse_1", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "HTTP/1.1 500 Internal Server Error", "", "not json",
      "--batchresponse_1--", "",
    ].join("\r\n");
    const parsed = dvMod.parseBatchResponse(response, "multipart/mixed; boundary=batchresponse_1");
    assert.deepStrictEqual(parsed.map((p) => [p.status, p.ok, p.error]), [[204, true, undefined], [404, false, "account With Id = a2 Does Not Exist"], [204, true, undefined], [500, false, "HTTP 500 Internal Server Error"]]);
    assert.strictEqual(parsed[0].headers["odata-entityid"], "https://a.crm.dynamics.com/api/data/v9.2/accounts(11111111-1111-1111-1111-111111111111)");
    assert.deepStrictEqual(dvMod.parseBatchResponse(response.replace(/\r\n/g, "\n"), null).map((p) => p.status), [204, 404, 204, 500], "boundary read from the body, LF tolerated");
    assert.throws(() => dvMod.parseBatchResponse('{"error":{}}', "application/json"), /isn't a batch response/);
  });
  await test("batch: DataverseClient.batch posts $batch with continue-on-error, pads a short answer, and waits out throttling", async () => {
    const realFetch = global.fetch;
    const realSleep = dvMod.timing.sleep;
    const waits = [];
    dvMod.timing.sleep = async (ms) => void waits.push(ms);
    const calls = [];
    const answer = (parts, status = 200) => ({
      ok: status < 300,
      status,
      headers: { get: (h) => (h === "Content-Type" ? 'multipart/mixed; boundary="batchresponse_9"' : h === "Retry-After" ? "3" : null) },
      json: async () => ({}),
      text: async () => parts.map((p) => `--batchresponse_9\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${p}\r\n`).join("") + "--batchresponse_9--\r\n",
    });
    try {
      let script = [answer(["HTTP/1.1 204 No Content\r\nOData-Version: 4.0\r\n", 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":{"message":"Nope"}}'])];
      global.fetch = async (url, init) => { calls.push({ url, init }); return script.shift(); };
      const client = new dvMod.DataverseClient("https://a.crm.dynamics.com", async () => "t");
      const results = await client.batch([{ method: "DELETE", path: "accounts(a1)" }, { method: "DELETE", path: "accounts(a2)" }, { method: "DELETE", path: "accounts(a3)" }]);
      assert.strictEqual(calls[0].url, "https://a.crm.dynamics.com/api/data/v9.2/$batch");
      assert.strictEqual(calls[0].init.method, "POST");
      assert.strictEqual(calls[0].init.headers.Prefer, "odata.continue-on-error");
      assert.strictEqual(calls[0].init.headers.Authorization, "Bearer t");
      const boundary = /^multipart\/mixed; boundary="(batch_[^"]+)"$/.exec(calls[0].init.headers["Content-Type"])[1];
      assert.ok(calls[0].init.body.startsWith(`--${boundary}\r\n`) && calls[0].init.body.endsWith(`--${boundary}--\r\n`), "the body uses the boundary from the header");
      assert.strictEqual((calls[0].init.body.match(/DELETE https:\/\/a\.crm\.dynamics\.com\/api\/data\/v9\.2\/accounts\(a\d\) HTTP\/1\.1/g) || []).length, 3);
      assert.deepStrictEqual(results.map((r) => [r.ok, r.error]), [[true, undefined], [false, "Nope"], [false, "Not attempted: an earlier request in the batch failed"]]);

      script = [answer([], 429), answer(["HTTP/1.1 204 No Content\r\n"])];
      assert.deepStrictEqual((await client.batch([{ method: "DELETE", path: "accounts(a1)" }])).map((r) => r.ok), [true]);
      assert.deepStrictEqual(waits, [3000], "Retry-After is honoured for a throttled batch");
      await assert.rejects(client.batch(Array.from({ length: 1001 }, () => ({ method: "DELETE", path: "x" }))), /1000 requests at most/);
      assert.deepStrictEqual(await client.batch([]), []);
    } finally {
      global.fetch = realFetch;
      dvMod.timing.sleep = realSleep;
    }
  });
  const writeTable = { logicalName: "account", entitySetName: "accounts", primaryId: "accountid", primaryName: "name" };
  const okAnswer = () => ({ status: 204, ok: true, headers: {}, body: "" });
  await test("write: rows go out in batches of the configured size, several in flight, and each row keeps its own result", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 100, startBatchSize: 100, concurrency: 3 });
    try {
      assert.deepStrictEqual(write.chunkRows([1, 1, 1], 1000), [[0, 1, 2]]);
      assert.deepStrictEqual(write.chunkRows([2, 2, 2], 3), [[0], [1], [2]]);
      assert.deepStrictEqual(write.chunkRows([1, 3, 1, 1], 4), [[0, 1], [2, 3]]);
      const batches = [];
      let inFlight = 0;
      let peak = 0;
      const dv = {
        batch: async (items) => {
          batches.push(items);
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return items.map((item) => (item.path === "accounts(id-5)" ? { status: 404, ok: false, headers: {}, body: "", error: "Does Not Exist" } : okAnswer()));
        },
      };
      const rows = Array.from({ length: 250 }, (_, i) => ({ id: `id-${i}`, name: `row ${i}` }));
      const plan = { kind: "delete", table: writeTable, rows, summary: "", hasWhere: true, source: "DELETE FROM account" };
      const progress = [];
      const set = await write.applyWrite(plan, { dv }, (done) => progress.push(done));
      assert.deepStrictEqual(batches.map((b) => b.length), [100, 100, 50], "chunked at the batch size");
      assert.deepStrictEqual(batches[0].slice(0, 2), [{ method: "DELETE", path: "accounts(id-0)" }, { method: "DELETE", path: "accounts(id-1)" }]);
      assert.strictEqual(peak, 3, "all three batches in flight together");
      assert.deepStrictEqual(set.columns, ["name", "Result"]);
      assert.strictEqual(set.kind, "write");
      assert.strictEqual(set.rows.length, 250);
      assert.deepStrictEqual(set.rows[5], [{ raw: "row 5" }, { raw: "Failed: Does Not Exist" }]);
      assert.strictEqual(set.rows.filter((r) => r[1].raw === "Deleted").length, 249);
      assert.ok(set.rowIds.every((id) => id === undefined));
      assert.deepStrictEqual(progress.sort((a, b) => a - b).slice(-1), [250], "progress reaches the row count");
      assert.strictEqual(progress.length, 3, "one report per batch");
    } finally {
      Object.assign(write.limits, saved);
    }
  });
  await test("write: UPDATE keeps a row's PATCH and lookup clears in one batch (404 on a clear is fine); INSERT reads the new IDs; a failed batch fails only its rows", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 4, concurrency: 1 });
    try {
      const rows = [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }, { id: "a3", name: "Three" }];
      const batches = [];
      const dv = {
        batch: async (items) => {
          batches.push(items.map((i) => `${i.method} ${i.path}${i.headers ? ` ${JSON.stringify(i.headers)}` : ""}`));
          return items.map((item) =>
            item.path.endsWith("/$ref") ? { status: 404, ok: false, headers: {}, body: "", error: "no link" } : item.path === "accounts(a3)" ? { status: 412, ok: false, headers: {}, body: "", error: "Precondition Failed" } : okAnswer()
          );
        },
      };
      const update = { kind: "update", table: writeTable, rows, prepared: { body: { fax: "1" }, clears: ["parentaccountid"], summary: [] }, summary: "", hasWhere: true, source: "" };
      const set = await write.applyWrite(update, { dv }, () => undefined);
      assert.deepStrictEqual(batches, [
        ['PATCH accounts(a1) {"If-Match":"*"}', "DELETE accounts(a1)/parentaccountid/$ref", 'PATCH accounts(a2) {"If-Match":"*"}', "DELETE accounts(a2)/parentaccountid/$ref"],
        ['PATCH accounts(a3) {"If-Match":"*"}', "DELETE accounts(a3)/parentaccountid/$ref"],
      ], "two requests per row, and a row is never split across batches");
      assert.deepStrictEqual(set.rows.map((r) => r[1].raw), ["Updated", "Updated", "Failed: Precondition Failed"]);
      assert.deepStrictEqual(set.rowIds, ["a1", "a2", "a3"]);

      let calls = 0;
      const dv2 = {
        batch: async (items) => {
          if (calls++ === 0) throw new Error("Couldn't reach a.crm.dynamics.com");
          return items.map((_, i) => ({ status: 204, ok: true, headers: { "odata-entityid": `https://a/api/data/v9.2/accounts(0000000${i}-0000-0000-0000-000000000000)` }, body: "" }));
        },
      };
      const insert = {
        kind: "insert",
        table: writeTable,
        rows: Array.from({ length: 5 }, (_, i) => ({ id: "", name: `N${i + 1}` })),
        inserts: Array.from({ length: 5 }, (_, i) => ({ body: { name: `N${i + 1}` }, clears: [], summary: [] })),
        summary: "", hasWhere: true, source: "",
      };
      const made = await write.applyWrite(insert, { dv: dv2 }, () => undefined);
      assert.deepStrictEqual(made.rows.map((r) => r[1].raw), [...Array(4).fill("Failed: Couldn't reach a.crm.dynamics.com"), "Created"]);
      assert.deepStrictEqual(made.rowIds, [undefined, undefined, undefined, undefined, "00000000-0000-0000-0000-000000000000"]);
    } finally {
      Object.assign(write.limits, saved);
    }
  });
  await test("write: batches shrink when rows are slow and grow back when they're quick, between the min and max sizes", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 100, startBatchSize: 100, minBatchSize: 10, batchMs: 60, concurrency: 1, maxConcurrency: 1 });
    try {
      const sizes = [];
      let perRow = 3; // ms of "server work" per row
      const dv = {
        batch: async (items) => {
          sizes.push(items.length);
          await new Promise((r) => setTimeout(r, items.length * perRow));
          if (sizes.length === 6) perRow = 0; // rows become instant
          return items.map(okAnswer);
        },
      };
      const rows = Array.from({ length: 600 }, (_, i) => ({ verb: "Deleted", items: [{ method: "DELETE", path: `accounts(id-${i})` }] }));
      await write.sendRows(rows, dv, () => undefined);
      assert.strictEqual(sizes[0], 100, "starts at the start size");
      assert.ok(sizes.slice(1, 6).every((s) => s >= 10 && s <= 40), `slow rows (3 ms each, 60 ms per batch) shrink the batches toward 20: ${sizes.slice(1, 6)}`);
      assert.strictEqual(sizes[sizes.length - 1] <= 100, true);
      assert.ok(sizes.slice(-3).some((s) => s > 40), `quick rows grow the batches back: ${sizes.slice(-6)}`);
      assert.strictEqual(sizes.reduce((a, b) => a + b, 0), 600, "every row sent once");
    } finally {
      Object.assign(write.limits, saved);
    }
  });
  await test("write: lanes stop growing, and come back, when more of them only make each row slower", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 1, startBatchSize: 1, concurrency: 2, minConcurrency: 2, maxConcurrency: 32, tickMs: 40 });
    try {
      // A server that handles 8 rows at a time well: each row takes 10 ms up to 8 lanes, then the time per row grows with the lanes.
      let inFlight = 0;
      const widths = [];
      const dv = {
        recommendedParallelism: 32,
        batch: async (items) => {
          inFlight++;
          widths.push(inFlight);
          const ms = 10 * Math.max(1, inFlight / 8);
          await new Promise((r) => setTimeout(r, ms));
          inFlight--;
          return items.map(okAnswer);
        },
      };
      const lines = [];
      const rows = Array.from({ length: 800 }, (_, i) => ({ verb: "Deleted", items: [{ method: "DELETE", path: `accounts(id-${i})` }] }));
      const outcomes = await write.sendRows(rows, dv, () => undefined, undefined, (line) => lines.push(line));
      assert.ok(outcomes.every((o) => o.result === "Deleted"));
      const peak = Math.max(...widths);
      assert.ok(peak >= 8 && peak < 32, `grows to where rows slow down, not to the hint: peak ${peak}`);
      const late = widths.slice(-200);
      const lateAvg = late.reduce((a, b) => a + b, 0) / late.length;
      assert.ok(lateAvg >= 5 && lateAvg <= 20, `settles near the knee: late average ${lateAvg.toFixed(1)} lanes`);
      assert.ok(lines.some((l) => /batches at a time/.test(l)), "logs the tuning steps");
    } finally {
      Object.assign(write.limits, saved);
    }
  });
  await test("write: a plan's OPTION (BYPASS ...) hints go out as headers on every request of every row", async () => {
    const sent = [];
    const dv = { batch: async (items) => { sent.push(...items.map((i) => `${i.method} ${i.path} ${JSON.stringify(i.headers)}`)); return items.map(okAnswer); } };
    const plan = { kind: "update", table: writeTable, hints: ["bypass sync plugins", "bypass flows"], rows: [{ id: "a1", name: "One" }], prepared: { body: { fax: "1" }, clears: ["parentaccountid"], files: ["doc"], summary: [] }, summary: "", hasWhere: true, source: "" };
    await write.applyWrite(plan, { dv }, () => undefined);
    const h = '{"MSCRM.BypassBusinessLogicExecution":"CustomSync","MSCRM.SuppressCallbackRegistrationExpanderJob":"true"}';
    assert.deepStrictEqual(sent, [
      `PATCH accounts(a1) {"If-Match":"*","MSCRM.BypassBusinessLogicExecution":"CustomSync","MSCRM.SuppressCallbackRegistrationExpanderJob":"true"}`,
      `DELETE accounts(a1)/parentaccountid/$ref ${h}`,
      `DELETE accounts(a1)/doc ${h}`,
    ]);
    sent.length = 0;
    await write.applyWrite({ kind: "delete", table: writeTable, hints: ["bypass plugins"], rows: [{ id: "a1", name: "One" }], summary: "", hasWhere: true, source: "" }, { dv }, () => undefined);
    assert.deepStrictEqual(sent, ['DELETE accounts(a1) {"MSCRM.BypassBusinessLogicExecution":"CustomSync,CustomAsync"}']);
    assert.deepStrictEqual(write.hintHeaders(["bypass plugins", "bypass flows"]), { "MSCRM.BypassBusinessLogicExecution": "CustomSync,CustomAsync", "MSCRM.SuppressCallbackRegistrationExpanderJob": "true" });
    assert.deepStrictEqual(write.hintHeaders(["bypass sync plugins"]), { "MSCRM.BypassBusinessLogicExecution": "CustomSync" });
    assert.deepStrictEqual(write.hintHeaders(["bypass async plugins", "bypass sync plugins"]), { "MSCRM.BypassBusinessLogicExecution": "CustomSync,CustomAsync" });
    assert.deepStrictEqual(write.hintHeaders(), {});
    assert.match(write.hintText(["bypass plugins", "bypass flows"]), /^Custom plug-ins and workflows won't run \(BYPASS PLUGINS; .*\)\. Power Automate flows won't be triggered \(BYPASS FLOWS\)\.$/);
  });
  await test("write: after a 429 no batch starts until Retry-After ends, the batches in flight halve, then grow back one per batch", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 1, concurrency: 8, minConcurrency: 2, maxConcurrency: 8, tickMs: 1 });
    try {
      let inFlight = 0;
      const peaks = []; // in-flight count when each batch started
      let calls = 0;
      let heldUntil = 0;
      let startedDuringHold = 0;
      const dv = {
        throttledUntil: 0,
        batch: async (items) => {
          calls++;
          inFlight++;
          peaks.push(inFlight);
          if (Date.now() < heldUntil) startedDuringHold++;
          if (calls === 8) {
            // the 8th batch is throttled: the client would sleep Retry-After inside request(); here it just notes it
            heldUntil = Date.now() + 60;
            dv.throttledUntil = heldUntil;
          }
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
          return items.map(okAnswer);
        },
      };
      const lines = [];
      const rows = Array.from({ length: 30 }, (_, i) => ({ verb: "Deleted", items: [{ method: "DELETE", path: `accounts(id-${i})` }] }));
      const outcomes = await write.sendRows(rows, dv, () => undefined, undefined, (line) => lines.push(line));
      assert.ok(outcomes.every((o) => o.result === "Deleted"));
      assert.strictEqual(startedDuringHold, 0, "nothing new starts before Retry-After ends");
      assert.strictEqual(Math.max(...peaks.slice(0, 8)), 8, "full width before the 429");
      const after = peaks.slice(8);
      assert.ok(after[0] <= 4, `halved after the 429, got ${after[0]}`);
      assert.ok(Math.max(...after) > 4 && Math.max(...after) <= 8, `grows back afterwards, got ${Math.max(...after)}`);
      assert.ok(lines.some((l) => /Dataverse asked for a pause \(429\): waiting \d+ s, then 4 batches at a time/.test(l)), lines.join("|"));
    } finally {
      Object.assign(write.limits, saved);
    }
  });
  await test("write: SET filecolumn = NULL deletes the file with a DELETE on the column (404 is fine); a file can't be set", async () => {
    const columns = [{ logicalName: "acme_document", type: "File", displayName: "File" }, { logicalName: "fax", type: "String", displayName: "Fax" }];
    const p = await write.prepareValues(writeTable, columns, [{ column: "acme_document", value: null }, { column: "fax", value: "1" }], {}, {});
    assert.deepStrictEqual([p.body, p.files, p.summary[0]], [{ fax: "1" }, ["acme_document"], "acme_document = NULL (file deleted)"]);
    await assert.rejects(() => write.prepareValues(writeTable, columns, [{ column: "acme_document", value: "x" }], {}, {}), /acme_document is a file column: SET acme_document = NULL deletes the file/);
    const batches = [];
    const dv = {
      batch: async (items) => {
        batches.push(items.map((i) => `${i.method} ${i.path}`));
        return items.map((i) => (i.path === "accounts(a2)/acme_document" ? { status: 404, ok: false, headers: {}, body: "", error: "no file" } : okAnswer()));
      },
    };
    const plan = { kind: "update", table: writeTable, rows: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }], prepared: { body: {}, clears: [], files: ["acme_document"], summary: [] }, summary: "", hasWhere: true, source: "" };
    const set = await write.applyWrite(plan, { dv }, () => undefined);
    assert.deepStrictEqual(batches, [["DELETE accounts(a1)/acme_document", "DELETE accounts(a2)/acme_document"]]);
    assert.deepStrictEqual(set.rows.map((r) => r[1].raw), ["Updated", "Updated"]);
  });
  await test("write: sendRows mixes creates and updates per row, and reports rows that couldn't be prepared without sending them", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 10, concurrency: 1 });
    try {
      const sent = [];
      const dv = {
        batch: async (items) => {
          sent.push(items.map((i) => `${i.method} ${i.path}`));
          return items.map((item) => (item.method === "POST" ? { status: 204, ok: true, headers: { "odata-entityid": "https://a/api/data/v9.2/accounts(22222222-2222-2222-2222-222222222222)" }, body: "" } : okAnswer()));
        },
      };
      const progress = [];
      const outcomes = await write.sendRows(
        [
          { verb: "Created", items: [{ method: "POST", path: "accounts", body: { name: "A" } }] },
          { verb: "Updated", id: "a1", items: [], failed: "fax needs a number, not 'x'" },
          { verb: "Updated", id: "a2", items: [{ method: "PATCH", path: "accounts(a2)", body: { fax: "1" }, headers: { "If-Match": "*" } }] },
        ],
        dv,
        (done) => progress.push(done)
      );
      assert.deepStrictEqual(sent, [["POST accounts", "PATCH accounts(a2)"]], "the row that couldn't be prepared isn't sent");
      assert.deepStrictEqual(outcomes, [{ result: "Created", id: "22222222-2222-2222-2222-222222222222" }, { result: "Failed: fax needs a number, not 'x'", id: "a1" }, { result: "Updated", id: "a2" }]);
      assert.deepStrictEqual(progress, [3], "progress counts the unsent row too");
    } finally {
      Object.assign(write.limits, saved);
    }
  });
  await test("write: the batches in flight grow to Dataverse's x-ms-dop-hint once a response carries it, up to the cap", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 1, concurrency: 2, minConcurrency: 2, maxConcurrency: 6, tickMs: 1 });
    try {
      const run = async (hint, cap) => {
        write.limits.maxConcurrency = cap;
        let inFlight = 0;
        let peak = 0;
        const dv = {
          batch: async (items) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            dv.recommendedParallelism = hint; // the hint arrives with the first responses
            inFlight--;
            return items.map(okAnswer);
          },
        };
        const lines = [];
        const rows = Array.from({ length: 40 }, (_, i) => ({ verb: "Deleted", items: [{ method: "DELETE", path: `accounts(id-${i})` }] }));
        const outcomes = await write.sendRows(rows, dv, () => undefined, undefined, (line) => lines.push(line));
        assert.ok(outcomes.every((o) => o.result === "Deleted"));
        return { peak, lines: lines.filter((l) => l.startsWith("Dataverse")), ticks: lines.filter((l) => l.startsWith("Last ")) };
      };
      const grown = await run(8, 6);
      assert.strictEqual(grown.peak, 6, "grows past the starting concurrency while rows stay quick, up to the cap");
      assert.deepStrictEqual(grown.lines, ["Dataverse allows up to 8 requests at a time for this environment: using up to 6 batches in parallel, tuned for rows per second\n"]);
      assert.ok(grown.ticks.length > 0 && /^Last \d+ s: \d+ rows \(\d+\.\d\/s\), \d+\.\d\d s per row \(best \d+\.\d\d\), \d+( → \d+)? batches at a time, 1 rows each\n$/.test(grown.ticks[0]), grown.ticks[0]);
      const low = await run(1, 6);
      assert.strictEqual(low.peak, 2, "a hint below the starting concurrency doesn't shrink it");
      assert.deepStrictEqual(low.lines, []);
      const none = await run(undefined, 6);
      assert.strictEqual(none.peak, 2, "no hint: the starting concurrency");
    } finally {
      Object.assign(write.limits, saved);
    }
  });
  await test("write: cancelling skips the batches not sent yet and says so per row", async () => {
    const saved = { ...write.limits };
    Object.assign(write.limits, { batchSize: 2, concurrency: 1 });
    try {
      const token = { isCancellationRequested: false, onCancellationRequested: () => undefined };
      let calls = 0;
      const dv = { batch: async (items) => { calls++; token.isCancellationRequested = true; return items.map(okAnswer); } };
      const rows = Array.from({ length: 6 }, (_, i) => ({ id: `id-${i}`, name: `row ${i}` }));
      const set = await write.applyWrite({ kind: "delete", table: writeTable, rows, summary: "", hasWhere: true, source: "" }, { dv }, () => undefined, token);
      assert.strictEqual(calls, 1, "nothing more is sent after cancelling");
      assert.deepStrictEqual(set.rows.map((r) => r[1].raw), ["Deleted", "Deleted", ...Array(4).fill("Skipped (cancelled)")]);
    } finally {
      Object.assign(write.limits, saved);
    }
  });

  console.log(`${passed} unit tests passed${failures.length ? `, ${failures.length} failed` : ""}.`);
  if (failures.length) process.exit(1);
})();
