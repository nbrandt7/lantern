interface SearchTarget {
  component: "powerAutomateFlow";
  query: string;
}

export type DataverseSearchCommand = SearchTarget & (
  | { scope: "global" }
  | { scope: "solution"; solutionUniqueName: string }
);

export type SearchCommandParseResult =
  | { command: DataverseSearchCommand }
  | { error: string };

/** Parse `pa invoice`, `g pa invoice`, or `s MySolution pa invoice`. */
export function parseSearchCommand(input: string): SearchCommandParseResult {
  const text = input.trim();
  const solution = text.match(/^s\s+(\S+)\s+pa(?:\s+(.+))?$/i);
  if (solution) {
    const query = solution[2]?.trim();
    if (!query) return { error: "Add a flow name after pa." };
    return { command: { scope: "solution", solutionUniqueName: solution[1], component: "powerAutomateFlow", query } };
  }
  const global = text.match(/^(?:g\s+)?pa(?:\s+(.+))?$/i);
  if (global) {
    const query = global[1]?.trim();
    if (!query) return { error: "Add a flow name after pa." };
    return { command: { scope: "global", component: "powerAutomateFlow", query } };
  }
  return { error: "Use pa <flow name> or s <solution unique name> pa <flow name>." };
}
