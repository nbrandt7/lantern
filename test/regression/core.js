// Regression tests for core plumbing: the assembly reader, the metadata cache and Web API throttling.
// Run with: npm run compile && node test/regression/core.js (LANTERN_OUT=<dir> to test another build).
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
const { spawnSync } = require("child_process");

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
  await test("assembly: every truncation of a DLL is refused as not an assembly, never a hang or a raw RangeError", () => {
    // In a child process with a time limit: the old reader looped forever on some of these.
    const script = `
      const asm = require(${JSON.stringify(path.join(OUT, "core", "assembly.js"))});
      const { writeAssembly } = require(${JSON.stringify(path.join(__dirname, "..", "fakes", "assembly-writer.js"))});
      const dll = writeAssembly({ name: "Acme.Plugins", version: "1.0.0.0", types: [
        { ns: "Acme", name: "AccountPlugin", interfaces: ["IPlugin"] }, { ns: "Acme", name: "Copy", base: "CodeActivity" } ] });
      const whole = JSON.stringify(asm.readAssembly(dll));
      const bad = [];
      for (let n = 0; n < dll.length; n++) {
        try {
          const r = JSON.stringify(asm.readAssembly(dll.subarray(0, n)));
          if (r !== whole) bad.push(n + ": read different data");
        } catch (e) {
          if (!(e instanceof asm.NotAnAssemblyError)) bad.push(n + ": " + e.constructor.name + " " + e.message);
        }
      }
      process.stdout.write(JSON.stringify({ size: dll.length, bad: bad.slice(0, 5), count: bad.length }));`;
    const r = spawnSync(process.execPath, ["-e", script], { timeout: 30000, encoding: "utf8" });
    assert.strictEqual(r.signal, null, "reading truncated DLLs didn't finish in 30 seconds (a hang)");
    assert.strictEqual(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.strictEqual(result.count, 0, `of ${result.size} truncations, ${result.count} went wrong, e.g. ${result.bad.join("; ")}`);
  });

  const { MetadataService } = out("core/metadata.js");
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lantern-meta-"));
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  await test("metadata: a visible load that fails isn't retried once per caller waiting on it", async () => {
    let asked = 0;
    const svc = new MetadataService(dir(), () => {
      asked++;
      return { getAll: async () => { await tick(); throw new Error("Sign-in was cancelled."); } };
    });
    const results = await Promise.allSettled([svc.tables(), svc.tables(), svc.tables(), svc.tables(), svc.tables()]);
    assert.ok(results.every((r) => r.status === "rejected"));
    assert.strictEqual(asked, 1, "one sign-in for all five");
    // A silent load in flight still lets a visible caller try properly once.
    asked = 0;
    await Promise.allSettled([svc.tables({ silent: true }), svc.tables()]);
    assert.strictEqual(asked, 2);
  });

  await test("metadata: Refresh during a slow load fetches again instead of keeping the old answer", async () => {
    let tables = [{ LogicalName: "account", SchemaName: "Account", DisplayName: {} }];
    let release;
    const gate = new Promise((r) => { release = r; });
    const folder = dir();
    const svc = new MetadataService(folder, () => ({
      getAll: async () => {
        const snapshot = tables;
        await gate;
        return snapshot;
      },
    }));
    const slow = svc.tables();
    await tick();
    tables = [...tables, { LogicalName: "new_project", SchemaName: "new_Project", DisplayName: {} }];
    svc.forget("tables");
    release();
    await slow;
    const after = await svc.tables();
    assert.deepStrictEqual(after.map((t) => t.logicalName).sort(), ["account", "new_project"]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(folder, "tables.json"), "utf8")).data.map((t) => t.logicalName).sort();
    assert.deepStrictEqual(onDisk, ["account", "new_project"]);
  });

  await test("web api: a 429 asking for longer than the cap fails once, without early retries", async () => {
    const dvMod = out("core/dataverse.js");
    const realFetch = global.fetch;
    const realSleep = dvMod.timing.sleep;
    const waits = [];
    let fetches = 0;
    dvMod.timing.sleep = async (ms) => void waits.push(ms);
    global.fetch = async () => {
      fetches++;
      return { ok: false, status: 429, headers: { get: (h) => (h === "Retry-After" ? "300" : null) }, json: async () => ({}) };
    };
    try {
      const client = new dvMod.DataverseClient("https://a.crm.dynamics.com", async () => "t");
      const before = Date.now();
      await assert.rejects(client.getJson("x"), /asked to wait 5 minutes/);
      assert.strictEqual(fetches, 1);
      assert.deepStrictEqual(waits, []);
      assert.ok(client.throttledUntil >= before + 300_000);
    } finally {
      global.fetch = realFetch;
      dvMod.timing.sleep = realSleep;
    }
  });

  await test("web resources: a configured root named like build output (dist) is scanned for files", () => {
    const { webResourceFiles } = out("core/solutions.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-wr-"));
    fs.mkdirSync(path.join(root, "dist", "new_", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "new_", "scripts", "account.js"), "");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "page.html"), "");
    fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "x", "index.js"), "");
    const client = { dir: root, config: { webResourceRoots: ["dist"] } };
    const found = webResourceFiles(client).map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
    assert.deepStrictEqual(found, ["dist/new_/scripts/account.js", "src/page.html"]);
  });

  console.log(`${passed} core regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  if (failures.length) process.exitCode = 1;
})();
