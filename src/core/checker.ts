import * as fs from "fs";
import * as path from "path";
import { readZip } from "./zip";

export interface CheckerIssue {
  rule: string;
  description: string;
  level: "error" | "warning" | "note";
  message: string;
  /** Path inside the solution, e.g. "WebResources/acme_/scripts/account.js". */
  artifact?: string;
  line?: number;
  helpUri?: string;
}

interface Sarif {
  runs?: Array<{
    tool?: { driver?: { rules?: Array<{ id: string; shortDescription?: { text?: string }; helpUri?: string }> } };
    results?: Array<{
      ruleId?: string;
      level?: string;
      message?: { text?: string };
      locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }>;
    }>;
  }>;
}

/** Issues from the solution checker's output folder (a .sarif file, possibly inside a zip). */
export function readCheckerOutput(outDir: string): CheckerIssue[] | undefined {
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).map((f) => path.join(outDir, f)) : [];
  const sarifs: string[] = [];
  for (const f of files) {
    if (f.toLowerCase().endsWith(".sarif")) sarifs.push(fs.readFileSync(f, "utf8"));
    else if (f.toLowerCase().endsWith(".zip")) {
      for (const e of readZip(fs.readFileSync(f))) if (e.name.toLowerCase().endsWith(".sarif")) sarifs.push(e.data.toString("utf8"));
    }
  }
  if (!sarifs.length) return undefined;
  const issues: CheckerIssue[] = [];
  for (const text of sarifs) {
    const sarif = JSON.parse(text.replace(/^\uFEFF/, "")) as Sarif;
    for (const run of sarif.runs ?? []) {
      const rules = new Map((run.tool?.driver?.rules ?? []).map((r) => [r.id, r]));
      for (const r of run.results ?? []) {
        const loc = r.locations?.[0]?.physicalLocation;
        const rule = rules.get(r.ruleId ?? "");
        issues.push({
          rule: r.ruleId ?? "",
          description: rule?.shortDescription?.text ?? r.ruleId ?? "",
          level: r.level === "error" ? "error" : r.level === "note" ? "note" : "warning",
          message: r.message?.text ?? "",
          artifact: loc?.artifactLocation?.uri?.replace(/^\/+/, ""),
          line: loc?.region?.startLine,
          helpUri: rule?.helpUri,
        });
      }
    }
  }
  return issues;
}
