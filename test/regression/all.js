// Runs every regression file in this folder, each in its own process (they share the vscode mock's state).
// Run with: npm run compile && node test/regression/all.js
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".js") && f !== "all.js").sort();
let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    failed++;
    console.log(`  ✗ ${file} exited with ${r.status ?? r.signal}`);
  }
}
console.log(`${files.length - failed} of ${files.length} regression files passed.`);
if (failed) process.exitCode = 1;
