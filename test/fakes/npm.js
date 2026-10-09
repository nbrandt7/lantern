// Fake npm: logs the call and the folder it ran in.
const fs = require("fs");
fs.appendFileSync(process.env.DVW_LOG, `npm ${process.argv.slice(2).join(" ")} (in ${process.cwd()})\n`);
