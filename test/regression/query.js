// Regression tests for query, write, CSV and FetchXML-in-code bugs, and the shared panel submit.
// Run with: npm run compile && node test/regression/query.js (LANTERN_OUT=<dir> to test another build).
const Module = require("module");
const path = require("path");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? require.resolve("../mock-vscode") : resolve.call(this, request, ...rest);
};
const OUT = process.env.LANTERN_OUT ? path.resolve(process.env.LANTERN_OUT) : path.join(__dirname, "..", "..", "out");
const out = (m) => require(path.join(OUT, m));
const assert = require("assert");
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

(async () => {
  const query = out("core/query.js");
  const write = out("core/write.js");
  const sql = out("core/sql.js");
  const csv = out("core/csv.js");
  const fic = out("core/fetchInCode.js");

  await test("fetchXmlStart: a run of leading comments doesn't backtrack exponentially", () => {
    // In a child process with a time limit: the old regex takes hours on this, so it has to fail, not hang the run.
    const { spawnSync } = require("child_process");
    const code = `const q = require(${JSON.stringify(path.join(OUT, "core", "query.js"))}); process.stdout.write(String(q.fetchXmlStart('<!-- <add key="x" value="y" /> -->\\n'.repeat(60) + "<configuration/>")));`;
    const r = spawnSync(process.execPath, ["-e", code], { timeout: 5000, encoding: "utf8" });
    assert.strictEqual(r.signal, null, "fetchXmlStart didn't finish in 5 seconds");
    assert.strictEqual(r.stdout, "-1");
    const text = '<?xml version="1.0"?>\n<!-- a -->\n<!-- b - c -->\n<fetch top="5"><entity name="account"/></fetch>';
    assert.strictEqual(query.fetchXmlStart(text), text.indexOf("<fetch"));
  });

  await test("coerce: blank numbers are no value, and a decimal comma is refused instead of read as thousands", () => {
    const decimal = { logicalName: "revenue", type: "Decimal" };
    assert.strictEqual(write.coerce(decimal, "   "), null);
    assert.strictEqual(write.coerce(decimal, "1,000.50"), 1000.5);
    assert.strictEqual(write.coerce(decimal, "-12,345"), -12345);
    assert.strictEqual(write.coerce(decimal, " 5 "), 5);
    assert.throws(() => write.coerce(decimal, "1234,56"), /needs a number/);
    assert.throws(() => write.coerce(decimal, "99,9"), /needs a number/);
    assert.strictEqual(write.coerce({ logicalName: "industrycode", type: "Picklist", options: [{ value: 1, label: "Accounting" }] }, " accounting "), 1);
  });

  await test("owner lookups take systemuser:GUID or team:GUID and bind through ownerid", async () => {
    const ctx = {
      dv: { getJson: async () => ({ value: [{ ReferencingEntityNavigationPropertyName: "ownerid", ReferencedEntity: "owner" }] }) },
      entitySetOf: async (t) => `${t}s`,
    };
    const table = { logicalName: "account" };
    const cols = [{ logicalName: "ownerid", type: "Owner" }];
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    const user = await write.prepareValues(table, cols, [{ column: "ownerid", value: `systemuser:${id}` }], ctx, new write.LookupResolver(ctx));
    assert.deepStrictEqual(user.body, { "ownerid@odata.bind": `/systemusers(${id})` });
    const team = await write.prepareValues(table, cols, [{ column: "ownerid", value: `team:${id}` }], ctx, new write.LookupResolver(ctx));
    assert.deepStrictEqual(team.body, { "ownerid@odata.bind": `/teams(${id})` });
    await assert.rejects(write.prepareValues(table, cols, [{ column: "ownerid", value: id }], ctx, new write.LookupResolver(ctx)), /systemuser or team/);
    const cleared = await write.prepareValues(table, cols, [{ column: "ownerid", value: null }], ctx, new write.LookupResolver(ctx));
    assert.deepStrictEqual(cleared.clears, ["ownerid"], "cleared once, not once per target");
  });

  await test("HAVING binds to the aggregate with the same DISTINCT and table", () => {
    let t = sql.translate("SELECT ownerid, COUNT(name) AS n, COUNT(DISTINCT name) AS d FROM account GROUP BY ownerid HAVING COUNT(DISTINCT name) > 1");
    assert.strictEqual(t.having[0].alias, "d");
    t = sql.translate("SELECT ownerid, COUNT(DISTINCT name) AS d, COUNT(name) AS n FROM account GROUP BY ownerid HAVING COUNT(name) > 1");
    assert.strictEqual(t.having[0].alias, "n");
    t = sql.translate("SELECT a.ownerid, SUM(a.revenue) AS ra, SUM(c.revenue) AS rc FROM account a JOIN account c ON c.parentaccountid = a.accountid GROUP BY a.ownerid HAVING SUM(c.revenue) > 10");
    assert.strictEqual(t.having[0].alias, "rc");
  });

  await test("duplicate aggregate aliases stay valid XML attribute values", () => {
    const t = sql.translate('SELECT COUNT(*) AS [a"b], SUM(revenue) AS [a"b] FROM account');
    const aliases = [...t.fetchXml.matchAll(/alias="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(aliases, ["a_b", "a_b_2"]);
  });

  await test("line breaks in string literals survive in FetchXML attributes", () => {
    const t = sql.translate("SELECT name FROM account WHERE description = 'one\r\ntwo\tthree'");
    assert.match(t.fetchXml, /value="one&#13;&#10;two&#9;three"/);
  });

  await test("a non-pageable result with more records is marked truncated", async () => {
    const ctx = {
      dv: { getJson: async () => ({ value: [{ n: 1 }], "@Microsoft.Dynamics.CRM.morerecords": true }) },
      entitySetOf: async (t) => `${t}s`, primaryIdOf: () => undefined, maxRows: 50000,
    };
    const set = await query.executeFetch("x", '<fetch aggregate="true"><entity name="account"><attribute name="accountid" alias="n" aggregate="count" /></entity></fetch>', "account", "all", false, ctx);
    assert.strictEqual(set.truncated, true);
    const top = await query.executeFetch("x", '<fetch top="1"><entity name="account" /></fetch>', "account", "all", false, ctx);
    assert.strictEqual(top.truncated, false, "TOP asked for fewer rows, so that isn't truncation");
  });

  await test("write statements are recognized after the document's comment header", () => {
    const { isWriteStatement } = out("commands/query.js");
    assert.ok(isWriteStatement("-- Tenant: Acme (DEV)\n-- Run with F5\nUPDATE account SET name = 'x' WHER"));
    assert.ok(isWriteStatement("/* a\n b */ delete FROM account"));
    assert.ok(!isWriteStatement("-- update later\nSELECT name FROM account"));
  });

  await test("CSV: a quote inside an unquoted field is a character, not the start of a quoted field", () => {
    assert.deepStrictEqual(csv.parseCsv('name,description\r\nMonitor A,24" screen\r\nMonitor B,27 inch\r\nMonitor C,32" curved\r\n'), [
      ["name", "description"], ["Monitor A", '24" screen'], ["Monitor B", "27 inch"], ["Monitor C", '32" curved'],
    ]);
    assert.deepStrictEqual(csv.parseCsv('a,b\n"x, ""y""",z\n"multi\nline",2\n'), [["a", "b"], ['x, "y"', "z"], ["multi\nline", "2"]]);
  });

  await test("C# write-back doubles literal braces in interpolated strings and keeps holes", () => {
    assert.strictEqual(fic.encodeLiteral('<fetch><condition value="{8A3B2C1D-0000-0000-0000-000000000000}" />{id}</fetch>', "interpolated", "cs"),
      '$@"<fetch><condition value=""{{8A3B2C1D-0000-0000-0000-000000000000}}"" />{id}</fetch>"');
    assert.strictEqual(fic.encodeLiteral('<fetch v="{{already}}">{name}</fetch>', "interpolated", "cs"), '$@"<fetch v=""{{already}}"">{name}</fetch>"');
    assert.strictEqual(fic.encodeLiteral('<fetch v="{AB-1}">{{x}}</fetch>', "verbatim", "cs"), '$@"<fetch v=""{{AB-1}}"">{x}</fetch>"');
    // What's written reads back as the same FetchXML.
    const code = `var f = ${fic.encodeLiteral('<fetch v="{AB-1}"><entity name="a">{{x}}</entity></fetch>', "verbatim", "cs")};`;
    assert.deepStrictEqual(fic.findFetchLiterals(code, "cs").map((l) => l.text), ['<fetch v="{{AB-1}}"><entity name="a">{x}</entity></fetch>']);
  });

  await test("JSON export keeps columns that share a header", () => {
    const json = JSON.parse(query.toJson({ columns: ["name", "name", "x"], rows: [[{ raw: "A" }, { raw: "B" }, { raw: 1 }]], rowIds: ["r1"] }, false));
    assert.deepStrictEqual(json, [{ name: "A", "name (2)": "B", x: 1 }]);
  });

  await test("CSV import: an ID cell that isn't a GUID fails its row instead of going into the batch request", async () => {
    const src = require("fs").readFileSync(path.join(OUT, "commands", "csvImport.js"), "utf8");
    assert.match(src, /isn't a GUID/, "the import checks IDs before building requests");
  });

  // ---------- the shared panel ----------
  const { openPanel } = out("ui/panels/panel.js");
  const panelOptions = (submit) => ({ viewType: "t", title: "T", subtitle: "", state: { draft: { n: 1 } }, body: "<main></main>", script: "function build() {}", validate: () => ({ problems: [] }), submit, action: "Save" });

  await test("panel: a second submit while one is saving is ignored", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    S.panelAnswers.push(async (state, panel) => {
      const first = panel.webview.send({ type: "submit", draft: state.draft });
      const second = panel.webview.send({ type: "submit", draft: state.draft });
      await new Promise((r) => setTimeout(r, 5));
      release();
      await Promise.all([first, second]);
    });
    const result = await openPanel(panelOptions(async () => { calls++; await gate; return undefined; }));
    assert.deepStrictEqual(result, { n: 1 });
    assert.strictEqual(calls, 1);
  });

  await test("panel: a submit hook that throws shows its message and keeps the page open", async () => {
    let attempts = 0;
    S.panelAnswers.push(async (state, panel) => {
      await panel.webview.send({ type: "submit", draft: state.draft });
      assert.deepStrictEqual(panel.webview.posted.filter((m) => m.type === "note").map((m) => m.text), ["Network down"]);
      assert.ok(!panel.disposed);
      return { type: "submit", draft: state.draft };
    });
    const result = await openPanel(panelOptions(async () => { if (++attempts === 1) throw new Error("Network down"); return undefined; }));
    assert.deepStrictEqual(result, { n: 1 });
    assert.strictEqual(attempts, 2);
  });

  if (S.panelErrors) failures.push(...S.panelErrors.map((e) => `panel answer: ${e.message}`));
  console.log(`${passed} query regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  if (failures.length) process.exitCode = 1;
})();
