// Fake TypeScript compiler: "tsc -p <tsconfig>" copies each .ts under the config's folder to outDir as .js.
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DVW_LOG, `tsc ${args.join(" ")}\n`);
const config = args[args.indexOf("-p") + 1];
const dir = path.dirname(config);
const o = JSON.parse(fs.readFileSync(config, "utf8")).compilerOptions || {};
const root = path.resolve(dir, o.rootDir || ".");
const outDir = path.resolve(dir, o.outDir || ".");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const file of walk(dir).filter((f) => f.endsWith(".ts"))) {
  const out = path.join(outDir, path.relative(root, file)).replace(/\.ts$/, ".js");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "// compiled\n" + fs.readFileSync(file, "utf8").replace(/: \w+/g, ""));
}
