// Loads the results panel in a real browser for every kind of result and drives its UI,
// failing on script errors. Needs Playwright (npm install -g playwright); skipped without it.
const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (q, ...a) {
  return q === "vscode" ? require.resolve("./mock-vscode") : resolve.call(this, q, ...a);
};
const fs = require("fs");
const os = require("os");
const path = require("path");
const { renderHtml } = require(path.join(__dirname, "..", "out", "ui", "results.js"));
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  try {
    ({ chromium } = require(path.join(os.homedir(), ".npm-global", "lib", "node_modules", "playwright")));
  } catch {
    console.log("Playwright isn't installed; skipping the results panel browser test.");
    process.exit(0);
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-webview-"));
const base = { fetchXml: "<fetch/>", truncated: false, elapsedMs: 12 };
const nasty = { raw: "</script><img src=x onerror=alert(1)> & \"quotes\" 'single' \u2028 line" };
const outcomes = {
  query: { sets: [{ ...base, source: "SELECT name FROM account", table: "account", columns: ["name", "parentaccountid", "revenue"], rows: [[nasty, { raw: "p1", formatted: "Parent", ref: { table: "account", id: "p1" } }, { raw: 5, formatted: "$5.00" }], [{ raw: null }, { raw: null }, { raw: 0 }]], rowIds: ["a1", "a2"] }], errors: [{ source: "SELECT x", message: "<b>bad</b>" }] },
  empty: { sets: [{ ...base, source: "SELECT name FROM account WHERE 1 = 0", table: "account", columns: ["name"], rows: [], rowIds: [] }], errors: [] },
  truncated: { sets: [{ ...base, truncated: true, source: "SELECT name FROM account", table: "account", columns: ["name"], rows: [[{ raw: "a" }]], rowIds: ["x"] }], errors: [] },
  record: { sets: [{ ...base, kind: "record", record: { table: "account", id: "r1" }, source: "Account r1", table: "account", columns: ["Column", "Logical name", "Type", "Value"], rows: [[{ raw: "Fax" }, { raw: "fax" }, { raw: "String" }, { raw: "555" }]], rowIds: ["r1"] }], errors: [] },
  audit: { sets: [{ ...base, kind: "audit", record: { table: "account", id: "r1" }, source: "Audit", table: "account", columns: ["Changed on", "Changed by", "Event", "Column", "Old value", "New value"], rows: [[{ raw: "2026-01-01" }, { raw: "u", formatted: "User", ref: { table: "systemuser", id: "u" } }, { raw: 2, formatted: "Update" }, { raw: "fax" }, { raw: null }, { raw: "1" }]], rowIds: ["r1"] }], errors: [] },
  write: { sets: [{ ...base, kind: "write", source: "UPDATE account SET fax = '1'", table: "account", columns: ["name", "Result"], rows: [[{ raw: "A" }, { raw: "Updated" }]], rowIds: ["a1"] }], errors: [] },
  report: { sets: [{ ...base, kind: "report", truncated: true, source: "Import preview", table: "account", columns: ["Action", "name"], rows: [[{ raw: "Create" }, { raw: "A" }]], rowIds: [] }], errors: [] },
  errorsOnly: { sets: [], errors: [{ source: "SELECT", message: "Expected a column name" }] },
  nothing: undefined,
  many: { sets: [{ ...base, source: "SELECT name FROM account", table: "account", columns: ["name", "n"], rows: Array.from({ length: 2000 }, (_, i) => [{ raw: `row ${i}` }, { raw: i }]), rowIds: Array.from({ length: 2000 }, (_, i) => `id${i}`) }], errors: [] },
};
(async () => {
  const browser = await chromium.launch();
  let problems = 0;
  for (const [name, outcome] of Object.entries(outcomes)) {
    const html = renderHtml({ cspSource: "x" }, outcome);
    const posted = [];
    const page = await browser.newPage({ viewport: { width: 1000, height: 400 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => { errors.push("DIALOG " + d.message()); d.dismiss(); });
    await page.exposeFunction("__post", (m) => posted.push(m));
    const doc = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "").replace("<head>", "<head><script>window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__post(m),getState(){},setState(){}})</script>");
    const file = path.join(dir, `${name}.html`);
    fs.writeFileSync(file, doc);
    await page.goto("file://" + file);
    const buttons = await page.$$("button");
    for (const b of buttons) {
      if (await b.isVisible()) await b.click().catch((e) => errors.push("click " + e.message));
    }
    const headers = await page.$$("th");
    for (const h of headers.slice(0, 3)) await h.click().catch(() => {});
    if (name === "many") {
      // Sort by the number column, descending (two clicks), then check the first row.
      await page.click("th >> nth=2");
      await page.click("th >> nth=2");
      const first = await page.innerText("tbody tr >> nth=0");
      if (!/row 1999/.test(first)) errors.push("sort descending: " + first);
    }
    const box = await page.$("input[type=checkbox]");
    if (name === "query") {
      const before = await page.innerText("tbody");
      await box.click();
      const after = await page.innerText("tbody");
      if (!before.includes("$5.00") || !after.includes("\t5") || after.includes("$5.00")) errors.push("stored values toggle didn't switch the grid:\n" + before + "\n---\n" + after);
      await box.click();
    } else if (box) await box.click();
    const link = await page.$("a, .ref");
    if (link) await link.click().catch(() => {});
    const text = await page.innerText("body");
    if (name === "query" && !text.includes("</script><img")) errors.push("nasty cell not shown as text");
    if (name === "report" && !/Showing the first 1 rows\.$/m.test(text)) errors.push("report note: " + text);
    if (name === "truncated" && !/raise lantern\.query\.maxRows/.test(text)) errors.push("truncated note missing");
    if (name === "many" && !/2,000 rows/.test(text)) errors.push("count: " + text.slice(0, 80));
    console.log(`${errors.length ? "✗" : "✓"} ${name}: ${buttons.length} buttons, posted ${posted.map((p) => p.cmd).join(",") || "nothing"}${errors.length ? "\n    " + errors.join("\n    ") : ""}`);
    problems += errors.length;
    await page.close();
  }
  await browser.close();
  console.log(problems ? `${problems} problem(s) in the results panel.` : "Results panel works in a browser for every kind of result.");
  process.exit(problems ? 1 : 0);
})();
