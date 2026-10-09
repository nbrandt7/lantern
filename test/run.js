// Headless end-to-end test: real git, fake pac/dotnet, fake Dataverse Web API, mock vscode.
// Run with: npm run compile && node test/run.js
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const Module = require("module");

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return require.resolve("./mock-vscode");
  return realResolve.call(this, request, ...rest);
};
const vscode = require("./mock-vscode");
const S = vscode.__state;

const GUID = "0f8a3c1e-1234-4abc-9def-1234567890ab";
/** Matches either path separator, so CLI-log assertions work on Windows too. */
const SEP = "[\\\\/]";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dvw-test-"));
const bin = path.join(tmp, "bin");
const root = path.join(tmp, "workspace");
const logFile = path.join(tmp, "cli.log");
fs.mkdirSync(bin);
fs.mkdirSync(root);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.DVW_LOG = logFile;
process.env.DVW_BIN = bin;
process.env.DVW_PROFILES = path.join(tmp, "profiles");

// ---------- fake CLIs ----------
// Node scripts behind a per-platform shim: a .cmd on Windows (found before the real
// pac/dotnet because this folder is first on PATH), a sh wrapper elsewhere.
for (const name of ["pac", "dotnet", "tsc", "npm"]) {
  const script = path.join(__dirname, "fakes", `${name}.js`);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
}
const cliLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");

// ---------- fake ADO repo ----------
const seed = path.join(tmp, "seed");
const w = (rel, content) => {
  const f = path.join(seed, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
w("AcmeCore/AcmeCore.cdsproj", "<Project/>");
w("AcmeCore/src/Other/Solution.xml", "<ImportExportXml><SolutionManifest><UniqueName>AcmeCore</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>");
w(`AcmeCore/src/PluginAssemblies/AcmePlugins-${GUID}/AcmePlugins.dll.data.xml`, "<PluginAssembly/>");
w("AcmeCore/src/WebResources/acme_/scripts/account.js", "// original\n");
w("AcmeCore/src/WebResources/acme_/scripts/account.js.data.xml", "<WebResource><Name>acme_/scripts/account.js</Name></WebResource>");
w("AcmeCore/src/WebResources/cr36f_AccountFormOnLoad", "// no extension\n");
w("AcmeCore/src/WebResources/cr36f_AccountFormOnLoad.data.xml", "<WebResource><Name>cr36f_AccountFormOnLoad</Name><WebResourceType>3</WebResourceType></WebResource>");
const strongName = require("../out/core/strongname.js");
const ACME_KEY = strongName.generateKeyFile();
const ACME_TOKEN = strongName.readKeyFile(ACME_KEY).token;
w("Plugins/AcmePlugins/AcmePlugins.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><SignAssembly>true</SignAssembly><AssemblyOriginatorKeyFile>AcmePlugins.snk</AssemblyOriginatorKeyFile></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2.56" /></ItemGroup></Project>');
w("Plugins/AcmePlugins/AcmePlugins.snk", ACME_KEY);
w("Plugins/AcmePlugins/AccountPlugin.cs", "using Microsoft.Xrm.Sdk;\nnamespace Acme {\n  public class AccountPlugin : IPlugin {\n    public void Execute(System.IServiceProvider sp) {}\n  }\n}\n");
w("Acme.sln", "Microsoft Visual Studio Solution File\n");
w(".gitignore", "bin/\nobj/\n*.dll\n");
const g = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
g(["init", "-q", "-b", "main"], seed);
g(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], seed);
g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], seed);
const bare = path.join(tmp, "Acme-Dynamics.git");
g(["clone", "-q", "--bare", seed, bare], tmp);
const repoUrl = pathToFileURL(bare).href;

// ---------- fake Web API ----------
const requests = [];
const tokenRequests = [];
/** Custom APIs that "exist" in the fake org, by unique name. */
const customApis = {};
/** Requests whose decoded URL matches this fail with a 500, to test error handling. */
let failing;
let webResources = { "acme_/scripts/account.js": { id: "11111111-1111-1111-1111-111111111111", content: Buffer.from("// remote\n").toString("base64") } };
global.fetch = async (url, init = {}) => {
  const parsedBody = init.body && /^\s*[{[]/.test(init.body) ? JSON.parse(init.body) : init.body;
  requests.push({ url, method: init.method, headers: init.headers, body: parsedBody });
  const json = (data, status = 200, headers = {}) => ({ ok: status < 300, status, headers: { get: (h) => headers[h] ?? null }, json: async () => data });
  if (failing && failing.test(decodeURIComponent(url))) return json({ error: { message: "Simulated outage" } }, 500);
  if (url.startsWith("https://login.microsoftonline.com/")) {
    const form = new URLSearchParams(init.body);
    tokenRequests.push({ url, form: Object.fromEntries(form) });
    return form.get("client_secret") === "wrong" ? json({ error_description: "AADSTS7000215: Invalid client secret provided." }, 401) : json({ access_token: "app-token", expires_in: 3600 });
  }
  const plug = pluginApi(decodeURIComponent(url), init, parsedBody);
  if (plug) return json(plug.body ?? {}, plug.status ?? 200, plug.headers ?? {});
  const admin = adminResponse(decodeURIComponent(url), init);
  if (admin !== undefined) return json(admin);
  const meta = metadataResponse(decodeURIComponent(url));
  if (meta !== undefined) {
    metaRequests.push(decodeURIComponent(url));
    return json(meta);
  }
  if (init.method === "GET" && url.includes("webresourceset?")) {
    const name = decodeURIComponent(url.split("$filter=")[1]).match(/name eq '(.+)'/)[1];
    const wr = url.includes("acme-test") && name === "cr36f_AccountFormOnLoad"
      ? { id: "33333333-3333-3333-3333-333333333333", content: Buffer.from("// the TEST version\n").toString("base64") }
      : webResources[name];
    return json({ value: wr ? [{ webresourceid: wr.id, name, webresourcetype: 3, content: wr.content }] : [] });
  }
  if (init.method === "PATCH" || init.method === "DELETE") return json({}, 204);
  if (init.method === "POST" && url.endsWith("webresourceset")) {
    return json({}, 204, { "OData-EntityId": `${url}(22222222-2222-2222-2222-222222222222)` });
  }
  if (url.endsWith("PublishXml") || url.endsWith("PublishAllXml")) return json({}, 204);
  if (url.endsWith("WhoAmI")) return json({ UserId: "user-1", OrganizationId: "org-1", BusinessUnitId: "bu-1" });
  if (init.method === "POST") return json({}, 204, { "OData-EntityId": `${url}(55555555-5555-5555-5555-555555555555)` });
  return json({ error: { message: "unexpected" } }, 404);
};

// ---------- fake plug-in registrations ----------
// What the Plugin Registration Tool would see: assemblies (with their DLL content), plug-in
// types, the steps on them, and plug-in packages. Lantern reads and writes these through the Web API.
const { writeAssembly } = require("./fakes/assembly-writer");
const LEGACY_ID = "bbbbbbbb-0000-0000-0000-00000000000b";
const LEGACY_KEY = strongName.generateKeyFile();
const withSources = (dll, sources) => Buffer.concat([dll, Buffer.from(`\0LANTERN-FAKE-SOURCES\0${JSON.stringify(sources)}`)]);
const pluginStore = {
  assemblies: [
    { pluginassemblyid: GUID, name: "AcmePlugins", version: "1.0.0.0", culture: "neutral", publickeytoken: ACME_TOKEN, isolationmode: 2, ismanaged: false, _packageid_value: null,
      content: withSources(writeAssembly({ name: "AcmePlugins", version: "1.0.0.0", publicKey: strongName.readKeyFile(ACME_KEY).publicKey, types: [{ ns: "Acme", name: "AccountPlugin", interfaces: ["IPlugin"] }] }),
        { "Acme.AccountPlugin": "public class AccountPlugin : IPlugin {\n    public void Execute(System.IServiceProvider sp) {}\n  }" }).toString("base64") },
    { pluginassemblyid: LEGACY_ID, name: "Acme.Legacy", version: "2.1.0.0", culture: "neutral", publickeytoken: strongName.readKeyFile(LEGACY_KEY).token, isolationmode: 2, ismanaged: false, _packageid_value: null,
      content: withSources(writeAssembly({ name: "Acme.Legacy", version: "2.1.0.0", publicKey: strongName.readKeyFile(LEGACY_KEY).publicKey, types: [{ ns: "Acme.Legacy", name: "LegacyPlugin", interfaces: ["IPlugin"] }] }),
        { "Acme.Legacy.LegacyPlugin": "public class LegacyPlugin : IPlugin\n{\n    public void Execute(System.IServiceProvider serviceProvider) { /* from Dataverse */ }\n}" }).toString("base64") },
  ],
  types: [
    { plugintypeid: "pt1", typename: "Acme.AccountPlugin", isworkflowactivity: false, workflowactivitygroupname: null, _pluginassemblyid_value: GUID },
    { plugintypeid: "pt-legacy", typename: "Acme.Legacy.LegacyPlugin", isworkflowactivity: false, workflowactivitygroupname: null, _pluginassemblyid_value: LEGACY_ID },
  ],
  /** Steps by plug-in type, for the "unregister removed classes" check. */
  steps: [
    { sdkmessageprocessingstepid: "s1", name: "AccountPlugin: Update of account", _plugintypeid_value: "pt1" },
    { sdkmessageprocessingstepid: "s2", name: "AccountPlugin: Create of account", _plugintypeid_value: "pt1" },
  ],
  packages: [],
  /** RetrieveDependenciesForDelete answers by plug-in type ID (default: only its steps). */
  dependents: {},
};
let pluginIds = 0;
const newPluginId = () => `cccccccc-0000-0000-0000-${String(++pluginIds).padStart(12, "0")}`;
const assemblyName = (id) => pluginStore.assemblies.find((a) => a.pluginassemblyid === id)?.name;

function pluginApi(url, init, body) {
  const method = init.method || "GET";
  const created = (set, id) => ({ status: 204, headers: { "OData-EntityId": `https://x/api/data/v9.2/${set}(${id})` } });
  const idIn = (re) => (re.exec(url) || [])[1];
  if (/\/pluginassemblies\?/.test(url) && method === "GET") {
    let list = pluginStore.assemblies;
    const name = idIn(/\bname eq '([^']+)'/);
    const id = idIn(/pluginassemblyid eq ([0-9a-f-]+)/i);
    if (name) list = list.filter((a) => a.name === name);
    if (id) list = list.filter((a) => a.pluginassemblyid === id);
    return { body: { value: list.map(({ content, ...a }) => ({ ...a, ...(a._packageid_value ? { "_packageid_value@OData.Community.Display.V1.FormattedValue": pluginStore.packages.find((p) => p.pluginpackageid === a._packageid_value)?.uniquename } : {}) })) } };
  }
  const assemblyId = idIn(/\/pluginassemblies\(([^)]+)\)/);
  if (assemblyId) {
    const a = pluginStore.assemblies.find((x) => x.pluginassemblyid === assemblyId);
    if (!a) return { status: 404, body: { error: { message: "Does not exist" } } };
    if (method === "GET") return { body: { content: a.content } };
    if (method === "PATCH") {
      Object.assign(a, body);
      return { status: 204 };
    }
  }
  if (method === "POST" && /\/pluginassemblies$/.test(url)) {
    const id = newPluginId();
    pluginStore.assemblies.push({ ...body, pluginassemblyid: id, ismanaged: false, _packageid_value: null, solution: init.headers["MSCRM.SolutionUniqueName"] });
    return created("pluginassemblies", id);
  }
  if (/\/plugintypes\?/.test(url) && method === "GET") {
    let list = pluginStore.types;
    const id = idIn(/_pluginassemblyid_value eq ([0-9a-f-]+)/i);
    if (id) list = list.filter((t) => t._pluginassemblyid_value === id);
    if (url.includes("$orderby=typename")) list = [...list].sort((a, b) => a.typename.localeCompare(b.typename));
    return { body: { value: list.map((t) => ({ ...t, assemblyname: assemblyName(t._pluginassemblyid_value) })) } };
  }
  if (method === "POST" && /\/plugintypes$/.test(url)) {
    const id = newPluginId();
    const owner = /pluginassemblies\(([^)]+)\)/.exec(body["pluginassemblyid@odata.bind"])[1];
    pluginStore.types.push({ plugintypeid: id, typename: body.typename, isworkflowactivity: !!body.workflowactivitygroupname, workflowactivitygroupname: body.workflowactivitygroupname ?? null, _pluginassemblyid_value: owner, body });
    return created("plugintypes", id);
  }
  const typeId = idIn(/\/plugintypes\(([^)]+)\)/);
  if (typeId && method === "DELETE") {
    if (pluginStore.steps.some((st) => st._plugintypeid_value === typeId)) return { status: 400, body: { error: { message: "The plug-in type has steps." } } };
    pluginStore.types = pluginStore.types.filter((t) => t.plugintypeid !== typeId);
    return { status: 204 };
  }
  if (typeId && method === "PATCH") {
    Object.assign(pluginStore.types.find((t) => t.plugintypeid === typeId), body);
    return { status: 204 };
  }
  if (/\/sdkmessageprocessingsteps\?/.test(url) && url.includes("_plugintypeid_value eq") && method === "GET") {
    const id = idIn(/_plugintypeid_value eq ([\w-]+)/);
    return { body: { value: pluginStore.steps.filter((st) => st._plugintypeid_value === id).map((st) => ({ ismanaged: false, ...st })) } };
  }
  if (url.includes("RetrieveDependenciesForDelete(")) {
    const id = idIn(/@p1=([\w-]+)/);
    const own = pluginStore.steps.filter((st) => st._plugintypeid_value === id).map((st) => ({ dependentcomponenttype: 92, dependentcomponentobjectid: st.sdkmessageprocessingstepid }));
    return { body: { value: [...own, ...(pluginStore.dependents[id] ?? [])] } };
  }
  // The backup's image query (no $select); the step checker's own query is answered further down.
  if (/\/sdkmessageprocessingstepimages\?\$filter=/.test(url)) {
    return { body: { value: [{ sdkmessageprocessingstepimageid: "img1", entityalias: "PreImage", imagetype: 0, attributes: "name", _sdkmessageprocessingstepid_value: idIn(/_sdkmessageprocessingstepid_value eq ([\w-]+)/) }] } };
  }
  const secureId = idIn(/\/sdkmessageprocessingstepsecureconfigs\(([^)]+)\)/);
  if (secureId && method === "DELETE") return { status: 204 };
  const stepId = idIn(/\/sdkmessageprocessingsteps\(([^)]+)\)/);
  if (stepId && method === "GET") {
    const st = pluginStore.steps.find((x) => x.sdkmessageprocessingstepid === stepId);
    return { body: { ...st, stage: 40, mode: 0, filteringattributes: "name", configuration: "unsecure config" } };
  }
  if (stepId && method === "DELETE") {
    pluginStore.steps = pluginStore.steps.filter((st) => st.sdkmessageprocessingstepid !== stepId);
    return { status: 204 };
  }
  if (/\/pluginpackages\?/.test(url) && method === "GET") {
    const unique = idIn(/uniquename eq '([^']+)'/);
    const id = idIn(/pluginpackageid eq ([0-9a-f-]+)/i);
    return { body: { value: pluginStore.packages.filter((p) => (!unique || p.uniquename === unique) && (!id || p.pluginpackageid === id)).map(({ content, ...p }) => p) } };
  }
  const packageId = idIn(/\/pluginpackages\(([^)]+)\)/);
  if (packageId) {
    const p = pluginStore.packages.find((x) => x.pluginpackageid === packageId);
    if (method === "GET") return { body: { content: p.content, uniquename: p.uniquename, version: p.version } };
    if (method === "PATCH") {
      Object.assign(p, body);
      return { status: 204 };
    }
  }
  if (method === "POST" && /\/pluginpackages$/.test(url)) {
    const id = newPluginId();
    pluginStore.packages.push({ ...body, pluginpackageid: id, ismanaged: false, solution: init.headers["MSCRM.SolutionUniqueName"] });
    return created("pluginpackages", id);
  }
  return undefined;
}

// ---------- fake metadata ----------
const metaRequests = [];
const L = (text) => ({ UserLocalizedLabel: { Label: text }, LocalizedLabels: [{ Label: text }] });
const ACCOUNT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const FORM_XML = `<form><tabs>
<tab name="SUMMARY_TAB" id="{t1}" expanded="true"><labels><label description="Summary" languagecode="1033" /></labels><columns><column width="100%"><sections>
<section name="ACCOUNT_INFORMATION" showlabel="true"><labels><label description="Account Information" languagecode="1033" /></labels><rows>
<row><cell id="{c1}"><labels><label description="Account Name" languagecode="1033" /></labels><control id="name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="name" disabled="false" /></cell></row>
<row><cell id="{c2}"><labels><label description="Fax" languagecode="1033" /></labels><control id="fax" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="fax" /></cell></row>
</rows></section>
<section name="ADDRESS"><labels><label description="Address" languagecode="1033" /></labels><rows>
<row><cell id="{c3}"><labels><label description="Address 1" languagecode="1033" /></labels><control id="address1_composite" classid="{E0DECE4B-6FC8-4A8F-A065-082708572369}" datafieldname="address1_composite" /></cell></row>
<row><cell id="{c4}" visible="false"><labels><label description="Address 1: Street 2" languagecode="1033" /></labels><control id="address1_line2" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="address1_line2" /></cell></row>
</rows></section>
<section name="CONTACTS_SECTION"><labels><label description="Contacts" languagecode="1033"/></labels><rows><row><cell id="{c5}"><labels><label description="Contacts" languagecode="1033"/></labels><control id="Contacts" classid="{E7A81278-8635-4d9e-8D4D-59480B391C5B}" indicationOfSubgrid="true"><parameters><TargetEntityType>contact</TargetEntityType></parameters></control></cell></row></rows></section>
</sections></column></columns></tab>
<tab name="DETAILS_TAB" visible="false"><labels><label description="Details" languagecode="1033" /></labels><columns><column><sections><section name="DETAILS"><labels><label description="Company Profile" languagecode="1033"/></labels><rows><row><cell id="{c6}"><labels><label description="Industry" languagecode="1033"/></labels><control id="industrycode" classid="{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}" datafieldname="industrycode"/></cell></row></rows></section></sections></column></columns></tab>
</tabs>
<header id="{h}"><rows><row><cell id="{h1}"><labels><label description="Annual Revenue" languagecode="1033"/></labels><control id="header_revenue" classid="{x}" datafieldname="revenue"/></cell></row></rows></header>
<events>
<event name="onload" application="false" active="false"><InternalHandlers><Handler functionName="Mscrm.Internal" libraryName="Internal" handlerUniqueId="{x}" enabled="true" /></InternalHandlers><Handlers><Handler functionName="formOnLoad" libraryName="cr36f_AccountFormOnLoad" handlerUniqueId="{y}" enabled="true" parameters="" passExecutionContext="true" /></Handlers></event>
<event name="onchange" application="false" active="false" attribute="address1_line2"><Handlers><Handler functionName="AddressStreet3Hide" libraryName="cr36f_AccountFormOnLoad" handlerUniqueId="{z}" enabled="true" parameters="" passExecutionContext="false" /></Handlers></event>
</events>
<formLibraries><Library name="cr36f_AccountFormOnLoad" libraryUniqueId="{l}" /></formLibraries>
</form>`;

function metadataResponse(url) {
  const col = (name, label, type, extra = {}) => ({
    LogicalName: name, SchemaName: name, DisplayName: L(label), Description: L(""), AttributeType: type,
    AttributeTypeName: { Value: `${type}Type` }, RequiredLevel: { Value: extra.required ?? "None" }, IsCustomAttribute: false, AttributeOf: extra.of ?? null,
    IsValidForRead: name !== "address1_composite",
  });
  if (url.includes("EntityDefinitions?$select=")) {
    return { value: [
      { LogicalName: "account", SchemaName: "Account", DisplayName: L("Account"), EntitySetName: "accounts", PrimaryIdAttribute: "accountid", PrimaryNameAttribute: "name", IsCustomEntity: false, MetadataId: ACCOUNT_ID },
      { LogicalName: "contact", SchemaName: "Contact", DisplayName: L("Contact"), EntitySetName: "contacts", PrimaryIdAttribute: "contactid", PrimaryNameAttribute: "fullname", IsCustomEntity: false, MetadataId: "aaaaaaaa-0000-0000-0000-000000000002" },
      { LogicalName: "cr36f_project", SchemaName: "cr36f_Project", DisplayName: L("Project"), EntitySetName: "cr36f_projects", PrimaryIdAttribute: "cr36f_projectid", PrimaryNameAttribute: "cr36f_name", IsCustomEntity: true, MetadataId: "aaaaaaaa-0000-0000-0000-000000000003" },
    ] };
  }
  const attrs = /EntityDefinitions\(LogicalName='(\w+)'\)\/Attributes(\/Microsoft\.Dynamics\.CRM\.(\w+))?/.exec(url);
  if (attrs) {
    const [, table, , cast] = attrs;
    if (table !== "account") return { value: [] };
    if (!cast && url.includes("acme-test")) return { value: [col("name", "Account Name", "String", { required: "ApplicationRequired" }), col("telephone3", "Address 1: Telephone 3", "String")] };
    if (!cast) return { value: [
      col("name", "Account Name", "String", { required: "ApplicationRequired" }),
      col("fax", "Fax", "String"),
      col("telephone3", "Address 1: Telephone 3", "String"),
      col("address1_line2", "Address 1: Street 2", "String"),
      col("address1_line3", "Address 1: Street 3", "String"),
      col("address1_composite", "Address 1", "Memo"),
      col("parentaccountid", "Parent Account", "Lookup"),
      col("parentaccountidname", "", "String", { of: "parentaccountid" }),
      col("industrycode", "Industry", "Picklist"),
      col("donotemail", "Do not allow Emails", "Boolean"),
      col("revenue", "Annual Revenue", "Money"),
      col("statecode", "Status", "State"),
      col("statuscode", "Status Reason", "Status"),
      col("ownerid", "Owner", "Owner"),
      col("createdon", "Created On", "DateTime"),
      col("modifiedon", "Modified On", "DateTime"),
      col("createdby", "Created By", "Lookup"),
      col("modifiedby", "Modified By", "Lookup"),
    ] };
    if (cast === "StringAttributeMetadata") return { value: [{ LogicalName: "fax", MaxLength: 50 }, { LogicalName: "name", MaxLength: 160 }] };
    if (cast === "LookupAttributeMetadata") return { value: [{ LogicalName: "parentaccountid", Targets: ["account"] }] };
    if (cast === "PicklistAttributeMetadata") return { value: [{ LogicalName: "industrycode", OptionSet: { Options: [{ Value: 1, Label: L("Accounting") }, { Value: 2, Label: L("Agriculture") }] } }] };
    if (cast === "BooleanAttributeMetadata") return { value: [{ LogicalName: "donotemail", OptionSet: { TrueOption: { Value: 1, Label: L("Do Not Allow") }, FalseOption: { Value: 0, Label: L("Allow") } } }] };
    return { value: [] };
  }
  if (url.includes("systemforms?")) {
    return /objecttypecode eq 'account'/.test(url)
      ? { value: [
          { formid: "f1", name: "Account", type: 2, formxml: FORM_XML },
          { formid: "f0", name: "Dashboard thing", type: 0, formxml: "<form/>" },
        ] }
      : { value: [] };
  }
  if (url.includes("solutions?") && url.includes("friendlyname")) {
    return { value: [
      { solutionid: "sol-1", uniquename: "AcmeCore", friendlyname: "Acme Core", version: "1.0.0.3", ismanaged: false, "_publisherid_value@OData.Community.Display.V1.FormattedValue": "Acme" },
      { solutionid: "sol-2", uniquename: "Cr7e97c", friendlyname: "Common Data Services Default Solution", version: "1.0.0.0", ismanaged: false, "_publisherid_value@OData.Community.Display.V1.FormattedValue": "CDS Default Publisher" },
      { solutionid: "sol-3", uniquename: "Default", friendlyname: "Default Solution", version: "1.0", ismanaged: false },
      { solutionid: "sol-4", uniquename: "msdynce_Sales", friendlyname: "Sales", version: "9.0", ismanaged: true, "_publisherid_value@OData.Community.Display.V1.FormattedValue": "Microsoft" },
    ] };
  }
  if (url.includes("solutions?")) return { value: url.includes("'AcmeCore'") ? [{ solutionid: "sol-1", version: url.includes("acme-test") ? "1.0.0.2" : "1.0.0.3", friendlyname: "Acme Core", description: "Core customizations for Acme.", "_publisherid_value@OData.Community.Display.V1.FormattedValue": "Acme" }] : [] };
  if (url.includes("sdkmessages?")) return { value: url.includes("name eq 'Update'") ? [{ sdkmessageid: "m-update" }] : [] };
  if (url.includes("sdkmessagefilters?")) return { value: url.includes("primaryobjecttypecode eq 'account'") ? [{ sdkmessagefilterid: "f-account-update" }] : [] };
  if (url.includes("roles?")) return { value: [{ roleid: "r1", name: "Salesperson" }, { roleid: "r2", name: "System Customizer" }] };
  if (url.includes("RetrieveRolePrivilegesRole(")) {
    return { RolePrivileges: url.includes("@p=r1")
      ? [{ PrivilegeName: "prvReadAccount", Depth: "Local" }, { PrivilegeName: "prvWriteAccount", Depth: "Basic" }, { PrivilegeName: "prvAppendToAccount", Depth: "Global" }, { PrivilegeName: "prvCreateContact", Depth: "Deep" }, { PrivilegeName: "prvReadSdkMessage", Depth: "Global" }]
      : [] };
  }
  if (url.includes("RetrievePrincipalAccess(")) return { AccessRights: "None" };
  if (url.includes(`accounts(${"aaaaaaaa-1111-2222-3333-444444444444"})?$select=_ownerid_value`)) {
    return { _ownerid_value: "user-1", "_ownerid_value@OData.Community.Display.V1.FormattedValue": "Nathan Brandt", _owningbusinessunit_value: "bu-1", "_owningbusinessunit_value@OData.Community.Display.V1.FormattedValue": "acme" };
  }
  if (url.includes("systemusers(u1)?$select=fullname,_businessunitid_value")) {
    return { fullname: "Ada Lovelace", _businessunitid_value: "bu-2", "_businessunitid_value@OData.Community.Display.V1.FormattedValue": "Sales East", systemuserroles_association: [{ roleid: "r1", name: "Salesperson" }] };
  }
  if (url.includes("systemusers(u1)/teammembership_association")) return { value: [{ name: "East team", teamroles_association: [] }] };
  if (url.includes("solutioncomponents?") && url.includes("componenttype eq 380")) return { value: url.includes("sol-1") ? [{ objectid: "d1" }] : [] };
  if (url.includes("solutioncomponents?") && url.includes("componenttype eq 61")) return { value: [{ objectid: "33333333-3333-3333-3333-333333333333" }, { objectid: "44444444-4444-4444-4444-444444444444" }] };
  if (url.includes("webresourceset?") && url.includes("webresourceid eq")) {
    return { value: [
      { webresourceid: "44444444-4444-4444-4444-444444444444", name: "acme_/scripts/remote.js", displayname: "Remote script", webresourcetype: 3 },
      { webresourceid: "33333333-3333-3333-3333-333333333333", name: "cr36f_AccountFormOnLoad", displayname: "Account form", webresourcetype: 3 },
    ] };
  }
  if (url.includes("solutioncomponents?")) return { value: [{ objectid: ACCOUNT_ID.toUpperCase() }] };
  return undefined;
}

