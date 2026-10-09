// Fake .NET CLI for the test suite.
//  - "build <proj> -c <cfg>" compiles, after a fashion: it reads the project's C# for classes,
//    base classes and [assembly: AssemblyVersion], and writes a real .NET assembly (metadata
//    only) to bin/<cfg>/net462. Signing uses the project's .snk. Each class's source rides
//    along after the PE image so the fake ilspycmd can "decompile" it. Package projects
//    (Microsoft.PowerApps.MSBuild.Plugin) also get a .nupkg. "#error" in a .cs fails the build.
//  - "tool install --global ilspycmd" puts the fake ilspycmd on PATH.
const fs = require("fs");
const path = require("path");
const { writeAssembly } = require("./assembly-writer");

const args = process.argv.slice(2);
fs.appendFileSync(process.env.DVW_LOG, `dotnet ${args.join(" ")}\n`);

if (args[0] === "tool" && args.includes("ilspycmd")) {
  const bin = process.env.DVW_BIN;
  const script = path.join(__dirname, "ilspycmd.js");
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "ilspycmd.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, "ilspycmd"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(path.join(bin, "ilspycmd"), 0o755);
  }
  console.log("You can invoke the tool using the following command: ilspycmd\nTool 'ilspycmd' was successfully installed.");
  process.exit(0);
}

if (args[0] === "build") {
  const csproj = args[1];
  const configuration = args[args.indexOf("-c") + 1] || "Debug";
  const dir = path.dirname(csproj);
  const xml = fs.readFileSync(csproj, "utf8");
  const tag = (name) => (new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i").exec(xml) || [])[1];
  const assemblyName = tag("AssemblyName") || path.basename(csproj, ".csproj");

  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!["bin", "obj"].includes(e.name)) walk(path.join(d, e.name)); }
      else if (e.name.endsWith(".cs")) files.push(path.join(d, e.name));
    }
  };
  walk(dir);

  let version = tag("AssemblyVersion") || tag("Version") || "1.0.0.0";
  const classes = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (/^\s*#error/m.test(text)) {
      console.error(`${f}(1,1): error CS1029: #error`);
      process.exit(1);
    }
    const v = /\[assembly:\s*(?:System\.Reflection\.)?AssemblyVersion\("([^"]+)"\)\]/.exec(text);
    if (v) version = v[1];
    const ns = (/\bnamespace\s+([\w.]+)/.exec(text) || [])[1] || "";
    const re = /((?:public|internal|abstract|sealed|partial|static|\s)*)\bclass\s+(\w+)\s*(?::\s*([^{]+))?\{/g;
    let m;
    while ((m = re.exec(text))) {
      const mods = m[1];
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}" && --depth === 0) break;
      }
      const bases = (m[3] || "").split(",").map((b) => b.trim().split(".").pop()).filter(Boolean);
      classes.push({ ns, name: m[2], public: /\bpublic\b/.test(mods), abstract: /\babstract\b/.test(mods) || /\bstatic\b/.test(mods), bases, source: text.slice(m.index, end + 1) });
    }
  }
  const local = new Set(classes.map((c) => c.name));
  const types = classes.map((c) => {
    const base = c.bases.find((b) => b === "CodeActivity" || b === "Entity" || local.has(b));
    const interfaces = c.bases.filter((b) => b === "IPlugin");
    return { ns: c.ns, name: c.name, public: c.public, abstract: c.abstract, base, interfaces };
  });
  // base classes must be declared before the classes that use them? Not in metadata; any order works.

  let publicKey;
  if (/<SignAssembly>\s*true/i.test(xml)) {
    const keyRel = tag("AssemblyOriginatorKeyFile");
    const keyFile = keyRel && path.resolve(dir, keyRel.replace(/\\/g, path.sep));
    if (!keyFile || !fs.existsSync(keyFile)) {
      console.error(`error CS7027: Error signing output with public key from file '${keyRel}' -- File not found.`);
      process.exit(1);
    }
    const { readKeyFile } = require(path.join(__dirname, "..", "..", "out", "core", "strongname.js"));
    publicKey = readKeyFile(fs.readFileSync(keyFile)).publicKey;
  }

  const dll = writeAssembly({ name: assemblyName, version: version.replace(/\*/g, "0"), publicKey, types });
  const sources = Object.fromEntries(classes.map((c) => [`${c.ns ? `${c.ns}.` : ""}${c.name}`, c.source]));
  const output = Buffer.concat([dll, Buffer.from(`\0LANTERN-FAKE-SOURCES\0${JSON.stringify(sources)}`)]);
  const out = path.join(dir, "bin", configuration, "net462");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${assemblyName}.dll`), output);

  if (/Microsoft\.PowerApps\.MSBuild\.Plugin/.test(xml)) {
    const { writeZip } = require(path.join(__dirname, "..", "..", "out", "core", "zip.js"));
    const id = tag("PackageId") || assemblyName;
    const pkgVersion = tag("Version") || "1.0.0";
    const nuspec = `<?xml version="1.0"?><package><metadata><id>${id}</id><version>${pkgVersion}</version></metadata></package>`;
    const entries = [{ name: `${id}.nuspec`, data: Buffer.from(nuspec) }, { name: `lib/net462/${assemblyName}.dll`, data: output }];
    for (const lib of fs.existsSync(path.join(dir, "lib")) ? fs.readdirSync(path.join(dir, "lib")) : []) {
      entries.push({ name: `lib/net462/${lib}`, data: fs.readFileSync(path.join(dir, "lib", lib)) });
    }
    fs.writeFileSync(path.join(dir, "bin", configuration, `${id}.${pkgVersion}.nupkg`), writeZip(entries));
  }
  console.log(`  ${assemblyName} -> ${path.join(out, `${assemblyName}.dll`)}`);
}
process.exit(0);
