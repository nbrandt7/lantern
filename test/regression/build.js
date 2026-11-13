// Regression tests for zips Dataverse imports, pac profiles and PCF pushes, running CLIs (cancelling,
// missing tools, output decoding, Windows quoting), JSON files, web resource roots, and the form script
// and PCF templates.
// Run with: npm run compile && node test/regression/build.js (LANTERN_OUT=<dir> to test another build).
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
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const vscode = require("../mock-vscode");
const S = vscode.__state;

const isWindows = process.platform === "win32";
const BS = "\\";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-build-"));
let n = 0;
const tmp = () => {
  const dir = path.join(scratch, `t${++n}`);
  fs.mkdirSync(dir);
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const script = (name, source) => {
  const file = path.join(tmp(), name);
  fs.writeFileSync(file, source);
  return file;
};
/** A CLI the way Lantern meets one: a .cmd shim on Windows (so it runs under cmd.exe), a sh script elsewhere. */
function fakeCli(name, source) {
  const dir = tmp();
  const js = path.join(dir, `${name}.js`);
  fs.writeFileSync(js, source);
  if (isWindows) {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}
/** A cancellation token like VS Code's. */
function token() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.push(listener);
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const l of [...listeners]) l();
    },
  };
}
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : []);

// CRC-32 and a zip writer of the tests' own, so Lantern's zips are checked against an independent implementation.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data) => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const crc = e.crc ?? crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n${String(err.stack).split("\n").slice(0, 6).join("\n")}`);
  }
}