// ---------- fake query, trace, usage, and user data ----------
const FV = "@OData.Community.Display.V1.FormattedValue";
const cookieFor = (page) => `<cookie pagenumber="${page + 1}" pagingcookie="${encodeURIComponent(encodeURIComponent(`<cookie page="${page}"><contactid last="{C${page}}" /></cookie>`))}" istracking="False" />`;
function adminResponse(url, init) {
  if (init.method && init.method !== "GET") return undefined;
  const fetchXml = /\?fetchXml=(.*)$/s.exec(url)?.[1];
  if (fetchXml && url.includes("accounts?") && fetchXml.includes('aggregate="true"')) {
    const groups = [...fetchXml.matchAll(/alias="(\w+)" groupby="true"/g)].map((m) => m[1]);
    const countAlias = /alias="(\w+)" aggregate="count"/.exec(fetchXml)?.[1] ?? "count";
    const names = ["Contoso", "Fabrikam", "Litware"];
    const counts = [3, 1, 2];
    return { value: names.map((n, i) => Object.fromEntries([...groups.map((g) => [g, g === "name" ? n : `${g}-${i}`]), [countAlias, counts[i]]])) };
  }
  if (fetchXml && url.includes("accounts?")) {
    return { value: [
      { accountid: "a1", name: "Contoso", _parentaccountid_value: "p1", [`_parentaccountid_value${FV}`]: "Contoso Group",
        "_parentaccountid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "account", industrycode: 1, [`industrycode${FV}`]: "Accounting" },
      { accountid: "a2", name: "Fabrikam, \"Inc\"", _parentaccountid_value: null, industrycode: null },
    ] };
  }
  if (fetchXml && url.includes("contacts?")) {
    const page = Number(/page="(\d+)"/.exec(fetchXml)?.[1] ?? 1);
    return {
      value: [{ contactid: `c${page}a`, fullname: `Person ${page}A` }, { contactid: `c${page}b`, fullname: `Person ${page}B` }],
      "@Microsoft.Dynamics.CRM.morerecords": true,
      "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie": cookieFor(page),
    };
  }
  if (url.includes("plugintracelogs?")) {
    return { value: [
      { plugintracelogid: "t1", typename: "Acme.Plugins.AccountPostUpdate, Acme.Plugins, Version=1.0.0.0", messagename: "Update", primaryentity: "account",
        mode: 0, depth: 1, operationtype: 1, createdon: new Date(Date.now() - 5 * 60000).toISOString(), performanceexecutionduration: 42,
        correlationid: "corr-1", messageblock: "Entered Execute\nUpdated 1 record", exceptiondetails: null },
      { plugintracelogid: "t2", typename: "Acme.Plugins.ContactCreate, Acme.Plugins", messagename: "Create", primaryentity: "contact",
        mode: 1, depth: 2, operationtype: 1, createdon: new Date(Date.now() - 90 * 60000).toISOString(), performanceexecutionduration: 7,
        correlationid: "corr-2", messageblock: "", exceptiondetails: "System.NullReferenceException: Object reference not set" },
    ] };
  }
  if (/Attributes\(LogicalName='fax'\)\?\$select=MetadataId/.test(url)) return { MetadataId: "attr-fax" };
  if (url.includes("/ManyToOneRelationships?")) {
    if (url.includes("'parentaccountid'")) return { value: [{ ReferencingEntityNavigationPropertyName: "parentaccountid", ReferencedEntity: "account" }] };
    if (url.includes("'ownerid'")) return { value: [{ ReferencingEntityNavigationPropertyName: "ownerid_systemuser", ReferencedEntity: "systemuser" }, { ReferencingEntityNavigationPropertyName: "ownerid_team", ReferencedEntity: "team" }] };
    return { value: [] };
  }
  if (url.includes("RetrieveDependentComponents(")) {
    if (url.includes("@p1=attr-fax")) {
      return { value: [
        { dependentcomponentobjectid: "f1", dependentcomponenttype: 60, requiredcomponentobjectid: "attr-fax", requiredcomponenttype: 2 },
        { dependentcomponentobjectid: "v1", dependentcomponenttype: 26, requiredcomponentobjectid: "attr-fax", requiredcomponenttype: 2 },
        { dependentcomponentobjectid: "w1", dependentcomponenttype: 29, requiredcomponentobjectid: "attr-fax", requiredcomponenttype: 2 },
        { dependentcomponentobjectid: "f1", dependentcomponenttype: 60, requiredcomponentobjectid: "attr-fax", requiredcomponenttype: 2 },
        { dependentcomponentobjectid: "zz", dependentcomponenttype: 9999, requiredcomponentobjectid: "attr-fax", requiredcomponenttype: 2 },
      ] };
    }
    if (url.includes("@p1=33333333-3333-3333-3333-333333333333")) return { value: [{ dependentcomponentobjectid: "f1", dependentcomponenttype: 60 }] };
    return { value: [] };
  }
  if (url.includes("RetrieveRequiredComponents(")) {
    return url.includes("@p1=attr-fax") ? { value: [{ requiredcomponentobjectid: ACCOUNT_ID, requiredcomponenttype: 1 }] } : { value: [] };
  }
  if (url.includes("systemforms(f1)?$select=formxml")) return { formxml: FORM_XML };
  if (url.includes("systemforms(f1)")) return { name: "Account", objecttypecode: "account" };
  if (url.includes("customapis?")) {
    const name = /uniquename eq '([^']+)'/.exec(url)?.[1];
    return { value: customApis[name] ? [customApis[name]] : [] };
  }
  if (url.includes("savedqueries(v1)")) return { name: "Active Accounts", returnedtypecode: "account" };
  if (url.includes("workflows(w1)")) return { name: "Require fax for EU" };
  if (url.includes("sdkmessageprocessingstepimages?")) return { value: [{ entityalias: "PreImage", imagetype: 0, attributes: "revenue" }] };
  if (url.includes("RetrieveTotalRecordCount(")) return { EntityRecordCountCollection: { Count: 1, IsReadOnly: false, Keys: ["account"], Values: [1234] } };
  if (url.includes("organizations?")) return { value: [{ organizationid: "org-1", plugintracelogsetting: 0 }] };
  if (url.includes("savedqueries?")) {
    return { value: [
      { name: "Active Accounts", querytype: 0, fetchxml: '<fetch><entity name="account"><attribute name="fax"/><filter><condition attribute="fax" operator="not-null"/></filter></entity></fetch>', layoutxml: '<grid><row><cell name="fax" width="100"/></row></grid>' },
      { name: "Quick Find", querytype: 4, fetchxml: '<fetch><entity name="account"><attribute name="name"/></entity></fetch>', layoutxml: '<grid><row><cell name="name"/></row></grid>' },
    ] };
  }
  if (url.includes("workflows?")) {
    return { value: [
      { name: "Require fax for EU", category: 2, statecode: 1, xaml: '<Activity><Expression attribute="fax" /></Activity>' },
      { name: "Faxless thing", category: 0, statecode: 0, xaml: '<Activity><Expression attribute="faxnumber2" /></Activity>' },
    ] };
  }
  if (url.includes("sdkmessageprocessingsteps?") && url.includes("customizationlevel eq 1")) {
    return { value: [
      { sdkmessageprocessingstepid: "s1", name: "AccountPlugin: Update of account", stage: 40, mode: 0, statecode: 0, rank: 1, filteringattributes: "name,fax",
        sdkmessageid: { name: "Update" }, sdkmessagefilterid: { primaryobjecttypecode: "account" }, plugintypeid: { typename: "Acme.AccountPlugin", assemblyname: "AcmePlugins" } },
      { sdkmessageprocessingstepid: "s2", name: "AccountPlugin: Create of account", stage: 20, mode: 1, statecode: url.includes("acme-test") ? 0 : 1, rank: 1, filteringattributes: null,
        sdkmessageid: { name: "Create" }, sdkmessagefilterid: { primaryobjecttypecode: "account" }, plugintypeid: { typename: "Acme.AccountPlugin", assemblyname: "AcmePlugins" } },
    ] };
  }
  if (url.includes("asyncoperations?")) {
    const failedOnly = url.includes("statuscode eq 31");
    const jobs = [
      { asyncoperationid: "j1", name: "Send welcome email", operationtype: 10, "operationtype@OData.Community.Display.V1.FormattedValue": "Workflow",
        statuscode: 31, "statuscode@OData.Community.Display.V1.FormattedValue": "Failed", createdon: new Date(Date.now() - 600000).toISOString(),
        message: "The email address is invalid.", friendlymessage: "Couldn't send the email.", _regardingobjectid_value: "a1",
        "_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "account", "_regardingobjectid_value@OData.Community.Display.V1.FormattedValue": "Contoso" },
      { asyncoperationid: "j2", name: "Recalculate rollups", operationtype: 1, "operationtype@OData.Community.Display.V1.FormattedValue": "System Event",
        statuscode: 30, "statuscode@OData.Community.Display.V1.FormattedValue": "Succeeded", createdon: new Date(Date.now() - 1200000).toISOString(), message: null },
    ];
    return { value: failedOnly ? jobs.slice(0, 1) : jobs };
  }
  if (url.includes("environmentvariabledefinitions?")) {
    return { value: [
      { environmentvariabledefinitionid: "d1", schemaname: "acme_ApiBaseUrl", displayname: "API base URL", type: 100000000, defaultvalue: "https://default",
        environmentvariabledefinition_environmentvariablevalue: [{ environmentvariablevalueid: "v1", value: url.includes("acme-test") ? "https://test-env" : "https://test" }] },
      { environmentvariabledefinitionid: "d2", schemaname: "acme_RetryCount", displayname: "Retry count", type: 100000001, defaultvalue: "3",
        environmentvariabledefinition_environmentvariablevalue: [] },
      { environmentvariabledefinitionid: "d3", schemaname: "acme_Secret", displayname: "Secret", type: 100000005, defaultvalue: null },
    ] };
  }
  if (url.includes("RetrieveCurrentOrganization(")) return { Detail: { EnvironmentId: "env-123", FriendlyName: "Acme Dev", UniqueName: "org4d07465f", Geo: "NA", TenantId: "tenant-1", OrganizationVersion: "9.2.0" } };
  if (url.endsWith("RetrieveVersion()")) return { Version: "9.2.26091.123" };
  if (url.includes("systemusers(user-1)")) return { fullname: "Nathan Brandt", domainname: "na.brandt@acme.com", systemuserroles_association: [{ name: "System Customizer" }, { name: "Basic User" }] };
  if (url.includes("businessunits(bu-1)")) return { name: "acme" };
  if (/accounts\(a1\)$/.test(url)) return { accountid: "a1", name: "Contoso", fax: "555" };
  if (/accounts\(aaaaaaaa-1111-2222-3333-444444444444\)$/.test(url)) {
    return {
      accountid: "aaaaaaaa-1111-2222-3333-444444444444", name: "Contoso", fax: "555-0100", telephone3: null,
      _parentaccountid_value: "p1", [`_parentaccountid_value${FV}`]: "Contoso Group", "_parentaccountid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "account",
      industrycode: 1, [`industrycode${FV}`]: "Accounting", "@odata.etag": "W/\"1\"",
    };
  }
  if (url.includes("audits?")) {
    return { value: [
      { createdon: "2026-10-01T15:00:00Z", [`createdon${FV}`]: "10/1/2026 10:00 AM", operation: 2, action: 2, [`action${FV}`]: "Update",
        _userid_value: "user-1", [`_userid_value${FV}`]: "Nathan Brandt",
        changedata: JSON.stringify({ changedAttributes: [{ logicalName: "fax", oldValue: "555-0000", newValue: "555-0100" }, { logicalName: "name", oldValue: "Contoso Ltd", newValue: "Contoso" }] }) },
    ] };
  }
  if (url.includes("sdkmessageprocessingsteps?")) {
    return { value: [
      { name: "Acme.Plugins.AccountPostUpdate: Update of account", statecode: 0, filteringattributes: "name,fax", sdkmessageid: { name: "Update" } },
      { name: "Other step", statecode: 0, filteringattributes: "name", sdkmessageid: { name: "Update" } },
    ] };
  }
  if (url.includes("systemusers?")) {
    return { value: [
      { systemuserid: "u1", fullname: "Ada Lovelace", domainname: "ada@acme.com" },
      { systemuserid: "u2", fullname: "Grace Hopper", domainname: "grace@acme.com" },
      { systemuserid: "u3", fullname: "Alan Turing", domainname: "alan@acme.com" },
    ] };
  }
  if (url.startsWith("https://acme.crm.dynamics.com/api/data/v9.2/usersettingscollection(")) return { paginglimit: url.includes("(u1)") ? 50 : 25 };
  return undefined;
}

