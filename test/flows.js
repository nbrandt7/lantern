const assert = require("assert/strict");
const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? require.resolve("./mock-vscode") : resolve.call(this, request, ...rest);
};
const vscode = require("./mock-vscode");
const { fetchSolutionFlows } = require("../out/core/flows");
const { WorkspaceTree } = require("../out/ui/workspaceTree");
const auth = require("../out/ui/auth");

(async () => {
  const calls = [];
  let ids = Array.from({ length: 41 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  const dv = {
    async getAll(query) {
      calls.push(decodeURIComponent(query));
      if (query.startsWith("solutions?")) return [{ solutionid: "solution-1" }];
      if (query.startsWith("solutioncomponents?")) return [...ids, ...ids.slice(0, 1)].map(objectid => ({ objectid }));
      return [{ workflowid: ids[0], name: calls.length === 3 ? "Zebra" : "Alpha", description: null, statecode: 1 }];
    },
    async getJson() { return { Detail: { EnvironmentId: "env-1" } }; },
  };
  const flows = await fetchSolutionFlows(dv, "O'Brien");
  assert.match(calls[0], /O''Brien/);
  assert.match(calls[1], /componenttype eq 29/);
  assert.equal(calls.length, 4);
  assert.match(calls[2], /category eq 5 and type eq 1/);
  assert.equal((calls[2].match(/workflowid eq/g) || []).length, 40);
  assert.equal((calls[3].match(/workflowid eq/g) || []).length, 1);
  assert.deepEqual(flows.map(f => f.name), ["Alpha", "Zebra"]);
  ids = [];
  calls.length = 0;
  assert.deepEqual(await fetchSolutionFlows(dv, "Empty"), []);
  assert.equal(calls.length, 2);
  await assert.rejects(fetchSolutionFlows({ getAll: async () => [] }, "Missing"), /no solution named/);
  const flow = flows[0];
  auth.dataverseFor = () => dv;
  const client = { name: "Acme", orgHost: "acme.crm.dynamics.com", config: { org: "https://acme.crm.dynamics.com" } };
  const tree = new WorkspaceTree(() => ({ forget() {} }), { onDidChangeTreeData() {} }, {});
  const solution = { kind: "solution", client, unique: "Core" };
  const part = (await tree.getChildren(solution)).find(n => n.part === "flows");
  assert.equal(tree.getTreeItem(part).label, "Power Automate flows");
  ids = [flow.id];
  const nodes = await tree.getChildren(part);
  const before = calls.length;
  await tree.getChildren(part);
  assert.equal(calls.length, before);
  const item = tree.getTreeItem(nodes[0]);
  assert.equal(item.description, "On");
  assert.equal(item.command.command, "lantern.openPowerAutomateFlow", "clicking a flow opens its designer");
  assert.strictEqual(item.command.arguments[0], nodes[0]);
  for (const target of [part, solution, undefined]) {
    tree.refresh(target);
    const count = calls.length;
    await tree.getChildren(part);
    assert.ok(calls.length > count);
  }
  const other = { ...part, client: { ...client, orgHost: "other.crm.dynamics.com" } };
  const count = calls.length;
  await tree.getChildren(other);
  assert.ok(calls.length > count, "environment cache isolation");
  tree.refresh(part);
  auth.dataverseFor = () => ({ getAll: async () => { throw new Error("Offline"); } });
  const [failure] = await tree.getChildren(part);
  assert.match(failure.text, /Offline/);
  assert.equal(failure.command.command, "lantern.refreshNode");
  auth.dataverseFor = () => dv;
  assert.equal((await tree.getChildren(part))[0].kind, "flow", "failed requests are not cached");
  ids = [];
  tree.refresh(part);
  assert.match((await tree.getChildren(part))[0].text, /No Power Automate flows/);
  console.log("Flow tests passed: solution filtering, batching, empty/missing solutions, environment routing, and tree caching/refresh.");
})().catch(err => { console.error(err); process.exitCode = 1; });
