// Fake Power Platform CLI for the test suite. Logs every call and simulates the commands the extension uses.
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
fs.appendFileSync(process.env.DVW_LOG, `pac ${args.join(" ")}\n`);
const profiles = process.env.DVW_PROFILES;
const GUID = "0f8a3c1e-1234-4abc-9def-1234567890ab";
const readProfiles = () =>
  (fs.existsSync(profiles) ? fs.readFileSync(profiles, "utf8").split(/\r?\n/) : [])
    .filter(Boolean)
    .map((l) => ({ name: l.split(" ")[0], user: l.split(" ")[1] || "nathan@acme.com" }));
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

switch (`${args[0]} ${args[1]}`) {
  case "solution export": {
    const out = args[args.indexOf("--path") + 1];
    write(out, `zip of ${args[args.indexOf("--name") + 1]}${args.includes("--managed") ? " (managed)" : ""}`);
    break;
  }
  case "solution import":
    console.log("imported");
    break;
  case "solution check": {
    const { writeZip } = require(path.join(__dirname, "..", "..", "out", "core", "zip.js"));
    const sarif = { runs: [{
      tool: { driver: { rules: [{ id: "web-use-strict-equality-operators", shortDescription: { text: "Use strict equality operators" }, helpUri: "https://learn.microsoft.com/rules/strict" }] } },
      results: [
        { ruleId: "web-use-strict-equality-operators", level: "warning", message: { text: "Use === instead of ==" }, locations: [{ physicalLocation: { artifactLocation: { uri: "WebResources/cr36f_AccountFormOnLoad" }, region: { startLine: 6 } } }] },
        { ruleId: "meta-avoid-silverlight", level: "error", message: { text: "Silverlight isn't supported" }, locations: [{ physicalLocation: { artifactLocation: { uri: "Other/Customizations.xml" } } }] },
      ],
    }] };
    const out = args[args.indexOf("--outputDirectory") + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "results.zip"), writeZip([{ name: "AcmeCore.sarif", data: Buffer.from(JSON.stringify(sarif)) }]));
    break;
  }
  case "solution pack": {
    write(args[args.indexOf("--zipfile") + 1], `packed ${args[args.indexOf("--folder") + 1]}`);
    break;
  }
  case "plugin init": {
    const out = args[args.indexOf("--outputDirectory") + 1];
    const name = path.basename(out);
    write(path.join(out, `${name}.csproj`), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><RootNamespace>${name}</RootNamespace></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2" /></ItemGroup></Project>`);
    write(path.join(out, "PluginBase.cs"), "public abstract class PluginBase : IPlugin { }");
    break;
  }
  case "pcf init": {
    const out = args[args.indexOf("--outputDirectory") + 1];
    const name = args[args.indexOf("--name") + 1];
    write(path.join(out, "package.json"), JSON.stringify({ name, scripts: { build: "pcf-scripts build", start: "pcf-scripts start" } }));
    write(path.join(out, `${name}.pcfproj`), "<Project />");
    write(path.join(out, name, "ControlManifest.Input.xml"), `<manifest><control namespace="${args[args.indexOf("--namespace") + 1]}" constructor="${name}" version="0.0.1" control-type="${args[args.indexOf("--framework") + 1] === "react" ? "virtual" : "standard"}" /></manifest>`);
    break;
  }
  case "pcf push":
    fs.appendFileSync(process.env.DVW_LOG, `  (in ${process.cwd()})\n`);
    console.log("pushed");
    break;
  case "pages list":
    console.log("Index Website Id                           Friendly Name\n[1]   aaaa1111-2222-3333-4444-555555555555 Contoso Portal\n[2]   bbbb1111-2222-3333-4444-555555555555 Partner Site");
    break;
  case "pages download": {
    const out = args[args.indexOf("--path") + 1];
    write(path.join(out, "contoso-portal---contoso-portal", "website.yml"), "adx_name: Contoso Portal\n");
    break;
  }
  case "pages upload":
    console.log("uploaded");
    break;
  case "auth select": {
    process.exit(readProfiles().some((p) => p.name === args[3]) ? 0 : 1);
  }
  case "auth create":
    // The browser sign-in picks an account; tests choose it with DVW_PAC_USER.
    fs.appendFileSync(profiles, `${args[3]} ${process.env.DVW_PAC_USER || "nathan@acme.com"}\n`);
    console.log("signed in");
    break;
  case "auth delete":
    fs.writeFileSync(profiles, readProfiles().filter((p) => p.name !== args[3]).map((p) => `${p.name} ${p.user}\n`).join(""));
    break;
  case "auth list":
    console.log("Index Active Kind      Name            User                    Cloud  Type Environment Environment Url");
    readProfiles().forEach((p, i) => console.log(`[${i + 1}]   ${i === 0 ? "*" : " "}      UNIVERSAL ${p.name.padEnd(15)} ${p.user.padEnd(23)} Public User Acme Dev    https://acme.crm.dynamics.com/`));
    break;
  case "solution sync": {
    const d = args[3];
    write(path.join(d, "src/WebResources/acme_/scripts/account.js"), "// dataverse version\n");
    write(path.join(d, "src/WebResources/acme_/scripts/contact.js"), "// only in dataverse\n");
    write(path.join(d, `src/PluginAssemblies/AcmePlugins-${GUID}/AcmePlugins.dll`), Buffer.from("MZ\0binary"));
    const solutionXml = path.join(d, "src/Other/Solution.xml");
    fs.writeFileSync(solutionXml, fs.readFileSync(solutionXml, "utf8").replace("1.0.0.0", "1.0.0.1"));
    break;
  }
  case "modelbuilder build":
    write(path.join(args[3], "Entities.cs"), "// generated\n");
    break;
}
process.exit(0);