// ---------- helpers ----------
const run = (id, ...args) => S.commands.get(`lantern.${id}`)(...args);
const lastMessage = () => S.messages[S.messages.length - 1];
const errors = () => S.messages.filter((m) => m[0] === "error");
const step = async (name, fn) => {
  const before = errors().length;
  try {
    await fn();
    const newErrors = errors().slice(before);
    assert.deepStrictEqual(newErrors, [], `unexpected error messages: ${JSON.stringify(newErrors)}`);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
};

(async () => {
  S.workspaceFolders = [root];
  // Most steps check client.json in the folder; the outside-the-folder default has its own step.
  S.config["clientSettingsLocation"] = "folder";
  const ext = require("../out/extension.js");
  const secretStore = new Map();
  const context = {
    subscriptions: [],
    globalStorageUri: vscode.Uri.file(path.join(tmp, "storage")),
    secrets: { get: async (k) => secretStore.get(k), store: async (k, v) => void secretStore.set(k, v), delete: async (k) => void secretStore.delete(k) },
  };
  ext.activate(context);
  const acme = path.join(root, "acme-dynamics");
  const wr = path.join(acme, "AcmeCore/src/WebResources/acme_/scripts");

  await step("every contributed command is registered", () => {
    const pkg = require("../package.json");
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    const registered = [...S.commands.keys()].filter((k) => k.startsWith("lantern.")).sort();
    assert.deepStrictEqual(registered, contributed);
    const submenus = (pkg.contributes.submenus || []).map((x) => x.id);
    for (const menu of Object.values(pkg.contributes.menus)) {
      for (const item of menu) {
        if (item.submenu) assert.ok(submenus.includes(item.submenu), `unknown submenu ${item.submenu}`);
        else assert.ok(contributed.includes(item.command), `menu refers to unknown command ${item.command}`);
      }
    }
    for (const id of submenus) assert.ok(pkg.contributes.menus[id], `submenu ${id} has no items`);
  });

  await step("new client clones the ADO repo, writes config, restores .NET", async () => {
    S.inputAnswers.push(repoUrl, "acme-dynamics", "acme.crm.dynamics.com", "AcmeCore");
    await run("newClient");
    const cfg = JSON.parse(fs.readFileSync(path.join(acme, "client.json"), "utf8"));
    assert.strictEqual(cfg.org, "https://acme.crm.dynamics.com");
    assert.deepStrictEqual(cfg.solutions, ["AcmeCore"]);
    assert.ok(fs.existsSync(path.join(acme, "jsconfig.json")));
    assert.match(fs.readFileSync(path.join(acme, ".git/info/exclude"), "utf8"), /\/client\.json/);
    assert.match(cliLog(), /dotnet restore .*Acme\.sln/);
    assert.strictEqual(g(["status", "--porcelain"], acme).trim(), "", "tooling files must not show as repo changes");
  });

  await step("new local-only client (no repo, no org)", async () => {
    S.inputAnswers.push("", "beta", "");
    await run("newClient");
    assert.ok(fs.existsSync(path.join(root, "beta/client.json")));
    assert.ok(!fs.existsSync(path.join(root, "beta/.git")));
  });

  const tree = S.treeViews["lantern.clients"].treeDataProvider;
  await step("clients tree shows clients, solutions and plug-in projects", async () => {
    const top = await tree.getChildren();
    const acmeNode = top.find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    assert.ok(acmeNode);
    assert.strictEqual(acmeNode.branch, "main");
    const item = tree.getTreeItem(acmeNode);
    assert.strictEqual(item.contextValue, "client.connected");
    assert.match(item.description, /acme\.crm\.dynamics\.com/);
    const groups = await tree.getChildren(acmeNode);
    const sol = await tree.getChildren(groups.find((n) => n.group === "solutions"));
    assert.strictEqual(sol.length, 1);
    assert.strictEqual(tree.getTreeItem(sol[0]).label, "AcmeCore");
    const pluginsGroup = groups.find((n) => n.group === "plugins");
    assert.strictEqual(tree.getTreeItem(pluginsGroup).label, "Plug-ins");
    const pluginKids = await tree.getChildren(pluginsGroup);
    assert.deepStrictEqual(pluginKids.map((n) => tree.getTreeItem(n).label), ["Projects", "Steps", "Traces"], "projects, steps and traces under one Plug-ins item");
    const plugins = await tree.getChildren(pluginKids[0]);
    assert.strictEqual(plugins[0].plugin.assembly, "AcmePlugins");
    const beta = top.find((n) => n.kind === "client" && n.client.name === "beta");
    assert.strictEqual(tree.getTreeItem(beta).contextValue, "client");
  });

  const reviewView = S.treeViews["lantern.review"];
  const review = reviewView.treeDataProvider;
  await step("pull stages Dataverse, lists differences, skips git-ignored build output", async () => {
    fs.writeFileSync(path.join(wr, "account.js"), "// my uncommitted edit\n");
    await run("pull", { client: require("../out/core/clients.js").readClient(acme) });
    assert.match(cliLog(), /pac auth create --name acmedynamics --environment https:\/\/acme\.crm\.dynamics\.com/);
    assert.match(cliLog(), /pac solution sync --solution-folder .*dataverse-pull-acme-dynamics-.*AcmeCore/);
    assert.strictEqual(S.context["lantern.reviewActive"], true);
    const changes = review.getChildren();
    const names = changes.map((c) => `${c.kind}:${path.basename(c.display)}`).sort();
    assert.deepStrictEqual(names, ["changed:Solution.xml", "changed:account.js", "new:contact.js"]);
    assert.strictEqual(review.session.ignoredCount, 1, "the DLL is git-ignored");
    const account = changes.find((c) => c.display.endsWith("account.js"));
    assert.strictEqual(account.edited, true);
    assert.match(reviewView.message, /3 difference/);
    assert.strictEqual(fs.readFileSync(path.join(wr, "account.js"), "utf8"), "// my uncommitted edit\n", "nothing applied yet");
  });

  await step("review: diff opens, choices apply, backups made, temp cleaned", async () => {
    const changes = review.getChildren();
    const account = changes.find((c) => c.display.endsWith("account.js"));
    const solutionXml = changes.find((c) => c.display.endsWith("Solution.xml"));
    await run("review.open", solutionXml);
    assert.ok(S.executed.some((e) => e[0] === "vscode.diff" && e[3].includes("Dataverse ↔ Yours")));
    await run("review.open", account);
    const merge = S.executed.find((e) => e[0] === "_open.mergeEditor");
    assert.ok(merge, "edited file with a committed base opens the 3-way merge editor");
    assert.strictEqual(merge[1].output.fsPath, account.localPath);
    assert.strictEqual(fs.readFileSync(merge[1].base.fsPath, "utf8"), "// original\n");
    assert.strictEqual(account.choice, "keep");
    await run("review.takeDataverse", account);
    await run("review.takeDataverse", solutionXml);
    await run("review.keepAllPending");
    assert.strictEqual(review.session.pendingCount, 0);
    const staging = review.session.stagingDir;
    await run("review.apply");
    assert.strictEqual(fs.readFileSync(path.join(wr, "account.js"), "utf8"), "// dataverse version\n");
    assert.ok(!fs.existsSync(path.join(wr, "contact.js")), "kept mine = don't add it");
    assert.ok(fs.existsSync(path.join(acme, ".pull-backup/AcmeCore/src/WebResources/acme_/scripts/account.js")));
    assert.ok(!fs.existsSync(path.join(wr, "AcmePlugins.dll")));
    assert.ok(!fs.existsSync(staging), "staging folder removed");
    assert.strictEqual(S.context["lantern.reviewActive"], false);
    assert.match(g(["status", "--porcelain"], acme), /M AcmeCore\/src\/WebResources\/acme_\/scripts\/account\.js/);
  });

  await step("push web resource: find, update, publish via Web API", async () => {
    requests.length = 0;
    await run("pushWebResource", vscode.Uri.file(path.join(wr, "account.js")));
    const [get, patch, publish] = requests;
    assert.strictEqual(get.method, "GET");
    assert.match(decodeURIComponent(get.url), /name eq 'acme_\/scripts\/account\.js'/);
    assert.strictEqual(patch.method, "PATCH");
    assert.strictEqual(patch.headers["If-Match"], "*");
    assert.strictEqual(Buffer.from(patch.body.content, "base64").toString(), "// dataverse version\n");
    assert.match(publish.body.ParameterXml, /11111111-1111-1111-1111-111111111111/);
    assert.ok(S.lastScopes.includes("https://acme.crm.dynamics.com/user_impersonation"));
  });

  await step("push a new web resource: create in the chosen solution", async () => {
    requests.length = 0;
    fs.writeFileSync(path.join(wr, "lead.js"), "// lead\n");
    S.messageAnswers.push("Create");
    S.quickPickAnswers.push("AcmeCore");
    await run("pushWebResource", vscode.Uri.file(path.join(wr, "lead.js")));
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("webresourceset"));
    assert.ok(post);
    assert.strictEqual(post.headers["MSCRM.SolutionUniqueName"], "AcmeCore");
    assert.strictEqual(post.body.name, "acme_/scripts/lead.js");
    assert.strictEqual(post.body.webresourcetype, 3);
    assert.match(requests[requests.length - 1].body.ParameterXml, /22222222/);
  });

  await step("compare with Dataverse opens a diff against the remote content", async () => {
    await run("compareWebResource", vscode.Uri.file(path.join(wr, "account.js")));
    const diff = S.executed.filter((e) => e[0] === "vscode.diff").pop();
    assert.strictEqual(diff[1].scheme, "dataverse-wr");
    assert.strictEqual(S.contentProviders["dataverse-wr"].provideTextDocumentContent(diff[1]), "// remote\n");
  });

  const acmePluginsDir = path.join(acme, "Plugins", "AcmePlugins");
  const acmeNow = () => require("../out/core/clients.js").readClient(acme);
  const acmeProject = () => ({ client: acmeNow(), plugin: { project: path.join(acmePluginsDir, "AcmePlugins.csproj"), assembly: "AcmePlugins" } });
  /** Writes to plug-in registrations, as "METHOD path". */
  const pluginWrites = () => requests
    .filter((r) => r.method !== "GET" && /\/(pluginassemblies|plugintypes|pluginpackages|sdkmessageprocessingsteps|sdkmessageprocessingstepsecureconfigs)\b/.test(decodeURIComponent(r.url)))
    .map((r) => ({ ...r, what: `${r.method} ${decodeURIComponent(r.url).split("/v9.2/")[1]}` }));
  const pluginGroup = async () => {
    const top = await tree.getChildren();
    const acmeNode = top.find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    const [projects] = await tree.getChildren((await tree.getChildren(acmeNode)).find((n) => n.group === "plugins"));
    return tree.getChildren(projects);
  };
  const readAssembly = require("../out/core/assembly.js").readAssembly;
  const clientJson = () => JSON.parse(fs.readFileSync(path.join(acme, "client.json"), "utf8"));

  await step("build and push plug-in: updates the registered assembly in place, like the Plugin Registration Tool", async () => {
    const [pluginNode] = await pluginGroup();
    requests.length = 0;
    await run("pushPlugin", pluginNode);
    assert.match(cliLog(), /dotnet build .*AcmePlugins\.csproj -c Release/);
    assert.ok(!/pac plugin push/.test(cliLog()), "no pac plugin push and no Plugin Registration Tool");
    const writes = pluginWrites();
    assert.deepStrictEqual(writes.map((w) => w.what), [`PATCH pluginassemblies(${GUID})`], "the ID from the solution's PluginAssemblies folder");
    const sent = readAssembly(Buffer.from(writes[0].body.content, "base64"));
    assert.deepStrictEqual([sent.name, sent.version, sent.publicKeyToken], ["AcmePlugins", "1.0.0.0", ACME_TOKEN]);
    assert.deepStrictEqual(sent.pluginClasses, [{ typeName: "Acme.AccountPlugin", kind: "plugin" }]);
    assert.deepStrictEqual([writes[0].body.version, writes[0].body.sourcetype], ["1.0.0.0", 0]);
    assert.strictEqual(lastMessage()[1], "Pushed AcmePlugins 1.0.0.0 to acme.crm.dynamics.com.");
  });

  await step("build and push: new classes become plug-in types and workflow activities (from a .cs file)", async () => {
    fs.writeFileSync(path.join(acmePluginsDir, "ContactPlugin.cs"), "using Microsoft.Xrm.Sdk;\nnamespace Acme {\n  public class ContactPlugin : IPlugin {\n    public void Execute(System.IServiceProvider sp) {}\n  }\n}\n");
    fs.writeFileSync(path.join(acmePluginsDir, "SetName.cs"), "using System.Activities;\nnamespace Acme {\n  public class SetName : CodeActivity {\n    protected override void Execute(CodeActivityContext c) {}\n  }\n}\n");
    requests.length = 0;
    S.messageAnswers.push(undefined);
    await run("pushPlugin", vscode.Uri.file(path.join(acmePluginsDir, "ContactPlugin.cs")));
    const writes = pluginWrites();
    assert.strictEqual(writes[0].what, `PATCH pluginassemblies(${GUID})`, "content first, then the new types");
    const posted = Object.fromEntries(writes.slice(1).map((w) => [w.body.typename, w]));
    assert.deepStrictEqual(Object.keys(posted).sort(), ["Acme.ContactPlugin", "Acme.SetName"]);
    const contact = posted["Acme.ContactPlugin"].body;
    assert.strictEqual(contact["pluginassemblyid@odata.bind"], `/pluginassemblies(${GUID})`);
    assert.strictEqual(contact.name, "Acme.ContactPlugin");
    assert.match(contact.friendlyname, /^[0-9a-f-]{36}$/, "a GUID, as the Plugin Registration Tool does");
    assert.strictEqual(contact.workflowactivitygroupname, undefined);
    assert.strictEqual(posted["Acme.SetName"].body.workflowactivitygroupname, "AcmePlugins (1.0.0.0)");
    assert.match(lastMessage()[1], /^Pushed AcmePlugins 1\.0\.0\.0 to acme\.crm\.dynamics\.com\. Registered (ContactPlugin, SetName|SetName, ContactPlugin)\.$/);
  });

  await step("build and push: removed classes are checked, backed up, and unregistered (steps first) only after a yes", async () => {
    const contactType = pluginStore.types.find((t) => t.typename === "Acme.ContactPlugin");
    pluginStore.steps.push({ sdkmessageprocessingstepid: "s9", name: "ContactPlugin: Create of contact", _plugintypeid_value: contactType.plugintypeid, _sdkmessageprocessingstepsecureconfigid_value: "sc9" });
    fs.rmSync(path.join(acmePluginsDir, "ContactPlugin.cs"));

    // Something else depends on the class (a Custom API, say): Lantern refuses and changes nothing.
    pluginStore.dependents[contactType.plugintypeid] = [{ dependentcomponenttype: 10027, dependentcomponentobjectid: "api1" }];
    requests.length = 0;
    await run("pushPlugin", acmeProject());
    const refusal = S.messages.filter((m) => m[0] === "error").pop();
    assert.match(refusal[1], /Lantern won't unregister Acme\.ContactPlugin: another component depends on it \(component type 10027\)\. Nothing was changed\./);
    assert.deepStrictEqual(pluginWrites(), []);
    S.messages = S.messages.filter((m) => m !== refusal);

    // A step Dataverse knows about but Lantern couldn't list would stop the delete halfway: blocked too.
    pluginStore.dependents[contactType.plugintypeid] = [{ dependentcomponenttype: 92, dependentcomponentobjectid: "s-hidden" }];
    await run("pushPlugin", acmeProject());
    const hidden = S.messages.filter((m) => m[0] === "error").pop();
    assert.match(hidden[1], /Dataverse reports a step on it that Lantern can't list/);
    assert.deepStrictEqual(pluginWrites(), []);
    S.messages = S.messages.filter((m) => m !== hidden);
    delete pluginStore.dependents[contactType.plugintypeid];

    // A managed step blocks too.
    pluginStore.steps.find((st) => st.sdkmessageprocessingstepid === "s9").ismanaged = true;
    await run("pushPlugin", acmeProject());
    const managed = S.messages.filter((m) => m[0] === "error").pop();
    assert.match(managed[1], /a step from a managed solution \(ContactPlugin: Create of contact\)/);
    assert.deepStrictEqual(pluginWrites(), []);
    S.messages = S.messages.filter((m) => m !== managed);
    delete pluginStore.steps.find((st) => st.sdkmessageprocessingstepid === "s9").ismanaged;

    // Clear to remove: it asks first.
    S.messageAnswers.push(undefined);
    await run("pushPlugin", acmeProject());
    const ask = S.messages.filter((m) => m[0] === "warn").pop();
    assert.match(ask[1], /^AcmePlugins\.dll no longer has a class that's registered in acme\.crm\.dynamics\.com\. Dataverse won't take the update until it's unregistered\.$/);
    assert.strictEqual(ask[2].detail, [
      "Acme.ContactPlugin: ContactPlugin: Create of contact",
      "The steps and their images are saved to a file in .pull-backup first.",
      "Secure configurations aren't saved (they often hold credentials) and are removed with their steps: ContactPlugin: Create of contact.",
    ].join("\n\n"));
    assert.deepStrictEqual(pluginWrites(), [], "nothing changes without a yes");

    S.messageAnswers.push("Unregister It and 1 Step", undefined);
    await run("pushPlugin", acmeProject());
    assert.deepStrictEqual(pluginWrites().map((w) => w.what), [
      "DELETE sdkmessageprocessingsteps(s9)", "DELETE sdkmessageprocessingstepsecureconfigs(sc9)", `DELETE plugintypes(${contactType.plugintypeid})`, `PATCH pluginassemblies(${GUID})`,
    ]);
    const backups = fs.readdirSync(path.join(acme, ".pull-backup")).filter((f) => f.startsWith("unregistered-steps-AcmePlugins-"));
    assert.strictEqual(backups.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(acme, ".pull-backup", backups[0]), "utf8"));
    assert.deepStrictEqual([saved.assembly, saved.steps[0].pluginType, saved.steps[0].step.configuration, saved.steps[0].images[0].entityalias], ["AcmePlugins", "Acme.ContactPlugin", "unsecure config", "PreImage"]);
    assert.match(lastMessage()[1], /Unregistered ContactPlugin and 1 step\. The steps were saved to \.pull-backup.unregistered-steps-AcmePlugins-.*\.json\.$/);
  });

  await step("build and push: a new major/minor version or a different key is caught before anything is sent", async () => {
    const info = path.join(acmePluginsDir, "AssemblyInfo.cs");
    fs.writeFileSync(info, '[assembly: System.Reflection.AssemblyVersion("2.0.0.0")]\n');
    requests.length = 0;
    S.messageAnswers.push(undefined);
    await run("pushPlugin", acmeProject());
    let ask = S.messages.filter((m) => m[0] === "warn").pop();
    assert.match(ask[1], /The registered AcmePlugins is version 1\.0\.0\.0 and this build is 2\.0\.0\.0\. Dataverse only accepts changes to the last two parts/);
    assert.deepStrictEqual(pluginWrites(), []);

    // ...or register it next to the old one, in a solution
    S.messageAnswers.push("Register as Separate Assembly", undefined);
    S.quickPickAnswers.push((list) => {
      assert.deepStrictEqual(list.map((i) => i.label), ["AcmeCore", "Don't add to a solution"]);
      return list[0];
    });
    await run("pushPlugin", acmeProject());
    const [create, ...types] = pluginWrites();
    assert.strictEqual(create.what, "POST pluginassemblies");
    assert.deepStrictEqual([create.body.name, create.body.version, create.body.isolationmode, create.body.sourcetype, create.body.publickeytoken], ["AcmePlugins", "2.0.0.0", 2, 0, ACME_TOKEN]);
    assert.strictEqual(create.headers["MSCRM.SolutionUniqueName"], "AcmeCore");
    assert.deepStrictEqual(types.map((t) => t.body.typename).sort(), ["Acme.AccountPlugin", "Acme.SetName"]);
    const second = pluginStore.assemblies.find((a) => a.version === "2.0.0.0");
    assert.strictEqual(clientJson().plugins.AcmePlugins, second.pluginassemblyid);
    assert.strictEqual(lastMessage()[1], "Registered AcmePlugins 2.0.0.0 in acme.crm.dynamics.com with 2 classes (in AcmeCore).");
    // back to one registered copy for the rest of the run
    fs.rmSync(info);
    pluginStore.assemblies = pluginStore.assemblies.filter((a) => a !== second);
    pluginStore.types = pluginStore.types.filter((t) => t._pluginassemblyid_value !== second.pluginassemblyid);
    const cfg = clientJson();
    delete cfg.plugins.AcmePlugins;
    fs.writeFileSync(path.join(acme, "client.json"), JSON.stringify(cfg, null, 2));

    // Signed with another key: the original is in the folder, so Lantern offers it and builds again.
    fs.writeFileSync(path.join(acmePluginsDir, "other.snk"), strongName.generateKeyFile());
    const csproj = path.join(acmePluginsDir, "AcmePlugins.csproj");
    fs.writeFileSync(csproj, fs.readFileSync(csproj, "utf8").replace("AcmePlugins.snk", "other.snk"));
    requests.length = 0;
    S.messageAnswers.push("Use Original Key", undefined);
    await run("pushPlugin", acmeProject());
    ask = S.messages.filter((m) => m[0] === "warn").pop();
    assert.match(ask[1], /This build is signed with a different key \(public key token [0-9a-f]{16}\) than the registered AcmePlugins/);
    assert.match(ask[2].detail, /Found a key file with the registered assembly's public key token .*AcmePlugins\.snk$/);
    assert.match(fs.readFileSync(csproj, "utf8"), /<AssemblyOriginatorKeyFile>AcmePlugins\.snk<\/AssemblyOriginatorKeyFile>/);
    assert.deepStrictEqual(pluginWrites().map((w) => w.what), [`PATCH pluginassemblies(${GUID})`]);
    assert.strictEqual(readAssembly(Buffer.from(pluginWrites()[0].body.content, "base64")).publicKeyToken, ACME_TOKEN);

    // A new major version signed with a new key on purpose: the version question comes first, and a
    // separate registration doesn't need the old key.
    fs.writeFileSync(csproj, fs.readFileSync(csproj, "utf8").replace("AcmePlugins.snk", "other.snk"));
    fs.writeFileSync(info, '[assembly: System.Reflection.AssemblyVersion("3.0.0.0")]\n');
    const otherToken = strongName.readKeyFile(fs.readFileSync(path.join(acmePluginsDir, "other.snk"))).token;
    requests.length = 0;
    const warnsBefore = S.messages.filter((m) => m[0] === "warn").length;
    S.messageAnswers.push("Register as Separate Assembly", undefined);
    S.quickPickAnswers.push("Don't add to a solution");
    await run("pushPlugin", acmeProject());
    const warns = S.messages.filter((m) => m[0] === "warn").slice(warnsBefore);
    assert.deepStrictEqual(warns.map((m) => m[1].slice(0, 40)), ["The registered AcmePlugins is version 1."], "no key prompt");
    const third = pluginWrites()[0];
    assert.deepStrictEqual([third.what, third.body.version, third.body.publickeytoken], ["POST pluginassemblies", "3.0.0.0", otherToken]);
    const created3 = pluginStore.assemblies.find((a) => a.version === "3.0.0.0");
    pluginStore.assemblies = pluginStore.assemblies.filter((a) => a !== created3);
    pluginStore.types = pluginStore.types.filter((t) => t._pluginassemblyid_value !== created3.pluginassemblyid);
    const cfg3 = clientJson();
    delete cfg3.plugins.AcmePlugins;
    fs.writeFileSync(path.join(acme, "client.json"), JSON.stringify(cfg3, null, 2));
    fs.rmSync(info);
    fs.writeFileSync(csproj, fs.readFileSync(csproj, "utf8").replace("other.snk", "AcmePlugins.snk"));
    fs.rmSync(path.join(acmePluginsDir, "other.snk"));
  });

  await step("first push of a new project: makes a signing key, asks for a solution, registers the assembly and its classes", async () => {
    const dir = path.join(acme, "Plugins", "Acme.Fresh");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Acme.Fresh.csproj"), '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net462</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2.*" />\n  </ItemGroup>\n</Project>\n');
    fs.writeFileSync(path.join(dir, "FreshPlugin.cs"), "namespace Acme.Fresh {\n  public class FreshPlugin : Microsoft.Xrm.Sdk.IPlugin {\n    public void Execute(System.IServiceProvider sp) {}\n  }\n}\n");
    requests.length = 0;
    S.messageAnswers.push("Create Signing Key", undefined);
    S.quickPickAnswers.push("Don't add to a solution");
    await run("pushPlugin", { client: acmeNow(), plugin: { project: path.join(dir, "Acme.Fresh.csproj"), assembly: "Acme.Fresh" } });
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /^Acme\.Fresh\.dll isn't signed\./);
    const key = strongName.readKeyFile(fs.readFileSync(path.join(dir, "Acme.Fresh.snk")));
    assert.match(fs.readFileSync(path.join(dir, "Acme.Fresh.csproj"), "utf8"), /<SignAssembly>true<\/SignAssembly>\n    <AssemblyOriginatorKeyFile>Acme\.Fresh\.snk<\/AssemblyOriginatorKeyFile>/);
    const [create, type] = pluginWrites();
    assert.deepStrictEqual([create.what, create.body.name, create.body.publickeytoken, create.headers["MSCRM.SolutionUniqueName"]], ["POST pluginassemblies", "Acme.Fresh", key.token, undefined]);
    const fresh = pluginStore.assemblies.find((a) => a.name === "Acme.Fresh");
    assert.deepStrictEqual([type.body.typename, type.body["pluginassemblyid@odata.bind"]], ["Acme.Fresh.FreshPlugin", `/pluginassemblies(${fresh.pluginassemblyid})`]);
    assert.strictEqual(lastMessage()[1], "Registered Acme.Fresh 1.0.0.0 in acme.crm.dynamics.com with 1 class.");
    assert.strictEqual(clientJson().plugins["Acme.Fresh"], fresh.pluginassemblyid);
  });

  await step("tree: each plug-in class matched to its registration; registered assemblies with no project here", async () => {
    pluginStore.types.push({ plugintypeid: "pt-old", typename: "Acme.OldPlugin", isworkflowactivity: false, workflowactivitygroupname: null, _pluginassemblyid_value: GUID });
    fs.writeFileSync(path.join(acmePluginsDir, "NewThing.cs"), "namespace Acme {\n  public class NewThing : Microsoft.Xrm.Sdk.IPlugin { public void Execute(System.IServiceProvider s) {} }\n}\n");
    tree.reloadPlugins();
    const group = await pluginGroup();
    assert.deepStrictEqual(group.map((n) => `${n.kind}:${tree.getTreeItem(n).label}`).sort(), ["plugin:Acme.Fresh", "plugin:AcmePlugins", "remoteAssembly:Acme.Legacy"]);
    const acmeNode = group.find((n) => n.kind === "plugin" && n.plugin.assembly === "AcmePlugins");
    assert.strictEqual(tree.getTreeItem(acmeNode).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    const [head, ...classes] = await tree.getChildren(acmeNode);
    assert.strictEqual(tree.getTreeItem(head).label, "1.0.0.0 in acme.crm.dynamics.com");
    const items = Object.fromEntries(classes.map((c) => {
      const i = tree.getTreeItem(c);
      return [i.label, [i.description, i.contextValue]];
    }));
    assert.deepStrictEqual(items, {
      AccountPlugin: ["2 steps, 1 off", "pluginClass.registered.plugin"],
      NewThing: ["not registered yet", "pluginClass.unregistered.plugin"],
      OldPlugin: ["only in acme.crm.dynamics.com", "pluginClass.orphan.plugin"],
      SetName: ["workflow activity", "pluginClass.registered.workflow"],
    });
    const account = classes.find((c) => c.typeName === "Acme.AccountPlugin");
    const open = tree.getTreeItem(account).command;
    assert.deepStrictEqual([open.command, open.arguments[0].fsPath, open.arguments[1].selection.args], ["vscode.open", path.join(acmePluginsDir, "AccountPlugin.cs"), [2, 15, 2, 28]]);
    assert.deepStrictEqual((await tree.getChildren(account)).map((st) => tree.getTreeItem(st).label), ["Create of account", "Update of account"]);
    const legacy = group.find((n) => n.kind === "remoteAssembly");
    assert.strictEqual(tree.getTreeItem(legacy).description, "2.1.0.0 in acme.crm.dynamics.com, no project here");
    assert.deepStrictEqual((await tree.getChildren(legacy)).map((c) => tree.getTreeItem(c).label), ["LegacyPlugin"]);
    fs.rmSync(path.join(acmePluginsDir, "NewThing.cs"));
    pluginStore.types = pluginStore.types.filter((t) => t.plugintypeid !== "pt-old");
  });

  await step("Get Source: installs ILSpy on request, decompiles into a project with the original key, and that project pushes in place", async () => {
    fs.mkdirSync(path.join(acme, "keys"), { recursive: true });
    fs.writeFileSync(path.join(acme, "keys", "legacy.snk"), LEGACY_KEY);
    const legacy = (await pluginGroup()).find((n) => n.kind === "remoteAssembly");
    fs.writeFileSync(logFile, "");
    S.inputAnswers.push((box) => {
      assert.strictEqual(box.value, path.join("Plugins", "Acme.Legacy"), "next to the other plug-in projects");
      assert.strictEqual(box.validateInput(path.join("Plugins", "AcmePlugins", "Legacy")), "That's inside the AcmePlugins.csproj project. Pick a folder outside it.");
      assert.strictEqual(box.validateInput(path.join("Plugins", "AcmePlugins")), "That folder isn't empty.");
      assert.strictEqual(box.validateInput(path.join("..", "elsewhere")), "Pick a folder inside acme-dynamics.");
      return box.value;
    });
    S.messageAnswers.push("Install ILSpy", undefined);
    await run("plugins.getSource", legacy);
    assert.match(cliLog(), /dotnet tool install --global ilspycmd/);
    assert.match(cliLog(), /ilspycmd -p -o \S*Plugins.Acme\.Legacy .*Acme\.Legacy\.dll/);
    const dir = path.join(acme, "Plugins", "Acme.Legacy");
    const csproj = fs.readFileSync(path.join(dir, "Acme.Legacy.csproj"), "utf8");
    assert.match(csproj, /<AssemblyName>Acme\.Legacy<\/AssemblyName>/);
    assert.match(csproj, /<AssemblyOriginatorKeyFile>\.\.\\\.\.\\keys\\legacy\.snk<\/AssemblyOriginatorKeyFile>/, "the original key, found in the folder by its token");
    assert.match(csproj, /Microsoft\.CrmSdk\.CoreAssemblies/);
    assert.ok(!csproj.includes("somewhere"), "ILSpy's own project file is replaced");
    const code = path.join(dir, "Acme.Legacy", "LegacyPlugin.cs");
    assert.match(fs.readFileSync(code, "utf8"), /from Dataverse/);
    assert.strictEqual(S.lastShow.target.uri.fsPath, code, "opens the plug-in class");
    assert.strictEqual(clientJson().plugins["Acme.Legacy"], LEGACY_ID);
    assert.match(lastMessage()[1], /^Decompiled Acme\.Legacy 2\.1\.0\.0 into Plugins.Acme\.Legacy \(1 plug-in class\)\. .*signed with the original key, so Build and Push updates the registered assembly in place\.$/);
    assert.ok((await pluginGroup()).some((n) => n.kind === "plugin" && n.plugin.assembly === "Acme.Legacy"), "now a project, not a remote-only assembly");

    requests.length = 0;
    S.messageAnswers.push(undefined);
    await run("pushPlugin", { client: acmeNow(), plugin: { project: path.join(dir, "Acme.Legacy.csproj"), assembly: "Acme.Legacy" } });
    assert.deepStrictEqual(pluginWrites().map((w) => w.what), [`PATCH pluginassemblies(${LEGACY_ID})`]);
  });

  await step("Get Source for an assembly already in the folder: no second copy, offers a comparison instead", async () => {
    S.messageAnswers.push("Compare Deployed with Local", undefined);
    await run("plugins.getSource", { client: acmeNow(), assembly: "AcmePlugins" });
    const infos = S.messages.filter((m) => m[0] === "info");
    assert.strictEqual(infos[infos.length - 2][1], `AcmePlugins is already in your folder at ${path.join("Plugins", "AcmePlugins")}. Lantern won't make a second copy.`);
    assert.match(lastMessage()[1], /^acme\.crm\.dynamics\.com is running the same AcmePlugins code as your build \(version 1\.0\.0\.0\)\./);
    assert.deepStrictEqual(fs.readdirSync(acmePluginsDir).filter((f) => f.endsWith(".csproj")), ["AcmePlugins.csproj"]);
  });

  await step("Compare with deployed: lists what differs, or goes straight to a class's diff", async () => {
    const file = path.join(acmePluginsDir, "AccountPlugin.cs");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original.replace("public void Execute(System.IServiceProvider sp) {}", 'public void Execute(System.IServiceProvider sp) { throw new System.Exception("changed"); }'));
    S.executed.length = 0;
    await run("plugins.compareDeployed", { ...acmeProject(), typeName: "Acme.AccountPlugin" });
    const diff = S.executed.find((e) => e[0] === "vscode.diff");
    assert.ok(diff, "opens the diff");
    assert.strictEqual(diff[3], "AccountPlugin.cs: acme.crm.dynamics.com ↔ your build");
    assert.ok(!fs.readFileSync(diff[1].fsPath, "utf8").includes("changed"), "left: what's deployed");
    assert.match(fs.readFileSync(diff[2].fsPath, "utf8"), /changed/, "right: your build");
    S.quickPickAnswers.push((list) => {
      assert.deepStrictEqual(list.map((i) => `${i.label}: ${i.description}`), ["Acme/AccountPlugin.cs: changed"]);
      return undefined;
    });
    await run("plugins.compareDeployed", acmeProject());
    fs.writeFileSync(file, original);
  });

  await step("plug-in packages: the first push registers the package (named by PackageId), later pushes update it", async () => {
    const dir = path.join(acme, "Plugins", "Acme.Pkg");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Acme.Pkg.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><PackageId>acme_Pkg</PackageId><Version>1.0.0</Version></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.CrmSdk.CoreAssemblies" Version="9.0.2.*" /><PackageReference Include="Microsoft.PowerApps.MSBuild.Plugin" Version="1.*" /></ItemGroup></Project>');
    fs.writeFileSync(path.join(dir, "PkgPlugin.cs"), "namespace Acme.Pkg {\n  public class PkgPlugin : Microsoft.Xrm.Sdk.IPlugin { }\n}\n");
    const node = { client: acmeNow(), plugin: { project: path.join(dir, "Acme.Pkg.csproj"), assembly: "Acme.Pkg" } };
    requests.length = 0;
    S.quickPickAnswers.push("AcmeCore");
    S.messageAnswers.push(undefined);
    await run("pushPlugin", node);
    let [w] = pluginWrites();
    assert.deepStrictEqual([w.what, w.body.uniquename, w.body.name, w.body.version, w.headers["MSCRM.SolutionUniqueName"]], ["POST pluginpackages", "acme_Pkg", "acme_Pkg", "1.0.0", "AcmeCore"]);
    assert.ok(require("../out/core/zip.js").readZip(Buffer.from(w.body.content, "base64")).some((e) => e.name === "lib/net462/Acme.Pkg.dll"));
    assert.strictEqual(lastMessage()[1], "Registered plug-in package acme_Pkg 1.0.0 in acme.crm.dynamics.com. Dataverse registers the classes inside it.");
    requests.length = 0;
    S.messageAnswers.push(undefined);
    await run("pushPlugin", node);
    [w] = pluginWrites();
    assert.strictEqual(w.what, `PATCH pluginpackages(${pluginStore.packages[0].pluginpackageid})`);
    assert.deepStrictEqual(Object.keys(w.body), ["content"]);
    for (const d of ["Acme.Pkg", "Acme.Fresh", "Acme.Legacy"]) fs.rmSync(path.join(acme, "Plugins", d), { recursive: true, force: true });
    fs.rmSync(path.join(acme, "keys"), { recursive: true, force: true });
  });

  await step("C# early-bound: prompts, saves settings, runs modelbuilder", async () => {
    S.inputAnswers.push("Plugins/AcmePlugins/Model", "account, contact", "Acme.Model");
    await run("generateEarlyBound", { client: require("../out/core/clients.js").readClient(acme) });
    assert.match(cliLog(), new RegExp(`pac modelbuilder build --outdirectory .*Plugins${SEP}AcmePlugins${SEP}Model --namespace Acme\\.Model --entitynamesfilter account;contact`));
    const cfg = JSON.parse(fs.readFileSync(path.join(acme, "client.json"), "utf8"));
    assert.deepStrictEqual(cfg.earlyBound, { outDir: "Plugins/AcmePlugins/Model", namespace: "Acme.Model", entities: ["account", "contact"] });
    assert.ok(fs.existsSync(path.join(acme, "Plugins/AcmePlugins/Model/Entities.cs")));
  });

  await step("JS form types: explains how to get XrmDefinitelyTyped when missing", async () => {
    await run("generateJsTypes", { client: require("../out/core/clients.js").readClient(acme) });
    assert.match(lastMessage()[1], /XrmDefinitelyTyped\.exe wasn't found/);
  });

  await step("new form script: generic typing, then org-specific typing with form picker", async () => {
    S.inputAnswers.push("account");
    await run("newFormScript", vscode.Uri.file(wr));
    const generic = fs.readFileSync(path.join(wr, "account.js"), "utf8");
    assert.ok(generic.startsWith("// dataverse version"), "existing file must not be overwritten");
    const scripts = path.join(acme, "scripts");
    fs.mkdirSync(scripts);
    S.inputAnswers.push("acme_project");
    await run("newFormScript", vscode.Uri.file(scripts));
    const created = fs.readFileSync(path.join(scripts, "acme_project.js"), "utf8");
    assert.match(created, /AcmeDynamics\.AcmeProject = \(function/);
    assert.match(created, /@param \{Xrm\.Events\.EventContext\} executionContext/);
    execFileSync(process.execPath, ["--check", path.join(scripts, "acme_project.js")]);

    fs.writeFileSync(path.join(acme, "jsconfig.json"), JSON.stringify({ compilerOptions: { types: [] } }));
    fs.mkdirSync(path.join(acme, "typings/Form/contact/Main"), { recursive: true });
    fs.writeFileSync(path.join(acme, "typings/Form/contact/Main/Information.d.ts"), "");
    S.inputAnswers.push("contact");
    S.quickPickAnswers.push("Main/Information");
    await run("newFormScript", vscode.Uri.file(scripts));
    const typed = fs.readFileSync(path.join(scripts, "contact.js"), "utf8");
    assert.match(typed, /@type \{Form\.contact\.Main\.Information\}/);
    assert.match(typed, /Xrm\.ExecutionContext<any, any>/);
    execFileSync(process.execPath, ["--check", path.join(scripts, "contact.js")]);
  });

  await step("CodeLens on web resources and plug-in classes", async () => {
    const lens = S.codeLensProviders[0];
    const doc = (file) => {
      const text = fs.readFileSync(file, "utf8");
      return { uri: vscode.Uri.file(file), getText: () => text, positionAt: (i) => ({ line: text.slice(0, i).split("\n").length - 1 }) };
    };
    const js = await lens.provideCodeLenses(doc(path.join(wr, "account.js")));
    assert.deepStrictEqual(js.map((l) => l.command.command), ["lantern.pushWebResource", "lantern.compareWebResource"]);
    const cs = await lens.provideCodeLenses(doc(path.join(acme, "Plugins/AcmePlugins/AccountPlugin.cs")));
    assert.deepStrictEqual(cs.map((l) => l.command.command), ["lantern.pushPlugin", "lantern.focusSteps", "lantern.steps.register", "lantern.plugins.compareDeployed"]);
    assert.ok(cs.every((l) => l.range.args[0] === 2), "lenses sit on the class line");
    assert.match(cs[1].command.title, /^\$\(plug\) /, "the registered steps for the class");
    assert.strictEqual(cs[2].command.arguments[0].typeName, "Acme.AccountPlugin");
    assert.strictEqual((await lens.provideCodeLenses(doc(path.join(acme, "client.json")))).length, 0);

    // "N steps" shows the class in the tree, under Plug-ins > Projects, with its steps expanded.
    S.revealed = undefined;
    await run("focusSteps", ...cs[1].command.arguments);
    const view = S.treeViews["lantern.clients"];
    assert.deepStrictEqual(S.revealed.chain.map((n) => view.treeDataProvider.getTreeItem(n).label), ["acme-dynamics", "Plug-ins", "Projects", "AcmePlugins", "AccountPlugin"]);
    assert.deepStrictEqual(S.revealed.options, { select: true, focus: true, expand: true });
    // A class with no project here: the Steps section instead.
    await run("focusSteps", { client: cs[2].command.arguments[0].client, typeName: "Acme.Nowhere" });
    assert.deepStrictEqual(S.revealed.chain.map((n) => view.treeDataProvider.getTreeItem(n).label), ["acme-dynamics", "Plug-ins", "Steps"]);
  });

  await step("extensionless web resource (type from .data.xml): language, CodeLens, push, compare", async () => {
    const file = path.join(acme, "AcmeCore/src/WebResources/cr36f_AccountFormOnLoad");
    const text = fs.readFileSync(file, "utf8");
    const doc = { uri: vscode.Uri.file(file), languageId: "plaintext", getText: () => text, positionAt: () => ({ line: 0 }) };
    S.openListeners.forEach((l) => l(doc));
    assert.deepStrictEqual(S.languageSet.pop(), [file, "javascript"]);
    assert.ok(S.codeLensSelector.some((sel) => sel.pattern === "**/WebResources/**"));
    const lenses = await S.codeLensProviders[0].provideCodeLenses(doc);
    assert.deepStrictEqual(lenses.slice(0, 2).map((l) => l.command.command), ["lantern.pushWebResource", "lantern.compareWebResource"]);
    assert.ok(
      lenses.some((l) => /\$\(warning\) Account \(Main\) OnLoad calls formOnLoad, which isn't defined in this file/.test(l.command.title)),
      "handlers registered on the form but missing from the file are flagged"
    );
    (await S.codeLensProviders[0].provideCodeLenses({ ...doc, uri: vscode.Uri.file(file + ".data.xml") })).forEach(() => assert.fail("no lens on .data.xml"));

    webResources["cr36f_AccountFormOnLoad"] = { id: "33333333-3333-3333-3333-333333333333", content: Buffer.from("// remote\n").toString("base64") };
    requests.length = 0;
    await run("pushWebResource", vscode.Uri.file(file));
    assert.match(decodeURIComponent(requests[0].url), /name eq 'cr36f_AccountFormOnLoad'/);
    assert.strictEqual(requests[1].method, "PATCH");
    await run("compareWebResource", vscode.Uri.file(file));
    const diff = S.executed.filter((e) => e[0] === "vscode.diff").pop();
    assert.strictEqual(diff[2].fsPath, file);

    const pkg = require("../package.json");
    const when = pkg.contributes.menus["explorer/context"].find((m) => m.command === "lantern.pushWebResource").when;
    assert.match(when, /resourcePath =~ \/WebResources\//);
  });

  const md = require("../out/core/metadata.js");

  await step("FormXml parsing: tabs, sections, controls, composite parts, header, handlers", () => {
    const f = md.parseFormXml(FORM_XML);
    assert.deepStrictEqual(f.tabs.map((t) => [t.name, t.label, t.visible]), [["SUMMARY_TAB", "Summary", true], ["DETAILS_TAB", "Details", false]]);
    assert.deepStrictEqual(f.tabs[0].sections.map((x) => x.label), ["Account Information", "Address", "Contacts"]);
    const address = f.tabs[0].sections[1].controls;
    assert.ok(address.some((c) => c.id === "address1_composite_compositionLinkControl_address1_line3" && c.kind === "composite-part" && c.field === "address1_line3"));
    assert.strictEqual(address.find((c) => c.id === "address1_line2").visible, false);
    assert.strictEqual(f.tabs[0].sections[2].controls[0].kind, "subgrid");
    assert.deepStrictEqual(f.header.map((c) => [c.id, c.label]), [["header_revenue", "Annual Revenue"]]);
    assert.deepStrictEqual(f.libraries, ["cr36f_AccountFormOnLoad"]);
    assert.deepStrictEqual(f.events.map((e) => [e.name, e.attribute, e.handlers.map((h) => h.functionName)]), [["onload", undefined, ["formOnLoad"]], ["onchange", "address1_line2", ["AddressStreet3Hide"]]]);
    assert.strictEqual(f.events[1].handlers[0].passExecutionContext, false);
  });

  await step("guessing a script's table from its name", () => {
    const tables = [{ logicalName: "account" }, { logicalName: "contact" }, { logicalName: "cr36f_project" }, { logicalName: "lead" }];
    assert.strictEqual(md.guessTable("cr36f_AccountFormOnLoad", tables), "account");
    assert.strictEqual(md.guessTable("acme_/scripts/contact.js", tables), "contact");
    assert.strictEqual(md.guessTable("cr36f_project.js", tables), "cr36f_project");
    assert.strictEqual(md.guessTable("ProjectRibbon.js", tables), "cr36f_project");
    assert.strictEqual(md.guessTable("utils.js", tables), undefined);
    assert.strictEqual(md.tableFromAnnotation("/** @type {Form.contact.Main.Information} */"), "contact");
  });

  const metaTree = S.treeViews["lantern.clients"].treeDataProvider;
  const sectionOf = async (clientName, section) => {
    const client = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === clientName);
    const top = await metaTree.getChildren(client);
    const plugins = top.find((n) => n.kind === "group" && n.group === "plugins");
    const all = [...top, ...(plugins ? await metaTree.getChildren(plugins) : [])];
    return all.find((n) => n.kind === "section" && n.section === section);
  };
  const kids = (n) => metaTree.getChildren(n);
  let accountNode;
  await step("metadata tree: solution tables, columns with choices, forms down to controls and handlers", async () => {
    const roots = await kids();
    const acmeClient = roots.find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    const orgSections = (await kids(acmeClient)).filter((n) => n.kind === "section").map((n) => n.section);
    assert.deepStrictEqual(orgSections, ["tables", "jobs", "envvars", "environment"], "org sections sit under the client; steps and traces under Plug-ins");
    const beta = roots.find((n) => n.kind === "client" && n.client.name === "beta");
    assert.ok(!(await kids(beta)).some((n) => n.kind === "section"), "a client without an org has no org sections");
    const allTables = await sectionOf("acme-dynamics", "tables");
    assert.strictEqual(metaTree.getTreeItem(allTables).label, "All tables");
    assert.strictEqual((await kids(allTables)).length, 3);
    const solutionsGroup = (await kids(acmeClient)).find((n) => n.kind === "group" && n.group === "solutions");
    const [acmeCore] = await kids(solutionsGroup);
    assert.strictEqual(metaTree.getTreeItem(acmeCore).label, "AcmeCore");
    assert.strictEqual(metaTree.getTreeItem(acmeCore).description, "pulled");
    const [solutionTables, solutionWebResources] = await kids(acmeCore);
    assert.strictEqual(metaTree.getTreeItem(solutionWebResources).label, "Web resources");
    const tableKids = await kids(solutionTables);
    assert.deepStrictEqual(tableKids.map((n) => n.table.logicalName), ["account"], "a solution's own tables sit under it");
    accountNode = tableKids[0];
    const item = metaTree.getTreeItem(accountNode);
    assert.strictEqual(item.description, "account");
    assert.match(item.tooltip.value, /Entity set \(Web API\) \| accounts/);

    const [columnsNode, formsNode] = await kids(accountNode);
    const columns = await kids(columnsNode);
    assert.ok(!columns.some((n) => n.column.logicalName === "parentaccountidname"), "helper columns hidden");
    const industry = columns.find((n) => n.column.logicalName === "industrycode");
    assert.deepStrictEqual((await kids(industry)).map((o) => [o.value, o.label]), [[1, "Accounting"], [2, "Agriculture"]]);
    const donotemail = columns.find((n) => n.column.logicalName === "donotemail");
    assert.deepStrictEqual(donotemail.column.options.map((o) => o.label), ["Allow", "Do Not Allow"]);
    const fax = columns.find((n) => n.column.logicalName === "fax");
    assert.strictEqual(fax.column.maxLength, 50);
    assert.match(metaTree.getTreeItem(fax).description, /fax · String/);
    assert.deepStrictEqual(columns.find((n) => n.column.logicalName === "parentaccountid").column.targets, ["account"]);

    const forms = await kids(formsNode);
    assert.deepStrictEqual(forms.map((n) => n.form.name), ["Account"], "dashboards are left out");
    const formKids = await kids(forms[0]);
    assert.deepStrictEqual(formKids.map((n) => n.kind), ["events", "header", "tab", "tab"]);
    const [events] = formKids;
    const onchange = (await kids(events)).find((e) => e.event.name === "onchange");
    const [handler] = await kids(onchange);
    assert.match(metaTree.getTreeItem(handler).description, /execution context NOT passed/);
    const sections = await kids(formKids[2]);
    const addressControls = await kids(sections[1]);
    assert.ok(addressControls.some((n) => n.control.id === "address1_composite_compositionLinkControl_address1_line3"));
  });

  await step("metadata is cached on disk and reused without new requests", async () => {
    const before = metaRequests.length;
    const [columnsNode] = await kids(accountNode);
    await kids(columnsNode);
    assert.strictEqual(metaRequests.length, before, "no refetch");
    const storage = path.join(tmp, "storage", "metadata", "acme.crm.dynamics.com");
    assert.ok(fs.existsSync(path.join(storage, "columns", "account.json")));
    assert.ok(fs.existsSync(path.join(storage, "forms", "account.json")));
    await run("metadata.refresh", accountNode);
    await kids(columnsNode);
    assert.ok(metaRequests.length > before, "refresh refetches that table");
  });

  const scriptDoc = (file, text) => ({
    uri: vscode.Uri.file(file),
    languageId: "javascript",
    getText: () => text,
    lineAt: (n) => ({ text: text.split("\n")[n] }),
  });
  const complete = async (file, line) => {
    const doc = scriptDoc(file, line);
    return S.completionProviders.find((x) => Array.isArray(x.sel)).p.provideCompletionItems(doc, { line: 0, character: line.length });
  };
  const extensionless = path.join(acme, "AcmeCore/src/WebResources/cr36f_AccountFormOnLoad");

  await step("completions: columns in getAttribute, with ones not on a form marked", async () => {
    await run("signOut");
    S.sessionOptions = [];
    const items = await complete(extensionless, '    const x = formContext.getAttribute("');
    const names = items.map((i) => i.label.label);
    assert.ok(names.includes("fax") && names.includes("address1_line2") && names.includes("name"));
    assert.ok(!names.includes("parentaccountidname"));
    const tel = items.find((i) => i.label.label === "telephone3");
    assert.match(tel.label.description, /not on a form/);
    assert.ok(tel.sortText > items.find((i) => i.label.label === "fax").sortText, "on-form columns sort first");
    assert.ok(!items.find((i) => i.label.label === "address1_line3").label.description.includes("not on a form"), "composite parts count as on the form");
    assert.match(items.find((i) => i.label.label === "industrycode").documentation.value, /Accounting/);
    assert.ok(S.sessionOptions.every((o) => o && o.silent === true), "editor features never prompt for sign-in");
    assert.deepStrictEqual(S.completionProviders.find((x) => Array.isArray(x.sel)).triggers, ['"', "'", "`"]);
    const partial = await complete(extensionless, "formContext.getAttribute('ad");
    assert.deepStrictEqual(partial[0].range.args, [0, "formContext.getAttribute('".length, 0, "formContext.getAttribute('ad".length]);
  });

  await step("completions: controls, tabs and sections from the table's forms", async () => {
    const controls = (await complete(extensionless, 'formContext.getControl("')).map((i) => i.label.label);
    assert.ok(controls.includes("address1_composite_compositionLinkControl_address1_line3"));
    assert.ok(controls.includes("header_revenue") && controls.includes("Contacts"));
    const tabs = (await complete(extensionless, "formContext.ui.tabs.get('")).map((i) => i.label.label);
    assert.deepStrictEqual(tabs.sort(), ["DETAILS_TAB", "SUMMARY_TAB"]);
    const sections = (await complete(extensionless, 'tab.sections.get("')).map((i) => i.label.label);
    assert.ok(sections.includes("ADDRESS"));
    assert.strictEqual(await complete(extensionless, 'formContext.getAttribute(name + "'), undefined, "only directly inside the call");
  });

  await step("hovers: column details, not-on-form warning, unknown names, composite controls", async () => {
    const hover = (text, word) => S.hoverProvider.provideHover(scriptDoc(extensionless, text), { line: 0, character: text.indexOf(word) + 2 });
    const tel = await hover('formContext.getAttribute("telephone3").getValue()', "telephone3");
    assert.match(tel.contents.value, /Address 1: Telephone 3/);
    assert.match(tel.contents.value, /Not on any form/);
    const line2 = await hover('formContext.getAttribute("address1_line2")', "address1_line2");
    assert.doesNotMatch(line2.contents.value, /Not on any form/);
    const typo = await hover('formContext.getAttribute("adress1_line2")', "adress1_line2");
    assert.match(typo.contents.value, /No column named `adress1_line2`/);
    const part = await hover('formContext.getControl("address1_composite_compositionLinkControl_address1_line3")', "address1_composite_");
    assert.match(part.contents.value, /inside a composite field/);
    assert.match(part.contents.value, /Address 1: Street 3/);
    assert.strictEqual(await hover('console.log("fax")', "fax"), undefined, "plain strings get no hover");
  });

  await step("set table for a file, then completions use it", async () => {
    const utils = path.join(acme, "scripts/utils.js");
    const none = await complete(utils, 'formContext.getAttribute("');
    assert.strictEqual(none.length, 1);
    assert.strictEqual(none[0].command.command, "lantern.metadata.setFileTable");
    S.quickPickAnswers.push("Account");
    await run("metadata.setFileTable", vscode.Uri.file(utils));
    const cfg = JSON.parse(fs.readFileSync(path.join(acme, "client.json"), "utf8"));
    assert.strictEqual(cfg.fileTables["scripts/utils.js"], "account");
    const now = await complete(utils, 'formContext.getAttribute("');
    assert.ok(now.some((i) => i.label.label === "fax"));
  });

  await step("copy, insert, and the table reference document", async () => {
    const [columnsNode] = await kids(accountNode);
    const fax = (await kids(columnsNode)).find((n) => n.column.logicalName === "fax");
    await run("metadata.copyName", fax);
    assert.strictEqual(S.clipboard, "fax");
    const inserted = [];
    S.activeTextEditor = { document: { uri: vscode.Uri.file(extensionless) }, insertSnippet: (snip) => inserted.push(snip.value) };
    await run("metadata.insertGetAttribute", fax);
    assert.deepStrictEqual(inserted, ['formContext.getAttribute("fax")']);
    S.activeTextEditor = undefined;

    await run("metadata.openTable", accountNode);
    const preview = S.executed.filter((e) => e[0] === "markdown.showPreview").pop();
    const doc = S.contentProviders["dataverse-meta"].provideTextDocumentContent(preview[1]);
    assert.match(doc, /# Account \(`account`\)/);
    assert.match(doc, /\| Fax \| `fax` \| String \|/);
    assert.match(doc, /Industry\*\* `industrycode`: 1 = Accounting, 2 = Agriculture/);
    assert.match(doc, /onchange \(address1_line2\)\*\*: `cr36f_AccountFormOnLoad` → `AddressStreet3Hide` \(execution context not passed\)/);
    assert.match(doc, /part: address1_line3: `address1_composite_compositionLinkControl_address1_line3`/);
  });

  const sqlMod = require("../out/core/sql.js");
  await step("SQL to FetchXML: joins, aggregates, NOT, and clear errors", () => {
    const join = sqlMod.translate("SELECT a.name, c.fullname AS contact FROM account a LEFT JOIN contact c ON c.contactid = a.primarycontactid WHERE c.emailaddress1 IS NOT NULL");
    assert.match(join.fetchXml, /<link-entity name="contact" from="contactid" to="primarycontactid" alias="c" link-type="outer">/);
    assert.match(join.fetchXml, /<condition entityname="c" attribute="emailaddress1" operator="not-null" \/>/);
    const agg = sqlMod.translate("SELECT industrycode, COUNT(*) AS n FROM account GROUP BY industrycode ORDER BY n DESC", { primaryIdOf: () => "accountid" });
    assert.match(agg.fetchXml, /aggregate="true"/);
    assert.match(agg.fetchXml, /<attribute name="accountid" alias="n" aggregate="count" \/>/);
    assert.match(agg.fetchXml, /<order alias="n" descending="true" \/>/);
    const not = sqlMod.translate("SELECT name FROM account WHERE NOT (statecode = 1 OR name LIKE 'A%')");
    assert.match(not.fetchXml, /<filter type="and">[\s\S]*operator="ne" value="1"[\s\S]*operator="not-like" value="A%"/);
    assert.throws(() => sqlMod.translate("UPDATE account SET name = 'x'"), /changes data/);
    assert.throws(() => sqlMod.translate("SELECT industrycode, name FROM account GROUP BY industrycode"), /must be in GROUP BY/);
    assert.deepStrictEqual(sqlMod.splitStatements("select name from account;\nGO\nselect fullname from contact -- done"), ["select name from account", "select fullname from contact -- done"]);
  });

  const editorFor = (text, language = "sql", uri = vscode.Uri.file(path.join(acme, "queries", "q.sql"))) => {
    const doc = { uri, languageId: language, isUntitled: false, getText: (range) => (range ? text : text), lineAt: (n) => ({ text: text.split("\n")[n] }) };
    return { document: doc, selection: { isEmpty: true } };
  };

  await step("new query opens a SQL document aimed at the client", async () => {
    await run("query.new", { client: require("../out/core/clients.js").readClient(acme) });
    const doc = S.createdDocs.pop();
    assert.strictEqual(doc.languageId, "sql");
    assert.match(doc.getText(), /^-- Dataverse: acme-dynamics/);
    const lenses = await S.codeLensProviders[0].provideCodeLenses(doc);
    assert.deepStrictEqual(lenses.map((l) => l.command.title), ["$(play) Run on acme-dynamics", "Run as…", "Show FetchXML", "Copy as code"]);
  });

  await step("run SQL: FetchXML request, results grid with display and stored values", async () => {
    requests.length = 0;
    S.activeTextEditor = editorFor("SELECT TOP 2 name, parentaccountid, industrycode FROM account WHERE statecode = 0");
    await run("query.run");
    const q = requests.find((r) => r.url.includes("accounts?fetchXml="));
    assert.ok(q, "queried the accounts entity set");
    assert.match(decodeURIComponent(q.url), /<fetch top="2">/);
    assert.strictEqual(q.headers.Prefer, 'odata.include-annotations="*"');
    const panel = S.webviewViews["lantern.results"];
    assert.strictEqual(panel.description, "q.sql (acme-dynamics)");
    const html = panel.webview.html;
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /"columns":\["name","parentaccountid","industrycode"\]/);
    assert.match(html, /"raw":"p1","formatted":"Contoso Group","ref":\{"table":"account","id":"p1"\}/);
    assert.match(html, /"raw":1,"formatted":"Accounting"/);
    assert.match(html, /"rowIds":\["a1","a2"\]/);
    // The grid's script must at least parse (a bad escape in the template would break the whole panel).
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
    new (require("vm").Script)(script);

    const csvPath = path.join(tmp, "out.csv");
    S.saveAnswers = [vscode.Uri.file(csvPath)];
    S.messageAnswers.push("Open File");
    await panel.webview.send({ cmd: "save", set: 0, format: "csv", formatted: true });
    assert.strictEqual(fs.readFileSync(csvPath, "utf8"), 'name,parentaccountid,industrycode\r\nContoso,Contoso Group,Accounting\r\n"Fabrikam, ""Inc""",,\r\n');
    assert.match(lastMessage()[1], /Saved 2 rows to out\.csv/);
    assert.strictEqual(S.opened.pop(), csvPath, "Open File opens the saved file");

    // Right-click menu on a grid cell (VS Code passes the cell's data-vscode-context).
    assert.match(html, /data-vscode-context/);
    await run("results.copyCell", { set: 0, row: 0, col: 1, stored: false });
    assert.strictEqual(S.clipboard, "Contoso Group");
    await run("results.copyCell", { set: 0, row: 0, col: 1, stored: true });
    assert.strictEqual(S.clipboard, "p1");
    await run("results.copyRow", { set: 0, row: 1, col: 0, stored: false });
    assert.strictEqual(S.clipboard, 'name\tparentaccountid\tindustrycode\nFabrikam, "Inc"\t\t');
    await run("results.copyColumn", { set: 0, row: 0, col: 2, stored: false });
    assert.strictEqual(S.clipboard, "industrycode\nAccounting\n");
    await run("results.openRecord", { set: 0, row: 1, col: 0, stored: false });
    assert.match(S.opened.pop(), /etn=account&id=a2&pagetype=entityrecord/, "plain cell opens the row's record");
    await run("results.openRecord", { set: 0, row: 0, col: 1, stored: false });
    assert.match(S.opened.pop(), /etn=account&id=p1&pagetype=entityrecord/, "lookup cell opens the referenced record");
    await panel.webview.send({ cmd: "open", table: "account", id: "p1" });
    assert.strictEqual(S.opened.pop(), "https://acme.crm.dynamics.com/main.aspx?etn=account&id=p1&pagetype=entityrecord");
    await panel.webview.send({ cmd: "fetchxml", set: 0 });
    assert.strictEqual(S.createdDocs.pop().languageId, "xml");
  });

  await step("run SQL: pages with the paging cookie and stops at the row limit", async () => {
    requests.length = 0;
    S.config["query.maxRows"] = 3;
    S.activeTextEditor = editorFor("SELECT fullname FROM contact");
    await run("query.run");
    delete S.config["query.maxRows"];
    const pages = requests.filter((r) => r.url.includes("contacts?fetchXml=")).map((r) => decodeURIComponent(r.url));
    assert.strictEqual(pages.length, 2);
    assert.match(pages[0], /count="3" page="1"/);
    assert.match(pages[1], /page="2" paging-cookie="&lt;cookie page=&quot;1&quot;&gt;&lt;contactid last=&quot;\{C1\}&quot; \/&gt;&lt;\/cookie&gt;"/);
    const html = S.webviewViews["lantern.results"].webview.html;
    assert.match(html, /"truncated":true/);
    assert.strictEqual((html.match(/"fullname"|Person \d[AB]/g) || []).filter((x) => x.startsWith("Person")).length, 3);
  });

  await step("run several statements: one bad statement doesn't stop the others", async () => {
    S.activeTextEditor = editorFor("SELECT TOP 2 name FROM account;\nSELECT nonsense FROM nosuchtable;");
    await run("query.run");
    const html = S.webviewViews["lantern.results"].webview.html;
    assert.match(html, /"errors":\[\{"source":"SELECT nonsense FROM nosuchtable","message":"There's no table named \\"nosuchtable\\"/);
    assert.match(html, /"table":"account"/);
  });

  await step("run FetchXML directly", async () => {
    requests.length = 0;
    S.activeTextEditor = editorFor('<fetch top="1"><entity name="account"><attribute name="name" /></entity></fetch>', "xml");
    await run("query.run");
    assert.match(decodeURIComponent(requests.find((r) => r.url.includes("fetchXml=")).url), /<fetch top="1"><entity name="account">/);
    S.activeTextEditor = undefined;
  });

  await step("SQL completions: tables after FROM, columns after an alias", async () => {
    const sqlProvider = S.completionProviders.find((x) => x.sel.language === "sql").p;
    const text = "SELECT a.\nFROM account a";
    const doc = { ...editorFor(text).document, getText: (range) => (range ? "SELECT a." : text) };
    const cols = await sqlProvider.provideCompletionItems(doc, { line: 0, character: 9 });
    assert.ok(cols.some((i) => i.label.label === "fax"));
    assert.ok(!cols.some((i) => i.kind === 13), "no keywords after alias.");
    const doc2 = { ...editorFor("SELECT * FROM acc").document, getText: () => "SELECT * FROM acc" };
    const tables = await sqlProvider.provideCompletionItems(doc2, { line: 0, character: 17 });
    assert.ok(tables.some((i) => i.label.label === "account" && i.label.description === "Account"));
  });

  const traceTree = metaTree;
  await step("plug-in traces: list, open, filter errors, turn on logging", async () => {
    const acmeTraces = await sectionOf("acme-dynamics", "traces");
    const nodes = await traceTree.getChildren(acmeTraces);
    assert.match(nodes[0].text, /Trace logging is off/);
    const traces = nodes.filter((n) => n.kind === "trace");
    assert.deepStrictEqual(traces.map((n) => traceTree.getTreeItem(n).label), ["AccountPostUpdate", "ContactCreate"]);
    assert.strictEqual(traceTree.getTreeItem(traces[1]).iconPath.id, "error");
    assert.match(traceTree.getTreeItem(traces[0]).description, /Update account, 42 ms, 5 min ago/);
    await run("traces.open", traces[1]);
    const opened = S.opened[S.opened.length - 1];
    const text = opened.getText();
    assert.match(text, /Message:      Create on contact/);
    assert.match(text, /Exception\n---------\nSystem.NullReferenceException/);
    S.quickPickAnswers.push("Errors only");
    await run("traces.filter");
    assert.strictEqual(traceTree.getTreeItem(acmeTraces).description, "errors only, last 24 hours");
    const errorsOnly = (await traceTree.getChildren(acmeTraces)).filter((n) => n.kind === "trace");
    assert.deepStrictEqual(errorsOnly.map((n) => n.trace.id), ["t2"]);
    requests.length = 0;
    S.messageAnswers.push("Log everything");
    await run("traces.enableLogging", acmeTraces.client, "org-1");
    const patch = requests.find((r) => r.method === "PATCH");
    assert.match(patch.url, /organizations\(org-1\)$/);
    assert.deepStrictEqual(patch.body, { plugintracelogsetting: 2 });
  });

  await step("find where a column is used: forms, views, rules, steps, code", async () => {
    fs.mkdirSync(path.join(acme, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(acme, "scripts", "fax.js"), 'var x = 1;\nformContext.getAttribute("fax").setValue(null);\n');
    const [columnsNode] = await kids(accountNode);
    const fax = (await kids(columnsNode)).find((n) => n.column.logicalName === "fax");
    await run("metadata.findUsages", fax);
    const preview = S.executed.filter((e) => e[0] === "markdown.showPreview").pop();
    const report = S.contentProviders["dataverse-meta"].provideTextDocumentContent(preview[1]);
    assert.match(report, /# Where Fax \(`fax`\) is used/);
    assert.match(report, /\*\*Account\*\* \(Main\)\n\n- Summary > Account Information/);
    assert.match(report, /\*\*Active Accounts\*\* \(Public view\): shown as a column, filter/);
    assert.doesNotMatch(report, /Quick Find/);
    assert.match(report, /\*\*Require fax for EU\*\* \(Business rule\)/);
    assert.doesNotMatch(report, /Faxless thing/, "faxnumber2 isn't fax");
    assert.match(report, /AccountPostUpdate: Update of account\*\* \(Update\)/);
    assert.doesNotMatch(report, /Other step/);
    assert.match(report, /\[scripts\/fax\.js:2\]\(file:.*fax\.js#L2\)/);
    const line2 = await run("metadata.findUsages", (await kids(columnsNode)).find((n) => n.column.logicalName === "address1_line2"));
    const report2 = S.contentProviders["dataverse-meta"].provideTextDocumentContent(S.executed.filter((e) => e[0] === "markdown.showPreview").pop()[1]);
    assert.match(report2, /inside address1_composite/);
    assert.match(report2, /OnChange runs cr36f_AccountFormOnLoad: AddressStreet3Hide/);
  });

  await step("edit user settings: shows current values, confirms, updates each user", async () => {
    requests.length = 0;
    S.quickPickAnswers.push((list) => list.filter((i) => i.label !== "Alan Turing"), "Records per page", "100");
    S.messageAnswers.push("Update");
    await run("editUserSettings", { client: require("../out/core/clients.js").readClient(acme) });
    const patches = requests.filter((r) => r.method === "PATCH");
    assert.deepStrictEqual(patches.map((p) => [p.url.split("/").pop(), p.body]), [
      ["usersettingscollection(u1)", { paginglimit: 100 }],
      ["usersettingscollection(u2)", { paginglimit: 100 }],
    ]);
    assert.match(lastMessage()[1], /Updated records per page for 2 users/);
  });

  await step("metadata right-click: select top, script select, counts, copy, inserts", async () => {
    const lastSql = () => S.createdDocs.filter((d) => d.languageId === "sql").pop().getText();
    requests.length = 0;
    await run("metadata.selectTop", accountNode);
    assert.strictEqual(lastSql(), "-- Dataverse: acme-dynamics\nSELECT TOP 1000 *\nFROM account\n");
    assert.ok(requests.some((r) => r.url.includes("accounts?fetchXml=")), "and runs it");

    await run("metadata.refresh", accountNode);
    requests.length = 0;
    await run("metadata.scriptSelect", accountNode);
    const script = lastSql();
    assert.match(script, /SELECT TOP 100\n    name,\n    address1_line2,/, "primary name first (accountid isn't a listed column here), then by name");
    assert.doesNotMatch(script, /address1_composite/, "columns that can't be read are left out");
    assert.doesNotMatch(script, /parentaccountidname/);
    assert.ok(!requests.some((r) => r.url.includes("fetchXml=")), "scripted query isn't run");

    S.messageAnswers.push(undefined);
    await run("metadata.countRows", accountNode);
    assert.match(lastMessage()[1], /Account has about 1,234 rows/);

    await run("metadata.copy.entitySetName", accountNode);
    assert.strictEqual(S.clipboard, "accounts");
    await run("metadata.copy.webApiUrl", accountNode);
    assert.strictEqual(S.clipboard, "https://acme.crm.dynamics.com/api/data/v9.2/accounts");

    const [columnsNode, formsNode] = await kids(accountNode);
    const industry = (await kids(columnsNode)).find((n) => n.column.logicalName === "industrycode");
    await run("metadata.copy.schemaName", industry);
    assert.strictEqual(S.clipboard, "industrycode");
    await run("metadata.valueCounts", industry);
    assert.strictEqual(lastSql(), "-- Dataverse: acme-dynamics\nSELECT industrycode, COUNT(*) AS count\nFROM account\nGROUP BY industrycode\nORDER BY count DESC\n");
    await run("metadata.selectWithColumn", industry);
    assert.match(lastSql(), /SELECT TOP 1000 name, industrycode\nFROM account\nWHERE industrycode IS NOT NULL/);

    const [accounting] = await kids(industry);
    await run("metadata.copy.label", accounting);
    assert.strictEqual(S.clipboard, "Accounting");
    const inserted = [];
    S.activeTextEditor = { document: { uri: vscode.Uri.file(extensionless), languageId: "javascript", getText: () => "" }, insertSnippet: (snip) => inserted.push(snip.value) };
    await run("metadata.insertSetValue", accounting);
    const [form] = await kids(formsNode);
    const tab = (await kids(form)).find((n) => n.kind === "tab");
    const [section] = await kids(tab);
    await run("metadata.insertUiGet", section);
    S.activeTextEditor = undefined;
    assert.deepStrictEqual(inserted, [
      'formContext.getAttribute("industrycode").setValue(1); // Accounting',
      'formContext.ui.tabs.get("SUMMARY_TAB").sections.get("ACCOUNT_INFORMATION")',
    ]);

    await run("metadata.addEarlyBound", accountNode);
    const cfg = JSON.parse(fs.readFileSync(path.join(acme, "client.json"), "utf8"));
    assert.ok(cfg.earlyBound.entities.includes("account"));
    assert.strictEqual(cfg.earlyBound.entities.filter((e) => e === "account").length, 1, "not added twice");
  });

  await step("event handlers open their function: local file, Dataverse copy, or a clear warning", async () => {
    fs.writeFileSync(extensionless, [
      "// Account form",
      "/** @param {Xrm.Events.EventContext} executionContext */",
      "this.formOnLoad = function (executionContext) {",
      "    this.AddressStreet3Hide(executionContext);",
      "};",
      "",
      "this.AddressStreet3Hide = function (executionContext) {",
      "};",
      "",
    ].join("\n"));
    const [, formsNode] = await kids(accountNode);
    const [form] = await kids(formsNode);
    const [events] = await kids(form);
    const eventNodes = await kids(events);
    const handlers = (await Promise.all(eventNodes.map(kids))).flat();
    const onLoad = handlers.find((h) => h.handler.functionName === "formOnLoad");
    const item = metaTree.getTreeItem(onLoad);
    assert.strictEqual(item.command.command, "lantern.metadata.goToHandler", "clicking a handler opens it");
    assert.strictEqual(item.contextValue, "meta.handler");
    await run("metadata.goToHandler", onLoad);
    assert.strictEqual(S.lastShow.target.uri.fsPath, extensionless);
    assert.deepStrictEqual(S.lastShow.options.selection.args, [2, 5, 2, 15], "selects the definition, not the call on line 4");
    const change = handlers.find((h) => h.handler.functionName === "AddressStreet3Hide");
    await run("metadata.goToHandler", change);
    assert.deepStrictEqual(S.lastShow.options.selection.args, [6, 5, 6, 23]);

    webResources["acme_/scripts/remote.js"] = { id: "44444444-4444-4444-4444-444444444444", content: Buffer.from("var Acme = Acme || {};\nAcme.Remote = {\n  onSave: function (ctx) {}\n};\n").toString("base64") };
    const client = require("../out/core/clients.js").readClient(acme);
    const remoteNode = { kind: "handler", client, event: { name: "onsave", handlers: [] }, handler: { functionName: "Acme.Remote.onSave", libraryName: "acme_/scripts/remote.js", enabled: true, passExecutionContext: true } };
    S.messageAnswers.push("Open from Dataverse");
    await run("metadata.goToHandler", remoteNode);
    assert.strictEqual(S.lastShow.target.uri.scheme, "dataverse-wr");
    assert.deepStrictEqual(S.lastShow.options.selection.args, [2, 2, 2, 8]);

    const text = fs.readFileSync(extensionless, "utf8");
    const runsOn = (await S.codeLensProviders[0].provideCodeLenses({ uri: vscode.Uri.file(extensionless), languageId: "javascript", getText: () => text }))
      .filter((l) => l.command.title.startsWith("$(zap)"));
    assert.deepStrictEqual(runsOn.map((l) => [l.range.args[0], l.command.title]), [
      [2, "$(zap) Runs on Account (Main) OnLoad"],
      [6, "$(zap) Runs on Account (Main) OnChange of address1_line2"],
    ]);

    const missing = { ...onLoad, handler: { ...onLoad.handler, functionName: "formOnSave" } };
    await run("metadata.goToHandler", missing);
    assert.match(lastMessage()[1], /Couldn't find a definition of formOnSave in cr36f_AccountFormOnLoad/);
  });

  const acmeClient = () => require("../out/core/clients.js").readClient(acme);
  const resultsHtml = () => S.webviewViews["lantern.results"].webview.html;
  const RECORD = "aaaaaaaa-1111-2222-3333-444444444444";

  await step("publish all customizations", async () => {
    requests.length = 0;
    await run("publishAll", { client: acmeClient() });
    assert.ok(requests.some((r) => r.method === "POST" && r.url.endsWith("PublishAllXml")));
    assert.match(lastMessage()[1], /Published all customizations in acme\.crm\.dynamics\.com/);
  });

  await step("copy a query as code: QueryExpression from the editor, JavaScript from the results toolbar", async () => {
    const text = "SELECT TOP 5 name FROM account WHERE statecode = 0;\nSELECT fullname FROM contact";
    S.activeTextEditor = {
      document: { ...editorFor(text).document, offsetAt: () => 10 },
      selection: { isEmpty: true, active: {} },
    };
    S.quickPickAnswers.push("C#: QueryExpression");
    await run("query.copyAs");
    assert.match(S.clipboard, /new QueryExpression\("account"\)[\s\S]*TopCount = 5[\s\S]*AddCondition\("statecode", ConditionOperator.Equal, 0\)/, "statement under the cursor");
    S.activeTextEditor = editorFor("SELECT industrycode, COUNT(*) FROM account GROUP BY industrycode");
    S.activeTextEditor.selection.active = {};
    S.activeTextEditor.document.offsetAt = () => 0;
    S.quickPickAnswers.push("C#: QueryExpression");
    await run("query.copyAs");
    assert.match(lastMessage()[1], /QueryExpression can't do GROUP BY/);

    S.activeTextEditor = editorFor("SELECT TOP 2 name FROM account");
    await run("query.run");
    S.quickPickAnswers.push("JavaScript: Xrm.WebApi");
    await S.webviewViews["lantern.results"].webview.send({ cmd: "code", set: 0 });
    assert.match(S.clipboard, /Xrm\.WebApi\.retrieveMultipleRecords\("account", "\?fetchXml=" \+ encodeURIComponent\(fetchXml\)\)/);
    S.quickPickAnswers.push("Web API URL");
    await S.webviewViews["lantern.results"].webview.send({ cmd: "code", set: 0 });
    assert.match(S.clipboard, /^https:\/\/acme\.crm\.dynamics\.com\/api\/data\/v9\.2\/accounts\?fetchXml=%3Cfetch%20top%3D%222%22/);
    S.activeTextEditor = undefined;
  });

  await step("run a query as another user (impersonation header)", async () => {
    requests.length = 0;
    S.activeTextEditor = editorFor("SELECT TOP 2 name FROM account");
    S.quickPickAnswers.push("Ada Lovelace");
    await run("query.runAs");
    const q = requests.find((r) => r.url.includes("accounts?fetchXml="));
    assert.strictEqual(q.headers.MSCRMCallerID, "u1");
    assert.strictEqual(S.webviewViews["lantern.results"].description, "q.sql (acme-dynamics, as Ada Lovelace)");
    S.activeTextEditor = undefined;
  });

  await step("UPDATE and DELETE: preview, confirm, apply; cancel changes nothing; lookups refused", async () => {
    requests.length = 0;
    S.activeTextEditor = editorFor("UPDATE account SET fax = '555-0199', donotemail = TRUE WHERE statecode = 0");
    S.messageAnswers.push("Update 2 Rows");
    await run("query.run");
    const confirm = S.messages.filter((m) => m[0] === "warn").pop()[1];
    assert.match(confirm, /Set fax = '555-0199', donotemail = Yes on 2 Account rows\?/);
    const patches = requests.filter((r) => r.method === "PATCH");
    assert.deepStrictEqual(patches.map((p) => [p.url.split("/").pop(), p.body]), [
      ["accounts(a1)", { fax: "555-0199", donotemail: true }],
      ["accounts(a2)", { fax: "555-0199", donotemail: true }],
    ]);
    assert.match(resultsHtml(), /"raw":"Updated"/);

    requests.length = 0;
    S.activeTextEditor = editorFor("DELETE FROM account");
    S.messageAnswers.push(undefined);
    await run("query.run");
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /Delete 2 Account rows\? This can't be undone\./);
    assert.ok(!requests.some((r) => r.method === "DELETE"), "cancel deletes nothing");
    assert.match(resultsHtml(), /Cancelled\. Nothing was changed\./);

    S.activeTextEditor = editorFor("DELETE FROM account WHERE name = 'Contoso'");
    S.messageAnswers.push("Delete 2 Rows");
    requests.length = 0;
    await run("query.run");
    assert.deepStrictEqual(requests.filter((r) => r.method === "DELETE").map((r) => r.url.split("/").pop()), ["accounts(a1)", "accounts(a2)"]);

    S.activeTextEditor = editorFor("UPDATE account SET parentaccountid = 'p9'");
    await run("query.run");
    assert.match(resultsHtml(), /parentaccountid needs a record ID \(GUID\), not 'p9'/);
    S.activeTextEditor = undefined;
  });

  await step("inspect a record from a pasted URL, then its audit history", async () => {
    S.clipboard = `https://acme.crm.dynamics.com/main.aspx?appid=x&pagetype=entityrecord&etn=account&id=${RECORD}`;
    S.inputAnswers.push(S.clipboard);
    await run("record.inspect", { client: acmeClient() });
    const html = resultsHtml();
    assert.match(html, /"columns":\["Column","Logical name","Type","Value"\]/);
    assert.match(html, /\[\{"raw":"Industry"\},\{"raw":"industrycode"\},\{"raw":"Picklist"\},\{"raw":1,"formatted":"Accounting"\}\]/);
    assert.match(html, /"kind":"record","hasRecord":true/);
    assert.ok(html.indexOf('"raw":"telephone3"') > html.indexOf('"raw":"industrycode"'), "empty columns sort last");

    const set = JSON.parse(/const data = (\{.*?\});\n/s.exec(html)[1]).sets[0];
    const faxRow = set.rows.findIndex((r) => r[1].raw === "fax");
    await run("results.auditColumn", { set: 0, row: faxRow, col: 0, stored: false });
    const audit = resultsHtml();
    assert.match(audit, /"columns":\["Changed on","Changed by","Event","Column","Old value","New value"\]/);
    assert.match(audit, /\{"raw":"fax"\},\{"raw":"555-0000"\},\{"raw":"555-0100"\}/);
    assert.doesNotMatch(audit, /Contoso Ltd/, "only the fax column's changes");

    S.inputAnswers.push(RECORD);
    S.quickPickAnswers.push("Account");
    await run("record.audit", { client: acmeClient() });
    assert.match(resultsHtml(), /Contoso Ltd/, "a bare GUID asks for the table, then shows every column's changes");

    S.clipboard = `account:${RECORD}`;
    await run("record.openFromClipboard", { client: acmeClient() });
    assert.match(S.opened.pop(), new RegExp(`etn=account&id=${RECORD}&pagetype=entityrecord`));
  });

  await step("plug-in steps: grouped by assembly, turn off, open the class", async () => {
    const stepsNode = await sectionOf("acme-dynamics", "steps");
    const [assembly] = await kids(stepsNode);
    assert.strictEqual(metaTree.getTreeItem(assembly).label, "AcmePlugins");
    assert.strictEqual(metaTree.getTreeItem(assembly).description, "2 steps, 1 off");
    const [create, update] = await kids(assembly);
    assert.strictEqual(metaTree.getTreeItem(update).label, "Update of account");
    assert.strictEqual(metaTree.getTreeItem(update).description, "AccountPlugin, Post-operation");
    assert.strictEqual(metaTree.getTreeItem(create).contextValue, "step.disabled");
    requests.length = 0;
    await run("steps.disable", update);
    const patch = requests.find((r) => r.method === "PATCH");
    assert.match(patch.url, /sdkmessageprocessingsteps\(s1\)$/);
    assert.deepStrictEqual(patch.body, { statecode: 1, statuscode: 2 });
    await run("steps.openCode", update);
    assert.strictEqual(S.lastShow.target.uri.fsPath, path.join(acme, "Plugins/AcmePlugins/AccountPlugin.cs"));
    assert.deepStrictEqual(S.lastShow.options.selection.args, [2, 15, 2, 28]);
  });

  await step("system jobs: failed by default, open details, filter to all", async () => {
    const jobsNode = await sectionOf("acme-dynamics", "jobs");
    assert.strictEqual(metaTree.getTreeItem(jobsNode).description, "failed, last 24 hours");
    const [failed] = await kids(jobsNode);
    assert.strictEqual(metaTree.getTreeItem(failed).iconPath.id, "error");
    assert.match(metaTree.getTreeItem(failed).description, /^Workflow, Failed, 10 min ago$/);
    await run("jobs.open", failed);
    assert.match(S.opened[S.opened.length - 1].getText(), /Couldn't send the email\.\n\nThe email address is invalid\./);
    await run("jobs.openRegarding", failed);
    assert.match(S.opened.pop(), /etn=account&id=a1/);
    S.quickPickAnswers.push("All statuses");
    await run("jobs.filter");
    assert.strictEqual((await kids(jobsNode)).length, 2);
  });

  await step("environment variables: edit an existing value, set one that only has a default", async () => {
    const node = await sectionOf("acme-dynamics", "envvars");
    const [api, retry, secret] = await kids(node);
    assert.strictEqual(metaTree.getTreeItem(api).description, "https://test");
    assert.strictEqual(metaTree.getTreeItem(retry).description, "3 (default)");
    assert.strictEqual(metaTree.getTreeItem(secret).contextValue, "envvar", "secrets aren't editable here");
    requests.length = 0;
    S.inputAnswers.push("https://prod");
    await run("envvars.edit", api);
    assert.deepStrictEqual([requests[0].method, requests[0].url.split("/").pop(), requests[0].body], ["PATCH", "environmentvariablevalues(v1)", { value: "https://prod" }]);
    requests.length = 0;
    S.inputAnswers.push("5");
    await run("envvars.edit", retry);
    const post = requests.find((r) => r.method === "POST");
    assert.match(post.url, /environmentvariablevalues$/);
    assert.deepStrictEqual(post.body, { value: "5", schemaname: "acme_RetryCount_value", "EnvironmentVariableDefinitionId@odata.bind": "/environmentvariabledefinitions(d2)" });
    S.inputAnswers.push("lots");
    await run("envvars.edit", retry);
    assert.match(S.messages.filter((m) => m[0] === "error").pop()[1], /validateInput rejected "lots": Enter a number/, "the input box refuses non-numbers");
    S.messages = S.messages.filter((m) => !(m[0] === "error" && /validateInput/.test(m[1])));
  });

  await step("environment details: who you are, roles, IDs, links", async () => {
    const node = await sectionOf("acme-dynamics", "environment");
    const details = await kids(node);
    const byLabel = Object.fromEntries(details.map((d) => [d.label, d]));
    assert.strictEqual(byLabel["Dataverse user"].value, "Nathan Brandt (na.brandt@acme.com)");
    assert.strictEqual(byLabel["Microsoft account"].value, "nathan@acme.com (not pinned)");
    assert.strictEqual(metaTree.getTreeItem(byLabel["Microsoft account"]).command.command, "lantern.signInAs");
    assert.strictEqual(byLabel["Version"].value, "9.2.26091.123");
    assert.deepStrictEqual((await kids(byLabel["Security roles"])).map((r) => r.label), ["Basic User", "System Customizer"]);
    const maker = metaTree.getTreeItem(byLabel["Open in Power Apps maker portal"]);
    assert.strictEqual(maker.command.arguments[0].toString(), "https://make.powerapps.com/environments/env-123/home");
    const envId = metaTree.getTreeItem(byLabel["Environment ID"]);
    assert.strictEqual(envId.command.command, "lantern.copyText");
    await vscode.commands.executeCommand(envId.command.command, ...envId.command.arguments);
    assert.strictEqual(S.clipboard, "env-123");
  });

  await step("sections cache their contents until refreshed", async () => {
    const node = await sectionOf("acme-dynamics", "envvars");
    await kids(node);
    requests.length = 0;
    await kids(node);
    assert.ok(!requests.some((r) => r.url.includes("environmentvariabledefinitions")), "redraw doesn't refetch");
    await run("refreshNode", node);
    await kids(node);
    assert.ok(requests.some((r) => r.url.includes("environmentvariabledefinitions")), "refresh does");
  });

  await step("HAVING: parsed, applied after the fetch, and noted where FetchXML can't express it", () => {
    const t = sqlMod.translate("SELECT name, COUNT(*) AS count FROM account GROUP BY name HAVING COUNT(*) > 1 ORDER BY count DESC", { primaryIdOf: () => "accountid" });
    assert.deepStrictEqual(t.having, [{ alias: "count", op: "gt", value: 1, text: "COUNT(*) > 1" }]);
    assert.doesNotMatch(t.fetchXml, /HAVING|having/i, "FetchXML itself has no HAVING");
    assert.throws(() => sqlMod.translate("SELECT name FROM account GROUP BY name HAVING COUNT(*) > 1"), /Select COUNT\(\*\) too/);
    const gen = require("../out/core/codegen.js");
    const input = { text: "SELECT name, COUNT(*) AS count FROM account GROUP BY name HAVING COUNT(*) > 1", isFetchXml: false, org: "https://acme.crm.dynamics.com", entitySetOf: () => "accounts" };
    assert.match(gen.generate("xrmWebApi", input).code, /^\/\/ FetchXML has no HAVING\. Keep only the rows where COUNT\(\*\) > 1\./);
    assert.match(gen.generate("webApiUrl", input).error, /A URL can't do that filtering/);
  });

  await step("Query submenu: duplicates, recent, inactive, status, owner, missing values, extra spaces", async () => {
    const lastSql = () => S.createdDocs.filter((d) => d.languageId === "sql").pop().getText().replace(/^-- Dataverse: acme-dynamics\n/, "").trimEnd();
    const [columnsNode] = await kids(accountNode);
    const columns = await kids(columnsNode);
    const col = (name) => columns.find((n) => n.column.logicalName === name);
    assert.strictEqual(metaTree.getTreeItem(col("name")).contextValue, "meta.column.text");
    assert.strictEqual(metaTree.getTreeItem(col("address1_composite")).contextValue, "meta.column.memo", "long text can't be grouped, so no duplicates or value counts");
    assert.strictEqual(metaTree.getTreeItem(col("industrycode")).contextValue, "meta.column");

    await run("metadata.query.duplicateValues", col("name"));
    assert.strictEqual(lastSql(), [
      "-- Account rows that share the same name (empty values left out)",
      "SELECT name, COUNT(*) AS count",
      "FROM account",
      "WHERE name IS NOT NULL",
      "GROUP BY name",
      "HAVING COUNT(*) > 1",
      "ORDER BY count DESC",
    ].join("\n"));
    const html = resultsHtml();
    assert.match(html, /"raw":"Contoso"/);
    assert.match(html, /"raw":"Litware"/);
    assert.doesNotMatch(html, /"raw":"Fabrikam"/, "groups of one are filtered out by HAVING");

    let offered;
    S.quickPickAnswers.push((list) => {
      offered = list;
      return list.filter((i) => ["name", "fax"].includes(i.description));
    });
    await run("metadata.query.findDuplicates", accountNode);
    assert.ok(offered.find((i) => i.description === "name").picked, "the primary name is preselected");
    assert.ok(!offered.some((i) => i.description === "address1_composite"), "long text isn't offered");
    assert.match(lastSql(), /share the same name and fax[\s\S]*WHERE name IS NOT NULL AND fax IS NOT NULL\nGROUP BY name, fax\nHAVING COUNT\(\*\) > 1/);

    await run("metadata.query.recentlyModified", accountNode);
    assert.match(lastSql(), /SELECT TOP 100 name, modifiedon, modifiedby\nFROM account\nORDER BY modifiedon DESC$/);
    await run("metadata.query.recentlyCreated", accountNode);
    assert.match(lastSql(), /SELECT TOP 100 name, createdon, createdby\nFROM account\nORDER BY createdon DESC$/);
    await run("metadata.query.inactive", accountNode);
    assert.match(lastSql(), /SELECT TOP 1000 name, statuscode, modifiedon\nFROM account\nWHERE statecode = 1\nORDER BY modifiedon DESC$/);
    await run("metadata.query.byStatus", accountNode);
    assert.match(lastSql(), /SELECT statuscode, COUNT\(\*\) AS count\nFROM account\nGROUP BY statuscode\nORDER BY count DESC$/);
    await run("metadata.query.byOwner", accountNode);
    assert.match(lastSql(), /SELECT ownerid, COUNT\(\*\) AS count/);
    await run("metadata.query.missingRequired", accountNode);
    assert.match(lastSql(), /SELECT TOP 1000 name\nFROM account\nWHERE name IS NULL$/);
    await run("metadata.query.missingValue", col("fax"));
    assert.match(lastSql(), /SELECT TOP 1000 name, createdon, modifiedon\nFROM account\nWHERE fax IS NULL\nORDER BY modifiedon DESC$/);
    await run("metadata.query.extraSpaces", col("fax"));
    assert.match(lastSql(), /SELECT TOP 1000 name, fax\nFROM account\nWHERE fax LIKE ' %' OR fax LIKE '% '$/);

    const tablesNode = await sectionOf("acme-dynamics", "tables");
    const contact = (await kids(tablesNode)).find((n) => n.table.logicalName === "contact");
    await run("metadata.query.recentlyCreated", contact);
    assert.match(lastMessage()[1], /Contact doesn't track when rows are created/, "queries that don't apply explain why instead of failing");
  });

  await step("accounts: pin one per client, sign in as it, separate tokens, pac profile kept in line", async () => {
    const auth = require("../out/ui/auth.js");
    const clientsMod = require("../out/core/clients.js");
    const cfgPath = path.join(acme, "client.json");
    const cfg = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));

    // Pick an account VS Code already knows.
    S.accounts = ["nathan@acme.com", "nathan@clientb.com"];
    process.env.DVW_PAC_USER = "nathan@clientb.com";
    S.quickPickAnswers.push("nathan@clientb.com");
    S.messageAnswers.push("Recreate Profile");
    fs.writeFileSync(logFile, "");
    await run("signInAs", { client: acmeClient() });
    assert.strictEqual(cfg().account, "nathan@clientb.com");
    assert.match(lastMessage()[1], /acme-dynamics now signs in as nathan@clientb\.com/);
    const opts = S.sessionOptions[S.sessionOptions.length - 1];
    assert.strictEqual(opts.account.label, "nathan@clientb.com", "the Web API asks VS Code for that account specifically");
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /pac profile "acmedynamics" is signed in as nathan@acme\.com, but this client uses nathan@clientb\.com/);
    assert.match(cliLog(), /pac auth delete --name acmedynamics[\s\S]*pac auth create --name acmedynamics/);

    // Tooltip shows it.
    const acmeNode = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    assert.match(metaTree.getTreeItem(acmeNode).tooltip.value, /- Account: nathan@clientb\.com\n/);

    // Token cache is per account: switching the pinned account gets a new session.
    const client = clientsMod.readClient(acme);
    auth.clearTokenCache();
    S.sessionOptions = [];
    await auth.getToken(client);
    await auth.getToken(client);
    assert.strictEqual(S.sessionOptions.length, 1, "cached for the same account");
    client.config.account = "nathan@acme.com";
    await auth.getToken(client);
    assert.strictEqual(S.sessionOptions.length, 2, "a different account doesn't reuse that token");

    // Pinned account VS Code isn't signed into: sign in now, and refuse if it ends up as someone else.
    client.config.account = "nathan@clientc.com";
    S.newSignInAccount = "someone@else.com";
    await assert.rejects(auth.getToken(client), /Signed in as someone@else\.com, but acme-dynamics\/client\.json says to use nathan@clientc\.com/);
    assert.strictEqual(S.sessionOptions[S.sessionOptions.length - 1].clearSessionPreference, true);
    await assert.rejects(auth.getToken(client, { silent: true }), /Not signed in as nathan@clientc\.com yet/);

    // Add a brand new account from Sign In As.
    S.newSignInAccount = "nathan@clientc.com";
    S.quickPickAnswers.push("$(add) Sign in with another account…");
    process.env.DVW_PAC_USER = "nathan@clientc.com";
    S.messageAnswers.push("Recreate Profile");
    await run("signInAs", { client: acmeClient() });
    assert.strictEqual(cfg().account, "nathan@clientc.com");

    // Unpin.
    S.quickPickAnswers.push("$(close) Don't pin an account");
    await run("signInAs", { client: acmeClient() });
    assert.strictEqual(cfg().account, "");
    delete S.newSignInAccount;
    delete process.env.DVW_PAC_USER;
    auth.clearTokenCache();
    assert.strictEqual(require("../out/core/pac.js").accountFromAuthList("[1] * UNIVERSAL acmedynamics  a@b.com Public User", "acmedynamics"), "a@b.com");
  });

  await step("rename: old Dataverse Workspace settings carry over once, and the old extension is pointed out", async () => {
    const migrate = require("../out/ui/migrate.js");
    S.configGlobal = { "dataverseWorkspace.authMethod": "azureCli", "dataverseWorkspace.query.maxRows": 200, "lantern.pacPath": "C:/tools/pac.exe", "dataverseWorkspace.pacPath": "old" };
    S.configWorkspace = { "dataverseWorkspace.pushOnSave": true };
    const memento = new Map();
    const state = { get: (k) => memento.get(k), update: (k, v) => (memento.set(k, v), Promise.resolve()) };
    assert.strictEqual(await migrate.migrateLegacySettings(state), 3);
    assert.strictEqual(S.configGlobal["lantern.authMethod"], "azureCli");
    assert.strictEqual(S.configGlobal["lantern.query.maxRows"], 200);
    assert.strictEqual(S.configGlobal["lantern.pacPath"], "C:/tools/pac.exe", "settings already made under the new name win");
    assert.strictEqual(S.configWorkspace["lantern.pushOnSave"], true);
    assert.strictEqual(await migrate.migrateLegacySettings(state), 0, "only once");
    S.installedExtensions = ["local.dataverse-workspace"];
    S.messageAnswers.push(undefined);
    await migrate.noticeLegacyExtension();
    assert.match(lastMessage()[1], /Lantern replaces Dataverse Workspace/);
    delete S.installedExtensions;
  });

  await step("solutions: add from the org, open their web resources, list unlisted folders, remove", async () => {
    const cfgPath = path.join(acme, "client.json");
    const cfg = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    let offered;
    S.quickPickAnswers.push((list) => {
      offered = list;
      return list.filter((i) => i.description === "Cr7e97c");
    });
    S.messageAnswers.push(undefined);
    await run("solutions.add", { client: acmeClient() });
    assert.ok(!offered.some((i) => i.description === "AcmeCore"), "solutions already added aren't offered again");
    assert.match(offered.find((i) => i.description === "Default").detail, /slow to pull/);
    assert.match(offered.find((i) => i.description === "msdynce_Sales").detail, /^Managed \(read-only\), Microsoft, version 9\.0/);
    assert.strictEqual(offered[offered.length - 1].description, "msdynce_Sales", "managed solutions list last");
    assert.deepStrictEqual(cfg().solutions, ["AcmeCore", "Cr7e97c"]);
    assert.match(lastMessage()[1], /Added Cr7e97c to acme-dynamics/);

    const clientNode = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    const group = (await kids(clientNode)).find((n) => n.kind === "group" && n.group === "solutions");
    assert.strictEqual(metaTree.getTreeItem(group).contextValue, "group.solutions.connected", "the + button shows on Solutions");
    const [core, cr] = await kids(group);
    assert.deepStrictEqual([metaTree.getTreeItem(core).description, metaTree.getTreeItem(cr).description], ["pulled", "not pulled yet"]);
    assert.strictEqual(metaTree.getTreeItem(core).contextValue, "solution.configured.pulled");

    const [, webResourcesNode] = await kids(core);
    const resources = await kids(webResourcesNode);
    assert.deepStrictEqual(resources.map((n) => n.resource.name), ["acme_/scripts/remote.js", "cr36f_AccountFormOnLoad"]);
    await run("webResources.open", resources[1]);
    assert.strictEqual(S.lastShow.target.fsPath, path.join(acme, "AcmeCore/src/WebResources/cr36f_AccountFormOnLoad"), "opens the local copy");
    await run("webResources.open", resources[0]);
    assert.strictEqual(S.lastShow.target.uri.scheme, "dataverse-wr", "no local copy: opens the Dataverse version");

    // An unpacked solution that isn't in client.json yet.
    const other = path.join(acme, "OtherSol");
    fs.mkdirSync(path.join(other, "Other"), { recursive: true });
    fs.writeFileSync(path.join(other, "Other/Solution.xml"), "<UniqueName>OtherSol</UniqueName>");
    const third = (await kids(group)).find((n) => n.unique === "OtherSol");
    assert.strictEqual(metaTree.getTreeItem(third).description, "pulled, not in client.json");
    await run("solutions.addLocal", third);
    assert.deepStrictEqual(cfg().solutions, ["AcmeCore", "Cr7e97c", "OtherSol"]);

    for (const name of ["Cr7e97c", "OtherSol"]) {
      const node = (await kids(group)).find((n) => n.unique === name);
      S.messageAnswers.push("Remove");
      await run("solutions.remove", node);
    }
    assert.deepStrictEqual(cfg().solutions, ["AcmeCore"]);
    assert.ok(fs.existsSync(other), "removing a solution leaves its folder alone");
    fs.rmSync(other, { recursive: true, force: true });
  });

  const reportText = () => S.contentProviders["dataverse-meta"].provideTextDocumentContent(S.executed.filter((e) => e[0] === "markdown.showPreview").pop()[1]);

  await step("Show Dependencies: Dataverse's own tracking, with names, for a column and a web resource", async () => {
    const [columnsNode] = await kids(accountNode);
    const fax = (await kids(columnsNode)).find((n) => n.column.logicalName === "fax");
    await run("dependencies.show", fax);
    const report = reportText();
    assert.match(report, /# Dependencies of Fax \(account\.fax\)/);
    assert.match(report, /## Used by \(4\)/, "duplicates from Dataverse are merged");
    assert.match(report, /\*\*Form\*\*\n\n- Account \(account\)/);
    assert.match(report, /\*\*View\*\*\n\n- Active Accounts \(account\)/);
    assert.match(report, /\*\*Process\*\*\n\n- Require fax for EU/);
    assert.match(report, /\*\*Component type 9999\*\*\n\n- zz/, "unknown types still listed");
    assert.match(report, /## Uses \(1\)[\s\S]*\*\*Table\*\*\n\n- Account \(account\)/);
    assert.match(report, /Use \*\*Find Where Column Is Used\*\* for those/);

    await run("dependencies.show", vscode.Uri.file(extensionless));
    assert.match(reportText(), /# Dependencies of cr36f_AccountFormOnLoad[\s\S]*## Used by \(1\)[\s\S]*- Account \(account\)/);
  });

  const SCRIPT = [
    "// Account form",
    "/** @param {Xrm.Events.EventContext} executionContext */",
    "this.formOnLoad = function (executionContext) {",
    "    var formContext = executionContext.getFormContext();",
    "    const fax = formContext.getAttribute(\"fax\");",
    "    if (fax.getValue() == null) {",
    "        fax.setValue(\"123-4567\");",
    "        formContext.getControl(\"fax\").addNotification({ messages: [\"Default\"] });",
    "    }",
    "    formContext.getAttribute(\"telephone3\").setRequiredLevel(\"required\");",
    "    formContext.getAttribute(fieldName).getValue();",
    "    this.AddressStreet3Hide(executionContext);",
    "};",
    "",
    "this.AddressStreet3Hide = function (executionContext) {",
    "    var formContext = executionContext.getFormContext();",
    "    const isVisible = formContext.getAttribute(\"address1_line2\")?.getValue() !== null;",
    "    formContext.getControl(\"address1_composite_compositionLinkControl_address1_line3\").setVisible(isVisible);",
    "    formContext.ui.tabs.get(\"SUMMARY_TAB\").sections.get(\"ADDRESS\").setVisible(true);",
    "    formContext.ui.tabs.get(\"OLD_TAB\").setVisible(false);",
    "};",
    "",
    "this.helper = function (x) { return Xrm.WebApi.retrieveMultipleRecords(\"contact\", \"?$top=1\"); };",
    "",
  ].join("\n");

  await step("what a function touches: columns, controls, tabs, calls, runtime names, checked against the forms", async () => {
    fs.writeFileSync(extensionless, SCRIPT);
    await run("code.analyzeFunction", vscode.Uri.file(extensionless), "formOnLoad");
    let report = reportText();
    assert.match(report, /# this\.formOnLoad/);
    assert.match(report, /Runs on Account \(Main\) OnLoad\./);
    assert.match(report, /\| `fax` \| Fax \| getValue, setValue \(\[line 5\]/);
    assert.match(report, /\| `telephone3` \| Address 1: Telephone 3 \| setRequiredLevel .*\| \*\*no\*\* \|/, "flags a column that isn't on any form");
    assert.match(report, /\| `fax` \| addNotification .*\| yes \|/);
    assert.match(report, /## Functions it calls\n\n- \*\*AddressStreet3Hide\*\*/);
    assert.match(report, /## Names built at runtime[\s\S]*`getAttribute\(fieldName\)`/);

    // From the handler in the tree.
    const [, formsNode] = await kids(accountNode);
    const [form] = await kids(formsNode);
    const [events] = await kids(form);
    const handler = (await Promise.all((await kids(events)).map(kids))).flat().find((h) => h.handler.functionName === "AddressStreet3Hide");
    await run("code.analyzeFunction", handler);
    report = reportText();
    assert.match(report, /Runs on Account \(Main\) OnChange of address1_line2\./);
    assert.match(report, /\| `address1_composite_compositionLinkControl_address1_line3` \| setVisible .*\| yes \|/, "composite parts count as on the form");
    assert.match(report, /Section `SUMMARY_TAB\/ADDRESS`: setVisible/);
    assert.match(report, /Tab `OLD_TAB`: setVisible .* \*\*not on any form\*\*/);

    // From the cursor in the editor.
    const offset = SCRIPT.indexOf("retrieveMultipleRecords");
    S.activeTextEditor = { document: { uri: vscode.Uri.file(extensionless), languageId: "javascript", getText: () => SCRIPT, offsetAt: () => offset }, selection: { active: {} } };
    await run("code.analyzeFunction");
    assert.match(reportText(), /# this\.helper[\s\S]*`retrieveMultipleRecords` on \*\*contact\*\*/);
    S.activeTextEditor = undefined;

    // The "Runs on" CodeLens opens this report.
    const lens = (await S.codeLensProviders[0].provideCodeLenses({ uri: vscode.Uri.file(extensionless), languageId: "javascript", getText: () => SCRIPT }))
      .find((l) => l.command.title.startsWith("$(zap)"));
    assert.deepStrictEqual([lens.command.command, lens.command.arguments[1]], ["lantern.code.analyzeFunction", "this.formOnLoad"].map((x, i) => (i === 1 ? "formOnLoad" : x)));
  });

  await step("library outline: functions, where each runs, callers, and likely dead code", async () => {
    await run("code.outline", vscode.Uri.file(extensionless));
    const report = reportText();
    assert.match(report, /# cr36f_AccountFormOnLoad\n\n3 functions, checked against the forms of \*\*account\*\*/);
    assert.match(report, /\| \*\*formOnLoad\*\* \| \[3\]\(.*\) \| Account \(Main\) OnLoad \|  \|/);
    assert.match(report, /\| \*\*AddressStreet3Hide\*\* \| \[15\]\(.*\) \| Account \(Main\) OnChange of address1_line2 \| formOnLoad \|/);
    assert.match(report, /## Not registered or called here\n\n- helper/);
  });

  await step("Find Where Column Is Used names the function and where it runs", async () => {
    const [columnsNode] = await kids(accountNode);
    await run("metadata.findUsages", (await kids(columnsNode)).find((n) => n.column.logicalName === "fax"));
    assert.match(reportText(), /cr36f_AccountFormOnLoad:5\]\(.*\) in \*\*formOnLoad\*\* \(runs on Account \(Main\) OnLoad\): `const fax = formContext\.getAttribute\("fax"\);`/);
  });

  await step("plug-in step vs. its class: images, filtering columns, reads and writes", async () => {
    fs.writeFileSync(path.join(acme, "Plugins/AcmePlugins/AccountPlugin.cs"), [
      "using Microsoft.Xrm.Sdk;",
      "namespace Acme {",
      "  public class AccountPlugin : IPlugin {",
      "    public void Execute(System.IServiceProvider sp) {",
      "      var context = (IPluginExecutionContext)sp.GetService(typeof(IPluginExecutionContext));",
      "      if (!(context.InputParameters.TryGetValue(\"Target\", out var targetObj) && targetObj is Entity target)) return;",
      "      var preImage = context.PreEntityImages.TryGetValue(\"PreImage\", out var pre) ? pre : null;",
      "      var name = target.GetAttributeValue<string>(\"name\");",
      "      var phone = target.GetAttributeValue<string>(\"telephone1\");",
      "      var oldRevenue = preImage?.GetAttributeValue<Money>(\"revenue\");",
      "      var oldPhone = preImage?.GetAttributeValue<string>(\"telephone2\");",
      "      var after = context.PostEntityImages[\"After\"];",
      "      target[\"description\"] = \"Checked\";",
      "      var task = new Entity(\"task\");",
      "      task[\"subject\"] = \"Follow up \" + name;",
      "    }",
      "  }",
      "}",
    ].join("\n"));
    const stepsNode = await sectionOf("acme-dynamics", "steps");
    const [assembly] = await kids(stepsNode);
    const update = (await kids(assembly)).find((n) => n.step.message === "Update");
    await run("steps.analyze", update);
    const report = reportText();
    assert.match(report, /Filtering columns: `name`, `fax`\./);
    assert.match(report, /Images: Pre-image `PreImage` \(revenue\)\./);
    assert.match(report, /- The code reads the post-image "After", but this step has no post-image with that alias/);
    assert.match(report, /- telephone2 is read from the "PreImage" image \(line 11\), but that image only includes revenue\./);
    assert.match(report, /- On Update, Target only contains the columns that changed\. telephone1 is read from Target but not in the step's filtering columns/);
    assert.doesNotMatch(report, /revenue is read from/, "columns the image includes are fine");
    assert.match(report, /## Columns it writes[\s\S]*\| `description` \| Target \|[\s\S]*\| `subject` \| other \|/);
    assert.match(report, /- creates or updates \*\*task\*\*/);
  });

  await step("live warnings: unknown columns, columns not on a form, controls, tabs, missing handlers", async () => {
    const diag = require("../out/ui/diagnostics.js");
    const text = [
      "this.formOnLoad = function (ctx) {",
      "  const fc = ctx.getFormContext();",
      "  fc.getAttribute(\"fax2\").getValue();",
      "  fc.getAttribute(\"telephone3\").getValue();",
      "  fc.getAttribute(\"fax\").getValue();",
      "  fc.getControl(\"nope\").setVisible(false);",
      "  fc.ui.tabs.get(\"OLD_TAB\").setVisible(false);",
      "  fc.ui.tabs.get(\"SUMMARY_TAB\").sections.get(\"GONE\").setVisible(false);",
      "};",
    ].join("\n");
    const doc = { uri: vscode.Uri.file(extensionless), languageId: "javascript", getText: () => text, positionAt: (o) => ({ offset: o }) };
    fs.writeFileSync(extensionless, text);
    S.openListeners.forEach((l) => l(doc));
    await new Promise((r) => setTimeout(r, 50));
    const found = S.diagnostics.lantern.get(extensionless).map((d) => [d.severity, d.message]);
    assert.deepStrictEqual(found, [
      [0, "fax2 isn't a column of account. getAttribute returns null."],
      [1, "telephone3 isn't on any account form, so getAttribute returns null at runtime. Add it to the form (it can be hidden)."],
      [1, "No control named nope on any account form, so getControl returns null."],
      [1, "No tab named OLD_TAB on any account form."],
      [1, "Tab SUMMARY_TAB has no section named GONE on any account form."],
      [1, "Account (Main) onchange of address1_line2 calls AddressStreet3Hide, which isn't defined in this file. That handler fails when the event fires."],
    ]);
    const problems = diag.findScriptProblems('fc.getAttribute("fax2")', "account", [], [], undefined);
    assert.deepStrictEqual(problems, [], "nothing is flagged until metadata is loaded");
    fs.writeFileSync(extensionless, SCRIPT);
  });

  await step("command bar functions count as used in the outline", async () => {
    const ribbonFile = path.join(acme, "AcmeCore/src/Entities/Account/RibbonDiff.xml");
    fs.mkdirSync(path.dirname(ribbonFile), { recursive: true });
    fs.writeFileSync(ribbonFile, `<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="acme.account.Command.Lookup"><Actions>
      <JavaScriptFunction Library="$webresource:cr36f_AccountFormOnLoad" FunctionName="helper" /></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>`);
    await run("code.outline", vscode.Uri.file(extensionless));
    const report = reportText();
    assert.match(report, /\| \*\*helper\*\* \| \[23\]\(.*\) \| command bar command acme\.account\.Command\.Lookup \|/);
    assert.doesNotMatch(report, /## Not registered or called here/, "nothing left over once the command bar is counted");
  });

  await step("FetchXML IntelliSense: tables, columns of the right entity, link-entity from/to, operators", async () => {
    const provider = S.completionProviders.find((c) => c.sel.language === "xml").p;
    const ask = async (text) => {
      const doc = { uri: vscode.Uri.file(path.join(acme, "queries", "q.xml")), getText: () => text, offsetAt: () => text.length };
      return (await provider.provideCompletionItems(doc, { line: 0, character: text.length })) ?? [];
    };
    const labels = (items) => items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    assert.ok(labels(await ask('<fetch><entity name="acc')).includes("account"));
    assert.ok(labels(await ask('<fetch><entity name="account"><attribute name="f')).includes("fax"));
    const link = '<fetch><entity name="account"><link-entity name="contact" from="contactid" to="';
    assert.ok(labels(await ask(link)).includes("parentaccountid"), "to= names a column of the parent entity");
    assert.ok(labels(await ask('<fetch><entity name="account"><filter><condition attribute="name" operator="')).includes("begins-with"));
    assert.deepStrictEqual(await ask('<fetch><entity name="account"><link-entity name="contact"><attribute name="'), [], "contact has no columns in the fixture");
  });

  await step("INSERT and lookups in UPDATE (bind, clear, and polymorphic owner)", async () => {
    requests.length = 0;
    S.activeTextEditor = editorFor("INSERT INTO account (name, parentaccountid, industrycode) VALUES ('New Co', 'aaaaaaaa-1111-2222-3333-444444444444', 'Accounting')");
    S.messageAnswers.push("Create 1 Row");
    await run("query.run");
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /Create 1 Account row \(name, parentaccountid, industrycode\)\?/);
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/accounts"));
    assert.deepStrictEqual(post.body, { name: "New Co", "parentaccountid@odata.bind": "/accounts(aaaaaaaa-1111-2222-3333-444444444444)", industrycode: 1 });

    requests.length = 0;
    S.activeTextEditor = editorFor("UPDATE account SET parentaccountid = NULL, fax = '1' WHERE name = 'Contoso'");
    S.messageAnswers.push("Update 2 Rows");
    await run("query.run");
    assert.deepStrictEqual(requests.filter((r) => r.method === "DELETE").map((r) => r.url.split("/v9.2/")[1]), ["accounts(a1)/parentaccountid/$ref", "accounts(a2)/parentaccountid/$ref"]);

    S.activeTextEditor = editorFor("UPDATE account SET ownerid = 'aaaaaaaa-1111-2222-3333-444444444444'");
    await run("query.run");
    assert.match(resultsHtml(), /ownerid can point to systemuser or team; write it as 'systemuser:aaaaaaaa-1111-2222-3333-444444444444'/);
    S.activeTextEditor = undefined;
  });

  await step("CSV import: header matching, preview, create and update by ID, choices by label", async () => {
    const csvMod = require("../out/core/csv.js");
    assert.deepStrictEqual(csvMod.parseCsv('a,b\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
    const file = path.join(tmp, "accounts.csv");
    fs.writeFileSync(file, "Account Name,fax,Industry,accountid,unknowncol\nFabrikam,555,Accounting,,\nContoso,556,2,a1,x\n");
    S.openAnswers = [[vscode.Uri.file(file)]];
    S.messageAnswers.push("Import 2 Rows");
    requests.length = 0;
    await run("metadata.importCsv", accountNode);
    const confirm = S.messages.filter((m) => m[0] === "warn").pop();
    assert.match(confirm[1], /Import 2 Account rows \(1 new, 1 updated by ID\)\?/);
    assert.match(confirm[2].detail, /Ignored \(no matching column\): unknowncol/);
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/accounts"));
    assert.deepStrictEqual(post.body, { name: "Fabrikam", fax: "555", industrycode: 1 });
    const patch = requests.find((r) => r.method === "PATCH" && r.url.endsWith("accounts(a1)"));
    assert.deepStrictEqual(patch.body, { name: "Contoso", fax: "556", industrycode: 2 });
    assert.match(resultsHtml(), /"raw":"Created"[\s\S]*"raw":"Updated"/);
  });

  await step("security: a role's privileges by table, and why a user can't see a record", async () => {
    S.quickPickAnswers.push("Salesperson");
    await run("security.role", { client: acmeClient() });
    const html = resultsHtml();
    assert.match(html, /"columns":\["Table","Logical name","Create","Read","Write","Delete","Append","Append To","Assign","Share"\]/);
    assert.match(html, /\[\{"raw":"Account"\},\{"raw":"account"\},\{"raw":null\},\{"raw":"Business unit"\},\{"raw":"User"\},\{"raw":null\},\{"raw":null\},\{"raw":"Organization"\}/);
    assert.match(html, /\{"raw":"Contact"\},\{"raw":"contact"\},\{"raw":"Parent: child business units"\}/);

    S.quickPickAnswers.push("Ada Lovelace");
    S.inputAnswers.push(`account:${RECORD}`);
    await run("security.whyAccess", { client: acmeClient() });
    const report = reportText();
    assert.match(report, /# Can Ada Lovelace see this Account\?\n\n\*\*No\.\*\* Dataverse reports: no access\./);
    assert.match(report, /only within their own business unit \(Sales East\); the record belongs to acme, a different one\./);
    assert.match(report, /To give them access: share the record/);
    assert.match(report, /Their roles: Salesperson/);
  });

  await step("register a plug-in step with an image, in a solution", async () => {
    requests.length = 0;
    S.quickPickAnswers.push("AccountPlugin", "Update", "Account", "Post-operation", "Synchronous");
    S.quickPickAnswers.push((list) => list.filter((i) => ["name", "revenue"].includes(i.description)));
    S.quickPickAnswers.push((list) => list.filter((i) => i.image === "Pre"));
    S.inputAnswers.push("PreImage");
    S.quickPickAnswers.push((list) => list.filter((i) => i.description === "revenue"));
    S.quickPickAnswers.push("AcmeCore");
    S.messageAnswers.push("Register Step");
    await run("steps.register", { client: acmeClient() });
    const [step, image] = requests.filter((r) => r.method === "POST");
    assert.match(step.url, /sdkmessageprocessingsteps$/);
    assert.strictEqual(step.headers["MSCRM.SolutionUniqueName"], "AcmeCore");
    assert.deepStrictEqual(step.body, {
      name: "AccountPlugin: Update of account", stage: 40, mode: 0, rank: 1, supporteddeployment: 0, asyncautodelete: false,
      "eventhandler_plugintype@odata.bind": "/plugintypes(pt1)", "sdkmessageid@odata.bind": "/sdkmessages(m-update)",
      "sdkmessagefilterid@odata.bind": "/sdkmessagefilters(f-account-update)", filteringattributes: "name,revenue",
    });
    assert.deepStrictEqual(image.body, {
      name: "PreImage", entityalias: "PreImage", imagetype: 0, messagepropertyname: "Target", attributes: "revenue",
      "sdkmessageprocessingstepid@odata.bind": "/sdkmessageprocessingsteps(55555555-5555-5555-5555-555555555555)",
    });
  });

  await step("trace to code, and the solution's handoff document", async () => {
    await run("traces.openClass", { client: acmeClient(), trace: { typeName: "Acme.Plugins.AccountPlugin" } });
    assert.strictEqual(S.lastShow.target.uri.fsPath, path.join(acme, "Plugins/AcmePlugins/AccountPlugin.cs"));
    await run("solutions.document", { client: acmeClient(), unique: "AcmeCore" });
    const doc = fs.readFileSync(path.join(acme, "docs", "AcmeCore.md"), "utf8");
    assert.match(doc, /^# Acme Core\n\nSolution `AcmeCore`, version 1\.0\.0\.3, publisher Acme\./);
    assert.match(doc, /### Account \(`account`\)/);
    assert.match(doc, /- \*\*Account\*\* \(Main form\), libraries: cr36f_AccountFormOnLoad\n  - onload: `formOnLoad` in cr36f_AccountFormOnLoad/);
    assert.match(doc, /- `cr36f_AccountFormOnLoad` \(JavaScript\): Account form\n  - `formOnLoad`: Account \(Main\) OnLoad/);
    assert.match(doc, /  - `helper`: command bar command acme\.account\.Command\.Lookup/);
    assert.match(doc, /\| AccountPlugin: Update of account \| Update of account \| Post-operation \| Synchronous \| name,fax \| yes \|/);
    assert.match(doc, /## Environment variables \(1\)[\s\S]*\| API base URL \| `acme_ApiBaseUrl` \| Text \| https:\/\/default \|/, "the solution's own variables, from its components");
    assert.doesNotMatch(doc, /acme_RetryCount/, "variables outside the solution aren't listed");
    assert.doesNotMatch(doc, /## Not included/);
    failing = /sdkmessageprocessingsteps/;
    await run("solutions.document", { client: acmeClient(), unique: "AcmeCore" });
    failing = undefined;
    const partial = fs.readFileSync(path.join(acme, "docs", "AcmeCore.md"), "utf8");
    assert.match(partial, /## Not included\n\nThese couldn't be read when the document was generated:\n\n- Plug-in steps: Dataverse returned 500[^\n]*Simulated outage/);
  });

  await step("saved queries and recent history in the tree", async () => {
    const clientNode = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    const queriesGroup = (await kids(clientNode)).find((n) => n.kind === "group" && n.group === "queries");
    const [recent] = (await kids(queriesGroup)).filter((n) => n.kind === "recentQueries");
    const entries = await kids(recent);
    assert.ok(entries.some((e) => e.entry.sql === "SELECT TOP 2 name FROM account"), "queries that ran are in Recent");
    await run("queries.openRecent", entries[0]);
    assert.match(S.createdDocs[S.createdDocs.length - 1].getText(), new RegExp(entries[0].entry.sql.split(" ")[0]));

    const text = "-- Dataverse: acme-dynamics\nSELECT name FROM account WHERE statecode = 0";
    S.activeTextEditor = { document: { uri: vscode.Uri.parse("untitled:Untitled-9"), isUntitled: true, languageId: "sql", getText: () => text }, selection: { isEmpty: true } };
    S.inputAnswers.push("Active accounts");
    await run("queries.save");
    assert.strictEqual(fs.readFileSync(path.join(acme, "queries", "Active accounts.sql"), "utf8"), text);
    const saved = (await kids(queriesGroup)).find((n) => n.kind === "savedQuery");
    assert.strictEqual(metaTree.getTreeItem(saved).label, "Active accounts");
    S.activeTextEditor = undefined;
  });

  await step("TypeScript web resources: set up, compile on save, push the output", async () => {
    const webResourcesDir = path.join(acme, "AcmeCore/src/WebResources");
    S.openAnswers = [[vscode.Uri.file(webResourcesDir)]];
    await run("typescript.setup", { client: acmeClient() });
    const config = JSON.parse(fs.readFileSync(path.join(acme, "ts", "tsconfig.json"), "utf8"));
    assert.strictEqual(config.compilerOptions.outDir, "../AcmeCore/src/WebResources");
    assert.deepStrictEqual(config.compilerOptions.types, ["xrm"]);
    const ts = require("../out/commands/typescript.js");
    const src = path.join(acme, "ts", "acme_", "scripts", "account.ts");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "export {};\nconst x: number = 1;\n");
    assert.strictEqual(ts.outputFor(path.join(acme, "ts", "tsconfig.json"), src), path.join(webResourcesDir, "acme_", "scripts", "account.js"));
    requests.length = 0;
    fs.writeFileSync(logFile, "");
    for (const l of S.saveListeners) await l({ uri: vscode.Uri.file(src), languageId: "typescript" });
    await new Promise((r) => setTimeout(r, 20));
    assert.match(cliLog(), /tsc -p .*tsconfig\.json/);
    assert.match(fs.readFileSync(path.join(webResourcesDir, "acme_", "scripts", "account.js"), "utf8"), /^\/\/ compiled/);
    assert.ok(requests.some((r) => r.method === "PATCH" && /webresourceset\(/.test(r.url)), "the compiled file is pushed");
    fs.rmSync(path.join(acme, "ts"), { recursive: true, force: true });
  });

  await step("environments: add, switch, per-environment caches, accounts, and pac profiles", async () => {
    const cfgPath = path.join(acme, "client.json");
    const original = fs.readFileSync(cfgPath, "utf8");
    const cfg = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    S.inputAnswers.push("DEV", "TEST", "acme-test.crm.dynamics.com");
    S.quickPickAnswers.push("No extra confirmation");
    await run("environments.add", { client: acmeClient() });
    S.inputAnswers.push("PROD", "https://acme-prod.crm.dynamics.com");
    S.quickPickAnswers.push("Ask before changes");
    await run("environments.add", { client: acmeClient() });
    assert.deepStrictEqual(cfg().environments, [
      { name: "DEV", org: "https://acme.crm.dynamics.com" },
      { name: "TEST", org: "https://acme-test.crm.dynamics.com" },
      { name: "PROD", org: "https://acme-prod.crm.dynamics.com", protected: true },
    ]);
    assert.strictEqual(cfg().environment, "DEV");

    S.quickPickAnswers.push("TEST");
    await run("environments.switch", { client: acmeClient() });
    const test = acmeClient();
    assert.deepStrictEqual([test.envName, test.config.org], ["TEST", "https://acme-test.crm.dynamics.com"]);
    assert.strictEqual(require("../out/core/pac.js").profileName(test), "acmedynamicsTEST");
    const clientNode = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    assert.match(metaTree.getTreeItem(clientNode).description, /^TEST  acme-test\.crm\.dynamics\.com/);
    const qdoc = { uri: vscode.Uri.parse("untitled:q"), languageId: "sql", getText: () => "-- Dataverse: acme-dynamics\nSELECT name FROM account" };
    assert.strictEqual((await S.codeLensProviders[0].provideCodeLenses(qdoc))[0].command.title, "$(play) Run on acme-dynamics (TEST)");
    S.activeTextEditor = editorFor("SELECT TOP 2 name FROM account");
    await run("query.run");
    assert.strictEqual(S.webviewViews["lantern.results"].description, "q.sql (acme-dynamics TEST)");
    S.activeTextEditor = undefined;
    const allTables = await sectionOf("acme-dynamics", "tables");
    const account = (await kids(allTables)).find((n) => n.table.logicalName === "account");
    const [cols] = await kids(account);
    assert.deepStrictEqual((await kids(cols)).map((c) => c.column.logicalName).sort(), ["name", "telephone3"], "TEST's own metadata, not DEV's cache");

    S.quickPickAnswers.push("nathan@clientb.com");
    process.env.DVW_PAC_USER = "nathan@clientb.com";
    await run("signInAs", { client: acmeClient() });
    assert.deepStrictEqual(cfg().accounts, { TEST: "nathan@clientb.com" }, "accounts are saved per environment");
    assert.strictEqual(cfg().account, "", "the default account is left alone");
    delete process.env.DVW_PAC_USER;

    // Compare DEV with TEST.
    S.quickPickAnswers.push("DEV");
    await run("environments.switch", { client: acmeClient() });
    S.quickPickAnswers.push("TEST");
    S.messageAnswers.push("Diff Web Resources");
    await run("environments.compare", { client: acmeClient(), unique: "AcmeCore" });
    const report = reportText();
    assert.match(report, /# AcmeCore: DEV vs TEST/);
    assert.match(report, /Solution version: \*\*1\.0\.0\.3\*\* in DEV, \*\*1\.0\.0\.2\*\* in TEST\./);
    assert.match(report, /\| account\.fax \| only in DEV \|/);
    assert.match(report, /\| cr36f_AccountFormOnLoad \| content differs \|/);
    assert.match(report, /\| AccountPlugin: Create of account \| off vs on \|/);
    assert.match(report, /\| acme_ApiBaseUrl \| "https:\/\/test" vs "https:\/\/test-env" \|/);
    const diff = S.executed.filter((e) => e[0] === "vscode.diff").pop();
    assert.strictEqual(diff[3], "cr36f_AccountFormOnLoad: DEV ↔ TEST");

    // Solution operations.
    fs.writeFileSync(logFile, "");
    S.quickPickAnswers.push("Managed");
    const zip = path.join(acme, "exports", "AcmeCore_1_0_0_3_managed.zip");
    S.saveAnswers = [vscode.Uri.file(zip)];
    S.messageAnswers.push(undefined);
    await run("solutions.export", { client: acmeClient(), unique: "AcmeCore" });
    assert.match(cliLog(), /pac solution export --name AcmeCore --path .*AcmeCore_1_0_0_3_managed\.zip --environment https:\/\/acme\.crm\.dynamics\.com --overwrite --managed/);
    assert.ok(fs.existsSync(zip));

    fs.writeFileSync(logFile, "");
    S.quickPickAnswers.push("Managed", "PROD");
    S.messageAnswers.push("Import AcmeCore in PROD");
    await run("solutions.copyTo", { client: acmeClient(), unique: "AcmeCore" });
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /acme-dynamics is on PROD \(acme-prod\.crm\.dynamics\.com\), a protected environment\. Import AcmeCore there\?/);
    assert.match(cliLog(), /solution export --name AcmeCore .*--environment https:\/\/acme\.crm\.dynamics\.com[\s\S]*auth (select|create) --name acmedynamicsPROD[\s\S]*solution import --path .*--environment https:\/\/acme-prod\.crm\.dynamics\.com --publish-changes/);

    fs.writeFileSync(logFile, "");
    S.openAnswers = [[vscode.Uri.file(zip)]];
    S.quickPickAnswers.push("PROD");
    S.messageAnswers.push(undefined);
    await run("solutions.import", { client: acmeClient() });
    assert.doesNotMatch(cliLog(), /solution import/, "declining the PROD confirmation imports nothing");

    requests.length = 0;
    S.quickPickAnswers.push("1.0.0.4");
    await run("solutions.bumpVersion", { client: acmeClient(), unique: "AcmeCore" });
    assert.deepStrictEqual(requests.filter((r) => r.method === "PATCH").map((r) => [r.url.split("/v9.2/")[1], r.body]), [["solutions(sol-1)", { version: "1.0.0.4" }]]);

    await run("solutions.check", { client: acmeClient(), unique: "AcmeCore", folder: path.join(acme, "AcmeCore") });
    const checkerReport = reportText();
    assert.match(checkerReport, /## Errors \(1\)[\s\S]*meta-avoid-silverlight \| Other\/Customizations\.xml/);
    assert.match(checkerReport, /\[web-use-strict-equality-operators\]\(https:\/\/learn\.microsoft\.com\/rules\/strict\) \| WebResources\/cr36f_AccountFormOnLoad:6/);
    const onFile = S.diagnostics["lantern-checker"].get(extensionless);
    assert.deepStrictEqual(onFile.map((d) => [d.range.args[0], d.message]), [[5, "Use === instead of == (web-use-strict-equality-operators)"]]);

    // Protected environments ask before pushing.
    S.quickPickAnswers.push("PROD");
    await run("environments.switch", { client: acmeClient() });
    requests.length = 0;
    S.messageAnswers.push(undefined);
    await run("pushWebResource", vscode.Uri.file(path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js")));
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /a protected environment\. Push account\.js there\?/);
    assert.ok(!requests.some((r) => r.method === "PATCH"), "nothing pushed after declining");
    S.activeTextEditor = { document: { uri: vscode.Uri.file(path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js")), languageId: "javascript", getText: () => "" } };
    await run("refresh");
    assert.match(S.statusBarItems[0].text, /acme-dynamics \(PROD\)/);
    assert.strictEqual(S.statusBarItems[0].backgroundColor.id, "statusBarItem.warningBackground", "a protected environment shows in the status bar");
    S.activeTextEditor = undefined;

    fs.writeFileSync(cfgPath, original);
    require("../out/ui/auth.js").clearTokenCache();
    await run("refresh");
  });

  await step("every Command Palette command survives no arguments and Esc at every prompt", async () => {
    const pkg = require("../package.json");
    const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m) => m.when === "false").map((m) => m.command));
    // Commands that open things or run without prompting are fine to run; the rest must stop quietly at the first Esc.
    const skip = new Set(["lantern.initWorkspace", "lantern.refresh", "lantern.reloadWindow"]);
    let palette = pkg.contributes.commands.map((c) => c.command).filter((c) => !hidden.has(c) && !skip.has(c));
    S.quickPickAnswers = [];
    S.inputAnswers = [];
    S.messageAnswers = [];
    S.openAnswers = [];
    S.saveAnswers = [];
    const writes = [];
    const writers = [];
    const before = requests.length;
    const crashes = [];
    const sweep = async (label) => {
      for (const id of palette) {
        const requestsBefore = requests.length;
        const errorsBefore = S.messages.filter((m) => m[0] === "error").length;
        try {
          await vscode.commands.executeCommand(id);
        } catch (err) {
          crashes.push(`${label} ${id}: threw ${err.message}`);
        }
        const newErrors = S.messages.filter((m) => m[0] === "error").slice(errorsBefore);
        for (const e of newErrors) if (/Cannot read|undefined|is not a function|TypeError|ENOENT/.test(e[1])) crashes.push(`${label} ${id}: ${e[1]}`);
        for (const r of requests.slice(requestsBefore)) if (r.method !== "GET") writers.push(`${label} ${id}: ${r.method} ${r.url.split("/v9.2/")[1]}`);
      }
    };
    await sweep("no editor:");
    const script = path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js");
    const scriptText = fs.readFileSync(script, "utf8");
    S.activeTextEditor = {
      document: { uri: vscode.Uri.file(script), languageId: "javascript", getText: () => scriptText, offsetAt: () => 0, positionAt: () => ({ line: 0, character: 0 }), isUntitled: false },
      selection: { isEmpty: true, active: {} },
    };
    await sweep("in a script:");
    const sqlText = "-- Dataverse: acme-dynamics\nSELECT name FROM account";
    S.activeTextEditor = {
      document: { uri: vscode.Uri.parse("untitled:Untitled-5"), languageId: "sql", getText: () => sqlText, offsetAt: () => sqlText.length, isUntitled: true },
      selection: { isEmpty: true, active: {} },
    };
    const runsQuery = new Set(["lantern.query.run", "lantern.query.showFetchXml"]);
    const keep = palette;
    palette = keep.filter((c) => !runsQuery.has(c));
    await sweep("in a query:");
    palette = keep;
    S.activeTextEditor = undefined;
    // Push Web Resource acts on the open file straight away (it's the Ctrl+Alt+U command), and Build and Push
    // Plug-in builds and updates the client's only plug-in project, so their writes are expected.
    const pushesImmediately = /: lantern\.(pushWebResource|pushPlugin): /;
    writes.push(...writers.filter((w) => !pushesImmediately.test(w)));
    assert.ok(writers.some((w) => pushesImmediately.test(w)), "push really ran with a script open");
    if (crashes.length) console.log(crashes.join("\n"));
    assert.deepStrictEqual(crashes, [], "no crashes");
    if (writes.length) console.log(writes.join("\n"));
    assert.deepStrictEqual(writes, [], "Esc everywhere changes nothing");
    S.messages = S.messages.filter((m) => m[0] !== "error");
  });

  await step("failures in the tree show a retry, aren't cached, and recover", async () => {
    const node = await sectionOf("acme-dynamics", "envvars");
    await run("refreshNode", node);
    failing = /environmentvariabledefinitions/;
    const [err] = await kids(node);
    const item = metaTree.getTreeItem(err);
    assert.match(item.label, /^Couldn't load: Dataverse returned 500 for GET environmentvariabledefinitions\. Simulated outage$/);
    assert.strictEqual(item.command.command, "lantern.refreshNode", "the error offers a retry");
    failing = undefined;
    const ok = await kids(node);
    assert.ok(ok.some((n) => n.kind === "envvar"), "the failure wasn't cached");

    // A failing solution web resource list, and a failing table list.
    const clientNode = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    const core = (await kids((await kids(clientNode)).find((n) => n.kind === "group" && n.group === "solutions")))[0];
    const [, wrNode] = await kids(core);
    await run("refreshNode", core);
    failing = /componenttype eq 61/;
    assert.match(metaTree.getTreeItem((await kids(wrNode))[0]).label, /^Couldn't load/);
    failing = undefined;
    assert.ok((await kids(wrNode)).some((n) => n.kind === "webResource"));

    // Failures mid-command show a message and change nothing locally.
    failing = /webresourceset/;
    const before = fs.readFileSync(path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js"), "utf8");
    await run("pushWebResource", vscode.Uri.file(path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js")));
    assert.match(S.messages.filter((m) => m[0] === "error").pop()[1], /Dataverse returned 500[\s\S]*Simulated outage/);
    assert.strictEqual(fs.readFileSync(path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js"), "utf8"), before);
    failing = /PublishAllXml/;
    const infoBefore = S.messages.length;
    await run("publishAll", { client: acmeClient() });
    const after = S.messages.slice(infoBefore);
    assert.match(after.find((m) => m[0] === "error")[1], /Simulated outage/);
    assert.ok(!after.some((m) => /Published all customizations/.test(m[1])), "no success message after a failure");
    failing = undefined;
    S.messages = S.messages.filter((m) => m[0] !== "error");
  });

  await step("pushing several files: skipped ones are reported, unsupported types explained", async () => {
    const scripts = path.join(acme, "AcmeCore/src/WebResources/acme_/scripts");
    const fresh = path.join(scripts, "brand-new.js");
    const odd = path.join(scripts, "no-extension");
    fs.writeFileSync(fresh, "// new\n");
    fs.writeFileSync(odd, "data\n");
    requests.length = 0;
    S.messageAnswers.push(undefined); // decline creating brand-new.js
    const start = S.messages.length;
    await run("pushWebResource", vscode.Uri.file(path.join(scripts, "account.js")), [vscode.Uri.file(path.join(scripts, "account.js")), vscode.Uri.file(fresh), vscode.Uri.file(odd)]);
    const msgs = S.messages.slice(start).map((m) => m[1]);
    assert.ok(msgs.includes("no-extension isn't a web resource file type."), "unknown types are skipped up front");
    assert.ok(msgs.includes("Pushed and published 1 of 2 web resources (the rest were skipped)."), msgs.join(" | "));
    assert.strictEqual(requests.filter((r) => r.method === "PATCH").length, 1);
    assert.ok(requests.some((r) => r.url.endsWith("PublishXml")), "what was pushed is published");
    fs.rmSync(fresh);
    fs.rmSync(odd);
  });

  await step("client commands: configure a folder, open client.json, open in browser, client actions", async () => {
    const gamma = path.join(root, "gamma");
    fs.mkdirSync(gamma, { recursive: true });
    const unconfigured = (await metaTree.getChildren()).find((n) => n.kind === "unconfigured" && n.dir === gamma);
    assert.ok(unconfigured, "a folder without client.json is listed as unconfigured");
    await run("configureClient", unconfigured);
    assert.ok(fs.existsSync(path.join(gamma, "client.json")));
    assert.match(lastMessage()[1], /gamma is configured/);
    fs.rmSync(gamma, { recursive: true, force: true });

    await run("openClientConfig", { client: acmeClient() });
    assert.strictEqual(S.lastShow.target.fsPath, path.join(acme, "client.json"));
    await run("openInBrowser", { client: acmeClient() });
    assert.strictEqual(S.opened.pop(), "https://acme.crm.dynamics.com/main.aspx");

    let offered;
    const script = path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js");
    S.activeTextEditor = { document: { uri: vscode.Uri.file(script), languageId: "javascript", getText: () => "" } };
    S.quickPickAnswers.push((list) => ((offered = list.map((i) => i.label)), undefined));
    await run("clientActions", { client: acmeClient() });
    assert.ok(offered.includes("$(cloud-upload) Push this file to Dataverse"), "the open file belongs to this client");
    const beta = require("../out/core/clients.js").readClient(path.join(root, "beta"));
    S.quickPickAnswers.push((list) => ((offered = list.map((i) => i.label)), undefined));
    await run("clientActions", { client: beta });
    assert.ok(!offered.some((l) => /this file/.test(l)), "another client's file isn't offered");
    S.activeTextEditor = undefined;
  });

  await step("review: keep mine for a selection, take the rest, decline an apply with pending files, cancel", async () => {
    fs.writeFileSync(path.join(wr, "account.js"), "// mine again\n");
    fs.rmSync(path.join(wr, "contact.js"), { force: true });
    await run("pull", { client: acmeClient() });
    const changes = review.getChildren();
    assert.deepStrictEqual(changes.map((c) => `${c.kind}:${path.basename(c.display)}`).sort(), ["changed:account.js", "new:contact.js"]);
    const account = changes.find((c) => c.display.endsWith("account.js"));
    const contact = changes.find((c) => c.display.endsWith("contact.js"));
    assert.deepStrictEqual([account.choice, contact.choice], ["pending", "pending"]);
    S.messageAnswers.push(undefined);
    await run("review.apply");
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /2 file\(s\) are still undecided/);
    assert.ok(review.session, "declining the undecided-files warning keeps the review open");
    assert.ok(!fs.existsSync(path.join(wr, "contact.js")), "and applies nothing");
    await run("review.keepMine", account, [account, contact]);
    assert.deepStrictEqual([account.choice, contact.choice], ["keep", "keep"], "a multi-selection is set together");
    contact.choice = "pending";
    await run("review.takeAllPending");
    assert.strictEqual(review.session.pendingCount, 0);
    assert.deepStrictEqual([account.choice, contact.choice], ["keep", "dataverse"], "take-all only touches undecided files");
    const staging = review.session.stagingDir;
    await run("review.cancel");
    assert.strictEqual(review.session, undefined);
    assert.ok(!fs.existsSync(staging), "cancelling removes the staged copy");
    assert.strictEqual(S.context["lantern.reviewActive"], false);
    assert.strictEqual(fs.readFileSync(path.join(wr, "account.js"), "utf8"), "// mine again\n", "cancel applies nothing");
    assert.ok(!fs.existsSync(path.join(wr, "contact.js")), "nor adds anything");
    assert.match(lastMessage()[1], /Review discarded\. No Dataverse versions were applied\./);
  });

  await step("table commands: find from a client's row, browser links, copy menu, insert getControl, traces refresh", async () => {
    // Find Table searches the client whose row was clicked, even with another client's file open.
    const allTables = await sectionOf("acme-dynamics", "tables");
    S.activeTextEditor = { document: { uri: vscode.Uri.file(path.join(root, "beta", "x.js")), languageId: "javascript", getText: () => "" } };
    S.quickPickAnswers.push("Account");
    await run("metadata.findTable", allTables);
    assert.match(S.executed.filter((e) => e[0] === "markdown.showPreview").pop()[1].path, /^\/acme-dynamics\/account\.md$/);
    S.activeTextEditor = undefined;

    await run("metadata.openTableInBrowser", accountNode);
    assert.strictEqual(S.opened.pop(), "https://acme.crm.dynamics.com/main.aspx?pagetype=entitylist&etn=account");
    await run("metadata.newRecordInBrowser", accountNode);
    assert.strictEqual(S.opened.pop(), "https://acme.crm.dynamics.com/main.aspx?pagetype=entityrecord&etn=account");

    const [columnsNode, formsNode] = await kids(accountNode);
    const columns = await kids(columnsNode);
    const industry = columns.find((n) => n.column.logicalName === "industrycode");
    const [form] = await kids(formsNode);
    const tab = (await kids(form)).find((n) => n.kind === "tab");
    const option = (await kids(industry))[0];
    const copied = async (cmd, node) => {
      S.clipboard = "";
      await run(cmd, node);
      return S.clipboard;
    };
    assert.strictEqual(await copied("metadata.copy.logicalName", accountNode), "account");
    assert.strictEqual(await copied("metadata.copy.displayName", industry), "Industry");
    assert.strictEqual(await copied("metadata.copy.name", tab), tab.tab.name);
    assert.strictEqual(await copied("metadata.copy.value", option), String(option.value));
    assert.strictEqual(await copied("metadata.copy.id", form), form.form.id);
    assert.strictEqual(await copied("metadata.copy.value", accountNode), "", "nothing to copy: the clipboard is left alone");

    const inserted = [];
    S.activeTextEditor = { document: { uri: vscode.Uri.file(extensionless) }, insertSnippet: (snip) => inserted.push(snip.value) };
    await run("metadata.insertGetControl", industry);
    await run("metadata.insertSetValue", { ...option, label: "Cost $5 \\ more}" });
    assert.deepStrictEqual(inserted, ['formContext.getControl("industrycode")', `formContext.getAttribute("industrycode").setValue(${option.value}); // Cost \\$5 \\\\ more\\}`]);
    S.activeTextEditor = undefined;

    requests.length = 0;
    const traces = await sectionOf("acme-dynamics", "traces");
    await kids(traces);
    requests.length = 0;
    await run("traces.refresh");
    await kids(traces);
    assert.ok(requests.some((r) => r.url.includes("plugintracelogs")), "refresh reloads traces");
  });

  await step("step on, results right-click actions, reveal a solution, compile and push", async () => {
    const stepsNode = await sectionOf("acme-dynamics", "steps");
    await run("refreshNode", stepsNode);
    const [assembly] = await kids(stepsNode);
    const create = (await kids(assembly)).find((n) => !n.step.enabled);
    requests.length = 0;
    await run("steps.enable", create);
    assert.deepStrictEqual(requests.find((r) => r.method === "PATCH").body, { statecode: 0, statuscode: 1 });

    S.activeTextEditor = editorFor("SELECT TOP 2 name FROM account");
    await run("query.run");
    S.activeTextEditor = undefined;
    await run("results.inspectRecord", { set: 0, row: 0, col: 0 });
    assert.match(resultsHtml(), /"kind":"record"/, "the row's record opens in the inspector");
    assert.match(resultsHtml(), /\{"raw":"fax"\}/);
    await run("results.auditRecord", { set: 0, row: 0, col: 0 });
    assert.match(resultsHtml(), /"kind":"audit"/);
    S.activeTextEditor = editorFor("SELECT TOP 2 name FROM account");
    await run("query.run");
    S.activeTextEditor = undefined;
    S.quickPickAnswers.push("C#: FetchExpression");
    await run("results.copyAs", 0);
    assert.match(S.clipboard, /new FetchExpression\(fetchXml\)/);

    await run("solutions.reveal", { client: acmeClient(), unique: "AcmeCore", folder: path.join(acme, "AcmeCore") });
    const reveal = S.executed.filter((e) => e[0] === "revealInExplorer").pop();
    assert.strictEqual(reveal[1].fsPath, path.join(acme, "AcmeCore"));

    const tsDir = path.join(acme, "ts");
    fs.mkdirSync(tsDir, { recursive: true });
    fs.writeFileSync(path.join(tsDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "../AcmeCore/src/WebResources" } }));
    const src = path.join(tsDir, "acme_", "scripts", "account.ts");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "const y: number = 2;\n");
    requests.length = 0;
    await run("typescript.compileAndPush", vscode.Uri.file(src));
    assert.match(fs.readFileSync(path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js"), "utf8"), /^\/\/ compiled\nconst y = 2;/);
    assert.ok(requests.some((r) => r.method === "PATCH" && /webresourceset/.test(r.url)));
    fs.rmSync(tsDir, { recursive: true, force: true });
  });

  await step("app registration: secret in secret storage, client credentials token, its own pac profile, masked in logs", async () => {
    const cfgPath = path.join(acme, "client.json");
    const original = fs.readFileSync(cfgPath, "utf8");
    const appId = "11112222-3333-4444-5555-666677778888";
    S.quickPickAnswers.push("$(key) Use an app registration (service principal)…");
    S.inputAnswers.push(appId, "contoso.onmicrosoft.com", "s3cret-value");
    fs.writeFileSync(logFile, "");
    requests.length = 0;
    tokenRequests.length = 0;
    await run("signInAs", { client: acmeClient() });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.deepStrictEqual([cfg.appId, cfg.tenant, cfg.account], [appId, "contoso.onmicrosoft.com", ""]);
    assert.ok(!fs.readFileSync(cfgPath, "utf8").includes("s3cret-value"), "the secret never goes in client.json");
    assert.deepStrictEqual(tokenRequests[0].form, { client_id: appId, client_secret: "s3cret-value", scope: "https://acme.crm.dynamics.com/.default", grant_type: "client_credentials" });
    assert.match(tokenRequests[0].url, /login\.microsoftonline\.com\/contoso\.onmicrosoft\.com\/oauth2\/v2\.0\/token$/);
    assert.match(cliLog(), /pac auth create --name acmedynamicsapp1111 --environment https:\/\/acme\.crm\.dynamics\.com --applicationId 11112222-3333-4444-5555-666677778888 --clientSecret s3cret-value --tenant contoso\.onmicrosoft\.com/);
    assert.ok(!S.output.join("").includes("s3cret-value"), "the Lantern output panel never shows the secret");
    assert.match(S.output.join(""), /--clientSecret \*\*\*\*\*\*\*\* --tenant/);
    assert.match(lastMessage()[1], /acme-dynamics now signs in with app registration 11112222/);

    requests.length = 0;
    await run("refreshNode", await sectionOf("acme-dynamics", "envvars"));
    await kids(await sectionOf("acme-dynamics", "envvars"));
    assert.strictEqual(requests[0].headers.Authorization, "Bearer app-token", "Web API calls use the app's token");

    // A wrong secret explains itself.
    require("../out/ui/auth.js").clearTokenCache();
    S.quickPickAnswers.push("$(key) Use an app registration (service principal)…");
    S.inputAnswers.push(appId, "contoso.onmicrosoft.com", "wrong");
    await run("signInAs", { client: acmeClient() });
    assert.match(S.messages.filter((m) => m[0] === "error").pop()[1], /The app registration couldn't sign in: AADSTS7000215: Invalid client secret provided\./);
    S.messages = S.messages.filter((m) => m[0] !== "error");

    // Back to a user account: the app is dropped.
    S.quickPickAnswers.push("nathan@acme.com");
    await run("signInAs", { client: acmeClient() });
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, "utf8")).appId, "");
    fs.writeFileSync(cfgPath, original);
    require("../out/ui/auth.js").clearTokenCache();
  });

  await step("solutions: pack your files and import them", async () => {
    fs.writeFileSync(logFile, "");
    S.quickPickAnswers.push("Unmanaged");
    await run("solutions.packAndImport", { client: acmeClient(), unique: "AcmeCore", folder: path.join(acme, "AcmeCore") });
    const log = cliLog();
    assert.match(log, /pac solution pack --zipfile .*AcmeCore\.zip --folder .*AcmeCore[\\/]src --packagetype Unmanaged/);
    assert.match(log, /pac solution import --path .*AcmeCore\.zip --environment https:\/\/acme\.crm\.dynamics\.com --publish-changes/);
    assert.match(lastMessage()[1], /Packed AcmeCore from your files and imported it/);
  });

  await step("scaffolding: plug-in project, plug-in and workflow classes, script unit tests", async () => {
    fs.writeFileSync(logFile, "");
    S.inputAnswers.push("Acme.Tools");
    await run("plugins.newProject", { client: acmeClient() });
    const project = path.join(acme, "Plugins", "Acme.Tools");
    assert.match(cliLog(), new RegExp(`pac plugin init --outputDirectory .*Plugins.Acme\\.Tools`));
    assert.strictEqual(S.lastShow.target.fsPath, path.join(project, "Acme.Tools.csproj"));

    S.quickPickAnswers.push("Plug-in");
    S.inputAnswers.push("ContactPlugin");
    await run("plugins.newClass", { client: acmeClient(), plugin: { project: path.join(project, "Acme.Tools.csproj"), assembly: "Acme.Tools" } });
    const pluginCode = fs.readFileSync(path.join(project, "ContactPlugin.cs"), "utf8");
    assert.match(pluginCode, /namespace Acme\.Tools[\s\S]*public class ContactPlugin : PluginBase[\s\S]*ExecuteDataversePlugin\(ILocalPluginContext localPluginContext\)/, "uses the project's PluginBase");

    const acmePlugins = path.join(acme, "Plugins", "AcmePlugins");
    const csproj = fs.readdirSync(acmePlugins).find((f) => f.endsWith(".csproj"));
    S.quickPickAnswers.push("Custom workflow activity");
    S.inputAnswers.push("CopyText");
    await run("plugins.newClass", { client: acmeClient(), plugin: { project: path.join(acmePlugins, csproj), assembly: "AcmePlugins" } });
    assert.match(fs.readFileSync(path.join(acmePlugins, "CopyText.cs"), "utf8"), /public class CopyText : CodeActivity[\s\S]*IWorkflowContext/);
    fs.rmSync(path.join(acmePlugins, "CopyText.cs"));
    fs.rmSync(project, { recursive: true, force: true });

    S.quickPickAnswers.push("account.js");
    S.messageAnswers.push(undefined);
    await run("tests.setup", { client: acmeClient() });
    const tests = path.join(acme, "tests");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tests, "package.json"), "utf8")).devDependencies, { jest: "^29.7.0", "xrm-mock": "^3.5.0", "@types/jest": "^29.5.0" });
    const sample = fs.readFileSync(path.join(tests, "account.test.js"), "utf8");
    assert.match(sample, /XrmMockGenerator\.initialise\(\)/);
    assert.match(sample, /loadWebResource\(path\.join\(__dirname, "\.\.\/AcmeCore\/src\/WebResources\/acme_\/scripts\/account\.js"\)\)/);
    assert.strictEqual(fs.readFileSync(path.join(tests, ".gitignore"), "utf8"), "node_modules/\n");
    // The loader really runs a web resource and returns what it defined.
    const load = require(path.join(tests, "helpers", "load-web-resource.js"));
    const demo = path.join(tmp, "demo-wr.js");
    fs.writeFileSync(demo, "var Acme = { greet: function (n) { return 'hi ' + n; } };");
    assert.strictEqual(load(demo).Acme.greet("Nathan"), "hi Nathan");
    fs.rmSync(tests, { recursive: true, force: true });
  });

  await step("PCF: create, list in the tree, build, push with a remembered prefix, test harness", async () => {
    fs.writeFileSync(logFile, "");
    S.inputAnswers.push("Acme", "Stars");
    S.quickPickAnswers.push("Field", "React (virtual)");
    await run("pcf.new", { client: acmeClient() });
    const dir = path.join(acme, "PCF", "Stars");
    assert.match(cliLog(), /pac pcf init --namespace Acme --name Stars --template field --framework react --outputDirectory .*PCF.Stars --run-npm-install/);
    const clientNode = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    const pcfGroup = (await kids(clientNode)).find((n) => n.kind === "group" && n.group === "pcf");
    const [control] = await kids(pcfGroup);
    assert.deepStrictEqual([control.control.name, control.control.dir], ["Stars", dir]);
    await run("pcf.build", control);
    assert.match(cliLog(), new RegExp(`npm run build \\(in ${dir.replace(/[\\/]/g, "[\\\\/]")}\\)`));
    S.inputAnswers.push("acme");
    await run("pcf.push", control);
    assert.match(cliLog(), /pac pcf push --publisher-prefix acme\n  \(in .*PCF.Stars\)/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(acme, "client.json"), "utf8")).publisherPrefix, "acme", "remembered");
    fs.writeFileSync(logFile, "");
    await run("pcf.push", control);
    assert.match(cliLog(), /pcf push --publisher-prefix acme/, "not asked again");
    await run("pcf.harness", control);
    assert.deepStrictEqual(S.terminals[S.terminals.length - 1].sent, ["npm start watch"]);
    fs.rmSync(path.join(acme, "PCF"), { recursive: true, force: true });
  });

  await step("Power Pages: list, download, upload with the remembered data model", async () => {
    fs.writeFileSync(logFile, "");
    S.quickPickAnswers.push("Contoso Portal", "Enhanced data model");
    await run("pages.download", { client: acmeClient() });
    assert.match(cliLog(), /pac pages download --path .*pages --webSiteId aaaa1111-2222-3333-4444-555555555555 --modelVersion 2 --environment https:\/\/acme\.crm\.dynamics\.com --overwrite/);
    const site = path.join(acme, "pages", "contoso-portal---contoso-portal");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(acme, "pages", "lantern-sites.json"), "utf8")), { "contoso-portal---contoso-portal": { id: "aaaa1111-2222-3333-4444-555555555555", modelVersion: 2 } });
    const clientNode = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    const [siteNode] = await kids((await kids(clientNode)).find((n) => n.kind === "group" && n.group === "pages"));
    assert.strictEqual(siteNode.dir, site);
    fs.writeFileSync(logFile, "");
    await run("pages.upload", siteNode);
    assert.match(cliLog(), /pac pages upload --path .*contoso-portal---contoso-portal --modelVersion 2 --environment/, "no data model question: it's remembered");
    assert.deepStrictEqual(require("../out/core/pac.js").parsePagesList("[1] aaaa1111-2222-3333-4444-555555555555 Contoso Portal   2"), [{ id: "aaaa1111-2222-3333-4444-555555555555", name: "Contoso Portal" }]);
    fs.rmSync(path.join(acme, "pages"), { recursive: true, force: true });
  });

  await step("FetchXML in code: lenses, run with placeholder values, edit as query and write back", async () => {
    const file = path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/fetch-demo.js");
    fs.writeFileSync(file, [
      "function load(id, lastName) {",
      "  const byId = `<fetch top=\"1\"><entity name=\"account\"><attribute name=\"name\" /><filter><condition attribute=\"accountid\" operator=\"eq\" value=\"${id}\" /></filter></entity></fetch>`;",
      "  var byName = \"<fetch><entity name='contact'>\" +",
      "    \"<filter><condition attribute='lastname' operator='eq' value='\" + lastName + \"' /></filter>\" +",
      "    \"</entity></fetch>\";",
      "}",
    ].join("\n"));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const lenses = (await S.codeLensProviders[0].provideCodeLenses(doc)).filter((l) => /fetchxml/.test(l.command.command));
    assert.deepStrictEqual(lenses.map((l) => [l.command.title, l.range.args[0]]), [["$(play) Run FetchXML", 1], ["Edit as query", 1], ["$(play) Run FetchXML", 2], ["Edit as query", 2]]);

    requests.length = 0;
    S.inputAnswers.push("aaaaaaaa-1111-2222-3333-444444444444");
    await run("fetchxml.runInCode", vscode.Uri.file(file), 0);
    const ran = requests.find((r) => r.url.includes("accounts?fetchXml="));
    assert.match(decodeURIComponent(ran.url), /value="aaaaaaaa-1111-2222-3333-444444444444"/, "the placeholder got the value entered");

    await run("fetchxml.editInCode", vscode.Uri.file(file), 1);
    const editDoc = S.createdDocs[S.createdDocs.length - 1];
    assert.match(editDoc.getText(), /^<!-- Dataverse: acme-dynamics -->\n<!-- From fetch-demo\.js line 3\./);
    assert.match(editDoc.getText(), /value='\{\{lastName\}\}'/);
    const queryLenses = await S.codeLensProviders[0].provideCodeLenses(editDoc);
    assert.strictEqual(queryLenses[0].command.title, "$(reply) Write back to fetch-demo.js");

    // Running it asks for the placeholder; the document keeps it.
    requests.length = 0;
    S.inputAnswers.push("Smith");
    S.activeTextEditor = { document: editDoc, selection: { isEmpty: true } };
    await run("query.run");
    assert.match(decodeURIComponent(requests.find((r) => r.url.includes("contacts?fetchXml=")).url), /value=.Smith./);

    const edited = editDoc.getText().replace("<filter>", '<attribute name="fullname" /><filter>');
    S.activeTextEditor = { document: { ...editDoc, getText: () => edited }, selection: { isEmpty: true } };
    await run("fetchxml.writeBack");
    const code = fs.readFileSync(file, "utf8");
    assert.match(code, /var byName = `<fetch><entity name='contact'><attribute name="fullname" \/><filter><condition attribute='lastname' operator='eq' value='\$\{lastName\}' \/><\/filter><\/entity><\/fetch>`;/, "the concatenation became one template literal with the edit");
    assert.match(code, /const byId = `<fetch top/, "the other literal is untouched");
    // Written back again from the same document: it finds the new text.
    S.activeTextEditor = { document: { ...editDoc, getText: () => edited.replace("fullname", "emailaddress1") }, selection: { isEmpty: true } };
    await run("fetchxml.writeBack");
    assert.match(fs.readFileSync(file, "utf8"), /<attribute name="emailaddress1" \/>/);
    S.activeTextEditor = undefined;
    fs.rmSync(file);
  });

  await step("Custom APIs: define, deploy (create, then update and add), C# handler, TypeScript client", async () => {
    S.inputAnswers.push("acme_CalculateDiscount");
    S.quickPickAnswers.push("Global", "Action");
    await run("customApi.new", { client: acmeClient() });
    const file = path.join(acme, "customapis", "acme_CalculateDiscount.json");
    const def = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual([def.binding, def.isFunction, def.displayname], ["global", false, "Calculate Discount"]);
    def.plugin = "Acme.AccountPlugin";
    def.requestParameters = [{ uniquename: "Amount", type: "Money" }, { uniquename: "Code", type: "String", optional: true }];
    def.responseProperties = [{ uniquename: "Discount", type: "Decimal" }];
    fs.writeFileSync(file, JSON.stringify(def, null, 2));

    const lens = await S.codeLensProviders[0].provideCodeLenses(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    assert.deepStrictEqual(lens.map((l) => l.command.command), ["lantern.customApi.deploy", "lantern.customApi.generateCSharp", "lantern.customApi.generateTypeScript"]);

    requests.length = 0;
    S.quickPickAnswers.push("AcmeCore");
    await run("customApi.deploy", vscode.Uri.file(file));
    const create = requests.find((r) => r.method === "POST" && r.url.endsWith("/customapis"));
    assert.strictEqual(create.headers["MSCRM.SolutionUniqueName"], "AcmeCore");
    assert.strictEqual(create.body["PluginTypeId@odata.bind"], "/plugintypes(pt1)");
    assert.deepStrictEqual([create.body.uniquename, create.body.bindingtype, create.body.isfunction, create.body.allowedcustomprocessingsteptype], ["acme_CalculateDiscount", 0, false, 2]);
    assert.deepStrictEqual(create.body.CustomAPIRequestParameters.map((p) => [p.uniquename, p.type, p.isoptional]), [["Amount", 8, false], ["Code", 10, true]]);
    assert.deepStrictEqual(create.body.CustomAPIResponseProperties.map((p) => [p.uniquename, p.type]), [["Discount", 2]]);
    assert.match(lastMessage()[1], /Created acme_CalculateDiscount\./);

    customApis.acme_CalculateDiscount = { customapiid: "ca1", CustomAPIRequestParameters: [{ uniquename: "Amount", type: 8 }, { uniquename: "Code", type: 10 }], CustomAPIResponseProperties: [{ uniquename: "Discount", type: 7 }] };
    def.requestParameters.push({ uniquename: "Rate", type: "Decimal" });
    fs.writeFileSync(file, JSON.stringify(def, null, 2));
    requests.length = 0;
    S.quickPickAnswers.push("AcmeCore");
    await run("customApi.deploy", vscode.Uri.file(file));
    assert.ok(requests.some((r) => r.method === "PATCH" && r.url.endsWith("customapis(ca1)")));
    const param = requests.find((r) => r.method === "POST" && r.url.endsWith("customapirequestparameters"));
    assert.deepStrictEqual([param.body.uniquename, param.body.type, param.body["CustomAPIId@odata.bind"]], ["Rate", 2, "/customapis(ca1)"]);
    assert.match(S.messages.filter((m) => m[0] === "warn").pop()[1], /Updated acme_CalculateDiscount; added Rate\. Discount already exist with a different type/);

    def.plugin = "";
    fs.writeFileSync(file, JSON.stringify(def, null, 2));
    await run("customApi.generateCSharp", vscode.Uri.file(file));
    const handler = fs.readFileSync(path.join(acme, "Plugins", "AcmePlugins", "CalculateDiscount.cs"), "utf8");
    assert.match(handler, /public class CalculateDiscount : IPlugin/);
    assert.match(handler, /var amount = context\.InputParameters\.Contains\("Amount"\) \? \(Money\)context\.InputParameters\["Amount"\] : null;/);
    assert.match(handler, /var rate = context\.InputParameters\.Contains\("Rate"\) \? \(decimal\?\)context\.InputParameters\["Rate"\] : null;/);
    assert.match(handler, /context\.OutputParameters\["Discount"\] = default\(decimal\);/);
    assert.match(JSON.parse(fs.readFileSync(file, "utf8")).plugin, /\.CalculateDiscount$/, "the definition now names its handler");

    await run("customApi.generateTypeScript", vscode.Uri.file(file));
    const client = fs.readFileSync(file.replace(/\.json$/, ".ts"), "utf8");
    assert.match(client, /export interface CalculateDiscountRequest \{\n  Amount: number;\n  Code\?: string;\n  Rate: number;\n\}/);
    assert.match(client, /export async function calculateDiscount\(request: CalculateDiscountRequest\): Promise<CalculateDiscountResponse>/);
    assert.match(client, /operationType: 0,\n      operationName: "acme_CalculateDiscount",/);
    fs.rmSync(path.join(acme, "customapis"), { recursive: true, force: true });
    fs.rmSync(path.join(acme, "Plugins", "AcmePlugins", "CalculateDiscount.cs"));
  });

  await step("register a function as a form event handler: edits the form XML and publishes", async () => {
    fs.writeFileSync(extensionless, SCRIPT);
    webResources.cr36f_AccountFormOnLoad = { id: "33333333-3333-3333-3333-333333333333", content: Buffer.from(SCRIPT).toString("base64") };
    const offset = SCRIPT.indexOf("retrieveMultipleRecords");
    S.activeTextEditor = { document: { uri: vscode.Uri.file(extensionless), languageId: "javascript", getText: () => SCRIPT, offsetAt: () => offset }, selection: { active: {} } };
    let offeredName;
    S.inputAnswers.push((box) => ((offeredName = box.value), "helper"));
    S.quickPickAnswers.push((list) => list.filter((i) => i.form.type === "Main"));
    S.quickPickAnswers.push("OnChange of a column");
    S.quickPickAnswers.push((list) => list.find((i) => i.description === "fax"));
    S.quickPickAnswers.push("Pass the execution context");
    requests.length = 0;
    await run("forms.registerHandler");
    assert.strictEqual(offeredName, "helper", "the function at the cursor is suggested");
    const patch = requests.find((r) => r.method === "PATCH" && r.url.endsWith("systemforms(f1)"));
    assert.match(patch.body.formxml, /<event name="onchange" application="false" active="false" attribute="fax"><Handlers><Handler functionName="helper" libraryName="cr36f_AccountFormOnLoad" handlerUniqueId="\{[0-9a-f-]{36}\}" enabled="true" parameters="" passExecutionContext="true" \/><\/Handlers><\/event>/);
    assert.ok(patch.body.formxml.includes('functionName="formOnLoad"'), "existing handlers are kept");
    const publish = requests.find((r) => r.url.endsWith("PublishXml"));
    assert.strictEqual(publish.body.ParameterXml, "<importexportxml><entities><entity>account</entity></entities></importexportxml>");
    assert.match(lastMessage()[1], /Registered helper on OnChange of fax of Account and published\./);
    S.activeTextEditor = undefined;
    delete webResources.cr36f_AccountFormOnLoad;
  });

  await step("Copilot tools: clients, describe a table, read-only query with confirmation, where used", async () => {
    const tools = S.tools;
    assert.deepStrictEqual(Object.keys(tools).sort(), ["lantern_clients", "lantern_describe_table", "lantern_query", "lantern_where_used"]);
    const textOf = async (name, input) => (await tools[name].invoke({ input })).content.map((p) => p.value).join("");
    assert.match(await textOf("lantern_clients", {}), /- acme-dynamics: https:\/\/acme\.crm\.dynamics\.com\. Solutions: AcmeCore\./);
    const table = await textOf("lantern_describe_table", { client: "acme-dynamics", table: "Account" });
    assert.match(table, /^Account \(account\), entity set accounts/);
    assert.match(table, /- industrycode \(Industry\): Picklist, choices 1=Accounting/);
    assert.match(table, /- Account \(Main\): onload formOnLoad; onchange\(address1_line2\) AddressStreet3Hide/);
    const confirm = tools.lantern_query.prepareInvocation({ input: { client: "acme-dynamics", query: "SELECT TOP 2 name FROM account" } });
    assert.deepStrictEqual(confirm.confirmationMessages, { title: "Run a read-only query on acme-dynamics?", message: "SELECT TOP 2 name FROM account" });
    assert.match(await textOf("lantern_query", { client: "acme-dynamics", query: "SELECT TOP 2 name FROM account" }), /^2 row\(s\) from acme-dynamics:\n\n\| name \|\n\|---\|\n\| Contoso \|/);
    assert.match(await textOf("lantern_query", { client: "acme-dynamics", query: "DELETE FROM account" }), /^Error: Only SELECT queries and FetchXML can run from chat/);
    assert.match(await textOf("lantern_query", { query: "SELECT TOP 1 name FROM account" }), /from acme-dynamics/, "with one connected client, it's used without asking");
    assert.match(await textOf("lantern_describe_table", { client: "nope", table: "account" }), /^Error: No client named nope\. Clients: acme-dynamics\.$/);
    assert.match(await textOf("lantern_where_used", { client: "acme-dynamics", table: "account", column: "fax" }), /Where .*fax/i);
  });

  await step("client settings outside the folder: moved there, used everywhere, untracked files only", async () => {
    const clientsMod = require("../out/core/clients.js");
    const store = path.join(tmp, "store", "clients");
    const ignored = path.join(tmp, "store", "ignored.json");
    clientsMod.useClientStore(store, ignored);
    const before = fs.readFileSync(path.join(acme, "client.json"), "utf8");
    assert.strictEqual(clientsMod.moveConfigToStore(acme), true);
    assert.ok(!fs.existsSync(path.join(acme, "client.json")), "nothing of Lantern's settings left in the folder");
    const stored = clientsMod.storedConfigPath(acme);
    assert.match(path.basename(stored), /^acme-dynamics-[0-9a-f]{10}\.lantern-client\.json$/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(stored, "utf8")).solutions, JSON.parse(before).solutions);

    // Everything reads and writes the stored copy.
    const client = acmeClient();
    assert.strictEqual(client.configFile, stored);
    assert.strictEqual(client.config.org, "https://acme.crm.dynamics.com");
    client.config.solutions.push("Extra");
    client.save();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(stored, "utf8")).solutions.slice(-1), ["Extra"]);
    assert.ok(!fs.existsSync(path.join(acme, "client.json")));
    const tree = (await metaTree.getChildren()).find((n) => n.kind === "client" && n.client.name === "acme-dynamics");
    assert.ok(tree, "still a client in the tree");
    await run("openClientConfig", { client: acmeClient() });
    assert.strictEqual(S.lastShow.target.fsPath, stored, "Edit client settings opens the stored copy");
    S.activeTextEditor = { document: { uri: vscode.Uri.file(path.join(acme, "AcmeCore/src/WebResources/acme_/scripts/account.js")), languageId: "javascript", getText: () => "" } };
    await run("refresh");
    assert.match(S.statusBarItems[0].text, /acme-dynamics/, "files in the folder still find their client");
    S.activeTextEditor = undefined;

    // A client.json the repo tracks stays where the team put it.
    const tracked = path.join(tmp, "tracked-client");
    fs.mkdirSync(tracked);
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tracked });
    fs.writeFileSync(path.join(tracked, "client.json"), JSON.stringify({ org: "t.crm.dynamics.com" }));
    execSync("git add client.json && git commit -qm c", { cwd: tracked });
    assert.strictEqual(clientsMod.moveConfigToStore(tracked), false);
    assert.ok(fs.existsSync(path.join(tracked, "client.json")));
    assert.strictEqual(clientsMod.readClient(tracked).configFile, path.join(tracked, "client.json"));

    // New clients go straight to the store; without a jsconfig when that's turned off.
    const fresh = path.join(tmp, "fresh-client");
    fs.mkdirSync(fresh);
    clientsMod.ensureClientConfig(fresh, { org: "f.crm.dynamics.com" }, { jsconfig: false });
    assert.deepStrictEqual(fs.readdirSync(fresh), [], "nothing written into the folder");
    assert.ok(fs.existsSync(clientsMod.storedConfigPath(fresh)));

    // Back to the folder layout for the remaining steps.
    fs.writeFileSync(path.join(acme, "client.json"), before);
    fs.rmSync(stored);
    clientsMod.useClientStore(undefined, ignored);
  });

  await step("git: Lantern's files are excluded in the repo that holds the folder, wherever its root is", async () => {
    const clientsMod = require("../out/core/clients.js");
    const repo = path.join(tmp, "outer-repo");
    const sub = path.join(repo, "salon-api");
    fs.mkdirSync(sub, { recursive: true });
    execSync("git init -q", { cwd: repo });
    fs.writeFileSync(path.join(sub, "Program.cs"), "// app");
    clientsMod.ensureClientConfig(sub, { org: "s.crm.dynamics.com" });
    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\/salon-api\/jsconfig\.json$/m);
    assert.match(exclude, /^\/salon-api\/client\.json$/m);
    const status = execSync("git status --porcelain --untracked-files=all", { cwd: repo }).toString();
    assert.strictEqual(status.trim(), "?? salon-api/Program.cs", "only the project's own file is untracked; Lantern's never show up");

    // A worktree's .git is a file; its exclude list lives in the main repo.
    execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git worktree add -q ../wt", { cwd: repo });
    const wt = path.join(tmp, "wt");
    assert.strictEqual(clientsMod.gitRepoFor(path.join(wt)).excludeFile, path.join(repo, ".git", "info", "exclude"));

    // Auto-configure: a repo of its own, or anything when the workspace isn't a repo; never a project inside an opened repo.
    assert.strictEqual(clientsMod.shouldAutoConfigure(sub, repo), false, "a project folder inside an opened repo");
    assert.strictEqual(clientsMod.shouldAutoConfigure(acme, root), true, "a cloned client repo");
    const plain = path.join(tmp, "plain-root", "newclient");
    fs.mkdirSync(plain, { recursive: true });
    assert.strictEqual(clientsMod.shouldAutoConfigure(plain, path.dirname(plain)), true, "a workspace that isn't a repo");
  });

  await step("remove Lantern from a folder: settings and its jsconfig go, the folder isn't configured again", async () => {
    const clientsMod = require("../out/core/clients.js");
    const ignored = path.join(tmp, "store", "ignored.json");
    clientsMod.useClientStore(undefined, ignored);
    const folder = path.join(root, "delta");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "notes.txt"), "keep me");
    clientsMod.ensureClientConfig(folder, {});
    assert.ok(fs.existsSync(path.join(folder, "jsconfig.json")) && fs.existsSync(path.join(folder, "client.json")));
    S.messageAnswers.push("Remove");
    await run("removeClient", { client: clientsMod.readClient(folder) });
    assert.deepStrictEqual(fs.readdirSync(folder), ["notes.txt"], "only Lantern's files were removed");
    assert.strictEqual(clientsMod.isIgnoredFolder(folder), true);
    assert.strictEqual(clientsMod.shouldAutoConfigure(folder, root), false, "not configured again automatically");
    // A jsconfig someone wrote by hand is kept.
    fs.writeFileSync(path.join(folder, "jsconfig.json"), JSON.stringify({ compilerOptions: { checkJs: true } }));
    clientsMod.ensureClientConfig(folder, {});
    assert.strictEqual(clientsMod.isIgnoredFolder(folder), false, "configuring it again clears that");
    clientsMod.removeClientConfig(folder);
    assert.ok(fs.existsSync(path.join(folder, "jsconfig.json")), "a hand-written jsconfig stays");
    fs.rmSync(folder, { recursive: true, force: true });
  });

  await step("status bar and context keys follow the active editor", async () => {
    S.activeTextEditor = { document: { uri: vscode.Uri.file(path.join(wr, "account.js")), languageId: "javascript", getText: () => "" } };
    await run("refresh");
    const item = S.statusBarItems[0];
    assert.match(item.text, /acme-dynamics \(acme\)/);
    assert.strictEqual(S.context["lantern.activeIsWebResource"], true);
    S.activeTextEditor = undefined;
  });

  await step("new subfolders are configured automatically", async () => {
    const dir = path.join(root, "gamma");
    fs.mkdirSync(dir);
    for (const w of S.watchers) for (const l of w.create) l(vscode.Uri.file(dir));
    assert.ok(fs.existsSync(path.join(dir, "client.json")));
    assert.ok(fs.existsSync(path.join(dir, "jsconfig.json")));
  });

  await step("test connection uses WhoAmI", async () => {
    await run("testConnection", { client: require("../out/core/clients.js").readClient(acme) });
    assert.match(lastMessage()[1], /Connected to acme\.crm\.dynamics\.com/);
  });

  await step("pull without an org explains what to set", async () => {
    await run("pull", { client: require("../out/core/clients.js").readClient(path.join(root, "beta")) });
    assert.match(lastMessage()[1], /Set "org"/);
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold locks on git files; leftover temp files are harmless.
  }
  console.log("\nAll tests passed.");
})().catch((err) => {
  console.error(err);
  console.error("\nOutput channel:\n" + (S.messages.map((m) => m.join(": ")).join("\n")));
  process.exit(1);
});