(async () => {
  // ---------- zips ----------
  const zip = out("core/zip.js");

  await test("zip: writeZip records each entry's CRC-32 and UTF-8 name flag in the local and central headers", () => {
    const entries = [
      { name: "[Content_Types].xml", data: Buffer.from("<Types />") },
      { name: "WebResources/é.js", data: Buffer.from("var x;") },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ];
    const z = zip.writeZip(entries);
    let p = 0;
    for (const e of entries) {
      assert.strictEqual(z.readUInt32LE(p), 0x04034b50);
      assert.strictEqual(z.readUInt32LE(p + 14), crc32(e.data), `local header CRC of ${e.name}`);
      assert.ok(z.readUInt16LE(p + 6) & 0x0800, `local header UTF-8 flag of ${e.name}`);
      p += 30 + z.readUInt16LE(p + 26) + z.readUInt16LE(p + 28) + z.readUInt32LE(p + 18);
    }
    for (const e of entries) {
      assert.strictEqual(z.readUInt32LE(p), 0x02014b50);
      assert.strictEqual(z.readUInt32LE(p + 16), crc32(e.data), `central header CRC of ${e.name}`);
      assert.ok(z.readUInt16LE(p + 8) & 0x0800, `central header UTF-8 flag of ${e.name}`);
      p += 46 + z.readUInt16LE(p + 28) + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32);
    }
    assert.deepStrictEqual(zip.readZip(z).map((e) => e.name), entries.map((e) => e.name));
  });

  await test("zip: readZip rejects an entry whose CRC doesn't match, stored or deflated", () => {
    const data = Buffer.from("<ImportExportXml />".repeat(20));
    const good = zip.readZip(zipOf([{ name: "a.xml", data }, { name: "b.xml", data, deflate: true }]));
    assert.deepStrictEqual(good.map((e) => e.data.toString()), [data.toString(), data.toString()]);
    assert.throws(() => zip.readZip(zipOf([{ name: "a.xml", data, crc: 0 }])), /a\.xml.*CRC/);
    assert.throws(() => zip.readZip(zipOf([{ name: "b.xml", data, deflate: true, crc: (crc32(data) ^ 1) >>> 0 }])), /b\.xml.*CRC/);
  });

  const tar = path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe");
  if (isWindows && fs.existsSync(tar)) {
    await test("zip: Windows tar (bsdtar) extracts a solution zip writeZip wrote", () => {
      const file = path.join(tmp(), "solution.zip");
      fs.writeFileSync(file, zip.writeZip([{ name: "solution.xml", data: Buffer.from("<ImportExportXml />") }, { name: "customizations.xml", data: Buffer.from("<x />") }]));
      const r = spawnSync(tar, ["-xOf", file], { encoding: "utf8" });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout, "<ImportExportXml /><x />");
    });
  }

  // ---------- pac ----------
  const pac = out("core/pac.js");
  const client = (name, envName, org, appId = "") => ({ name, envName, config: { org, appId, account: "" } });

  await test("pac: a long client name gets a profile per environment; names that fit keep theirs", () => {
    const long = "contoso-customer-engagement-dynamics";
    const dev = pac.profileName(client(long, "DEV", "https://contoso-dev.crm.dynamics.com"));
    const prod = pac.profileName(client(long, "PROD", "https://contoso.crm.dynamics.com"));
    assert.notStrictEqual(dev, prod, "DEV and PROD shared a pac profile");
    for (const name of [dev, prod]) assert.match(name, /^[A-Za-z0-9]{30}$/);
    assert.strictEqual(pac.profileName(client(long, "DEV", "https://contoso-dev.crm.dynamics.com")), dev, "the same environment finds its profile again");
    const emea = pac.profileName(client(`${long}-emea`, "DEV", "https://emea.crm4.dynamics.com"));
    const apac = pac.profileName(client(`${long}-apac`, "DEV", "https://apac.crm5.dynamics.com"));
    assert.notStrictEqual(emea, apac, "names that differ only after the cut");
    assert.strictEqual(pac.profileName(client("acme-dynamics", "TEST", "https://acme.crm.dynamics.com")), "acmedynamicsTEST");
    assert.strictEqual(pac.profileName(client("x".repeat(26), "PROD", "https://x.crm.dynamics.com")), `${"x".repeat(26)}PROD`);
    const app = pac.profileName(client(long, "PROD", "https://contoso.crm.dynamics.com", "abcd1234-0000"));
    assert.ok(app.endsWith("appabcd") && app.length === 30, app);
  });

  await test("pac: pcf push names the environment, run from the control's folder", async () => {
    const log = path.join(tmp(), "pac.log");
    const fake = fakeCli("pac", `require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + require("os").EOL);`);
    const controlDir = tmp();
    await pac.pcfPush({ pacPath: fake, log: () => {} }, client("acme", "PROD", "https://acme.crm.dynamics.com"), controlDir, "acme");
    const calls = lines(log).map((l) => JSON.parse(l));
    assert.deepStrictEqual(calls.map((c) => c.args), [["pcf", "push", "--publisher-prefix", "acme", "--environment", "https://acme.crm.dynamics.com"]]);
    assert.strictEqual(fs.realpathSync.native(calls[0].cwd), fs.realpathSync.native(controlDir));
  });

  await test("pac: cancelling pac auth select stops there instead of opening a sign-in", async () => {
    const log = path.join(tmp(), "pac.log");
    const fake = fakeCli(
      "pac",
      `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + require("os").EOL);
if (process.argv[3] === "select") setTimeout(() => process.exit(1), 4000);`
    );
    const t = token();
    const said = [];
    setTimeout(() => t.cancel(), 400);
    await assert.rejects(pac.ensureAuth({ pacPath: fake, log: (x) => said.push(x), token: t }, client("acme", "DEV", "https://acme-dev.crm.dynamics.com")), /Cancelled/);
    await sleep(500);
    assert.deepStrictEqual(lines(log).filter((l) => !l.startsWith("auth select")), [], "pac went on after the cancelled select");
    assert.doesNotMatch(said.join(""), /Creating pac auth profile/);
  });

  // ---------- running CLIs ----------
  const { run } = out("core/process.js");

  await test("process: nothing starts once the token is cancelled", async () => {
    const marker = path.join(tmp(), "ran");
    const fake = fakeCli("tool", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    const t = token();
    t.isCancellationRequested = true;
    const r = await run(fake, ["x"], { token: t });
    assert.strictEqual(fs.existsSync(marker), false, "the tool ran");
    assert.strictEqual(r.code, -1);
    assert.strictEqual(r.missing, false);
  });

  if (isWindows) {
    await test("process: cancelling on Windows ends the tool cmd.exe started, not just cmd.exe", async () => {
      const finished = path.join(tmp(), "finished");
      const sleeper = script("sleeper.js", `process.stdout.write("started " + process.pid);
setTimeout(() => require("fs").writeFileSync(${JSON.stringify(finished)}, "x"), 4000);`);
      const t = token();
      let pid;
      // Cancelled once the tool itself is running: before that, killing cmd.exe alone was enough.
      const onOutput = (text) => {
        const m = /started (\d+)/.exec(text);
        if (m) (pid = Number(m[1])), t.cancel();
      };
      await run(process.execPath, [sleeper], { token: t, onOutput });
      assert.strictEqual(fs.existsSync(finished), false, "run waited for the tool to finish");
      const alive = () => {
        try {
          return process.kill(pid, 0);
        } catch {
          return false;
        }
      };
      assert.ok(pid && !alive(), "the tool kept running after cancel");
    });
  }

  await test("process: a UTF-8 character split across two chunks decodes whole", async () => {
    const child = script(
      "split.js",
      `const euro = Buffer.from([0xe2, 0x82, 0xac, 0x0a]);
process.stdout.write(euro.subarray(0, 2));
process.stderr.write(euro.subarray(0, 1));
setTimeout(() => { process.stdout.write(euro.subarray(2)); process.stderr.write(euro.subarray(1)); }, 300);`
    );
    const seen = [];
    const r = await run(process.execPath, [child], { onOutput: (text) => seen.push(text) });
    assert.strictEqual(r.stdout, "€\n");
    assert.strictEqual(r.stderr, "€\n");
    assert.ok(!seen.join("").includes("\uFFFD"), "the output panel got replacement characters");
  });

  if (isWindows) {
    await test("process: a command a script can't find doesn't make the script itself missing", async () => {
      const shim = path.join(tmp(), "build.cmd");
      fs.writeFileSync(shim, "@lantern-no-such-tool-4f2a build\r\n");
      const nested = await run(shim, []);
      assert.match(nested.stderr, /'lantern-no-such-tool-4f2a' is not recognized/);
      assert.strictEqual(nested.missing, false, "npm run build failing inside was reported as npm missing");
      const bare = await run("lantern-no-such-tool-4f2a", ["x"]);
      assert.strictEqual(bare.missing, true, "a command that isn't on PATH");
    });
  }

  await test("process: a configured path that isn't there is missing; a folder that isn't there says so", async () => {
    const nowhere = path.join(tmp(), "nope");
    const r = await run(path.join(nowhere, isWindows ? "pac.exe" : "pac"), ["auth", "list"]);
    assert.strictEqual(r.missing, true, JSON.stringify(r));
    const seen = [];
    const inMissingFolder = await run(process.execPath, ["-v"], { cwd: nowhere, onOutput: (text) => seen.push(text) });
    assert.strictEqual(inMissingFolder.missing, false, "node is there; the folder isn't");
    assert.match(inMissingFolder.stderr, /folder .*nope.* doesn't exist/);
    assert.match(seen.join(""), /doesn't exist/, "the reason reaches the output panel");
    const fake = fakeCli("tool", "process.stdout.write('ran');");
    const extensionless = await run(isWindows ? fake.replace(/\.cmd$/, "") : fake, []);
    assert.deepStrictEqual([extensionless.code, extensionless.stdout, extensionless.missing], [0, "ran", false], "C:/tools/pac runs pac.cmd");
  });

  if (isWindows) {
    await test("process: Windows quoting keeps trailing backslashes, quotes and %VAR% as given", async () => {
      const argv = script("argv.js", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const args = [`C:${BS}My Folder${BS}`, "%PATH%", "100%", `a${BS}"b`, `a${BS}%b`, "x %OS% y", 'say "hi"', "a&b|c", `${BS}${BS}server${BS}share${BS}`, ""];
      const r = await run(process.execPath, [argv, ...args]);
      assert.deepStrictEqual(JSON.parse(r.stdout), args);
    });
  }

  // ---------- JSON files ----------
  const files = out("core/files.js");

  await test("files: readJson takes a file saved with a byte order mark", () => {
    const file = path.join(tmp(), "config.json");
    fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ defaultTenant: "acme" }));
    assert.deepStrictEqual(files.readJson(file), { defaultTenant: "acme" });
  });

  await test("files: writeJson replaces the file whole instead of rewriting it in place", () => {
    const dir = tmp();
    const file = path.join(dir, "tenants.json");
    fs.writeFileSync(file, JSON.stringify({ tenants: ["a"] }));
    const before = path.join(dir, "before.json");
    fs.linkSync(file, before); // shares the file's contents until it's replaced
    files.writeJson(file, { tenants: ["a", "b"] });
    assert.deepStrictEqual(files.readJson(file), { tenants: ["a", "b"] });
    assert.deepStrictEqual(files.readJson(before), { tenants: ["a"] }, "written in place, where another window can read it half-written");
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["before.json", "tenants.json"], "a temp file was left behind");
    files.writeJson(path.join(dir, "new.json"), [1]);
    assert.deepStrictEqual(files.readJson(path.join(dir, "new.json")), [1]);
    let link = path.join(dir, "link.json");
    try {
      fs.symlinkSync(file, link);
    } catch {
      link = undefined; // creating symlinks needs Developer Mode on Windows
    }
    if (link) {
      files.writeJson(link, { tenants: [] });
      assert.ok(fs.lstatSync(link).isSymbolicLink(), "a symlinked file stays a symlink");
      assert.deepStrictEqual(files.readJson(file), { tenants: [] });
    }
  });

  // ---------- web resources ----------
  await test("web resources: a webResourceRoots folder named like build output (dist) still holds web resources", () => {
    const { isWebResourceCandidate } = out("core/solutions.js");
    const dir = tmp();
    const c = { dir, config: { webResourceRoots: ["dist"] } };
    const at = (rel) => isWebResourceCandidate(path.join(dir, ...rel.split("/")), c);
    assert.strictEqual(at("dist/new_/scripts/account.js"), true);
    assert.strictEqual(at("dist/node_modules/lib/x.js"), false, "tooling folders inside the root are still skipped");
    assert.strictEqual(at("out/new_/account.js"), false, "build output outside the root is still skipped");
    assert.strictEqual(at("WebResources/new_/account.js"), true);
  });

  // ---------- templates ----------
  await test("form scripts: a dotted namespace or one starting with a digit still gives a script that runs", () => {
    const { formScript } = out("core/templates.js");
    for (const [namespace, full] of [["Contoso", "Contoso.Account"], ["Contoso.Sales", "Contoso.Sales.Account"], ["365Retail", "_365Retail.Account"]]) {
      const code = formScript({ namespace, entity: "account", entityPascal: "Account" });
      assert.ok(code.includes(`as ${full}.onLoad / ${full}.onSave`), code);
      const handlers = new Function(`${code}\nreturn ${full};`)();
      assert.deepStrictEqual(Object.keys(handlers), ["onLoad", "onSave"], namespace);
    }
    assert.match(formScript({ namespace: "Contoso", entity: "account", entityPascal: "Account" }), /var Contoso = Contoso \|\| \{\};\n\nContoso\.Account = \(function/);
  });

  await test("PCF: New PCF Control takes only names pac pcf init accepts", async () => {
    const { registerPcfAndPages } = out("commands/pcfPages.js");
    const clients = out("core/clients.js");
    const tenants = out("ui/tenantContext.js");
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".lantern"));
    fs.writeFileSync(path.join(dir, ".lantern", "config.json"), JSON.stringify({ org: "https://acme.crm.dynamics.com" }));
    tenants.selectTenant(clients.readClient(dir));
    const registered = registerPcfAndPages(() => {});
    let namespaceBox;
    let nameBox;
    S.inputAnswers.push((box) => ((namespaceBox = box), "Acme"), (box) => ((nameBox = box), undefined));
    try {
      await S.commands.get("lantern.pcf.new")();
    } finally {
      registered.forEach((d) => d.dispose());
      tenants.selectTenant(undefined);
    }
    const accepts = (box, value) => box.validateInput(value) === undefined;
    for (const v of ["Acme", "Acme.Controls", "A1.B2c"]) assert.ok(accepts(namespaceBox, v), `namespace ${v}`);
    for (const v of ["Acme_Corp", "_Acme", "1Acme", "Acme..X", "Acme.", ".Acme", "Acme.1X"]) assert.ok(!accepts(namespaceBox, v), `namespace ${v}`);
    for (const v of ["Stars", "Stars2"]) assert.ok(accepts(nameBox, v), `name ${v}`);
    for (const v of ["My_Control", "_Stars", "2Stars", "Star-s"]) assert.ok(!accepts(nameBox, v), `name ${v}`);
    assert.strictEqual(fs.existsSync(path.join(dir, "PCF")), false);
  });

  console.log(`${passed} build regression tests passed${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}.`);
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    // a killed process can hold its folder for a moment on Windows
  }
  if (failures.length) process.exitCode = 1;
})();
