// Fake ILSpy command line for the test suite. "--version" answers; "-p -o <dir> [-r <ref>]... <dll>"
// writes an ILSpy-style project: a .csproj (which Lantern replaces), Properties/AssemblyInfo.cs, and
// one .cs per class in a folder per namespace. Class bodies come from the source the fake dotnet
// build stored after the PE image; DLLs without it get a stub body.
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
fs.appendFileSync(process.env.DVW_LOG, `ilspycmd ${args.join(" ")}\n`);
if (args[0] === "--version") {
  console.log("ilspycmd: 9.1.0.7988\nICSharpCode.Decompiler: 9.1.0.7988");
  process.exit(0);
}
const out = args[args.indexOf("-o") + 1];
const dll = args[args.length - 1];
const bytes = fs.readFileSync(dll);
const { readAssembly } = require(path.join(__dirname, "..", "..", "out", "core", "assembly.js"));
const meta = readAssembly(bytes);
const marker = bytes.indexOf("\0LANTERN-FAKE-SOURCES\0");
const sources = marker >= 0 ? JSON.parse(bytes.subarray(marker + 22).toString("utf8")) : {};

fs.mkdirSync(path.join(out, "Properties"), { recursive: true });
fs.writeFileSync(path.join(out, `${meta.name}.csproj`), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><AssemblyName>${meta.name}</AssemblyName><TargetFramework>net462</TargetFramework></PropertyGroup><ItemGroup><Reference Include="Microsoft.Xrm.Sdk"><HintPath>C:\\somewhere\\Microsoft.Xrm.Sdk.dll</HintPath></Reference></ItemGroup></Project>\n`);
fs.writeFileSync(path.join(out, "Properties", "AssemblyInfo.cs"), `using System.Reflection;\n\n[assembly: AssemblyVersion("${meta.version}")]\n`);
const names = Object.keys(sources).length ? Object.keys(sources) : meta.pluginClasses.map((c) => c.typeName);
for (const typeName of names) {
  const ns = typeName.includes(".") ? typeName.slice(0, typeName.lastIndexOf(".")) : "";
  const name = typeName.slice(typeName.lastIndexOf(".") + 1);
  const body = sources[typeName] ?? `public class ${name} : IPlugin\n{\n\tpublic void Execute(IServiceProvider serviceProvider)\n\t{\n\t}\n}`;
  const indented = body.split("\n").map((l) => (l.trim() ? `\t${l.trim()}` : l)).join("\n");
  const text = `using System;\nusing Microsoft.Xrm.Sdk;\n\n${ns ? `namespace ${ns};\n\n` : ""}${indented}\n`;
  const folder = path.join(out, ns || ".");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${name}.cs`), text);
}
console.log(`Decompiled ${meta.name} to ${out}`);
