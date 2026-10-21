export type SearchComponent = "powerAutomateFlow" | "table" | "businessRule" | "app";
export type AppAction = "edit" | "run";

export type DataverseSearchCommand =
  | { component: "solution"; query: string }
  | { component: Exclude<SearchComponent, "app">; query: string; scope: "global" }
  | { component: Exclude<SearchComponent, "app">; query: string; scope: "solution"; solutionUniqueName: string }
  | { component: "app"; query: string; action: AppAction; scope: "global" }
  | { component: "app"; query: string; action: AppAction; scope: "solution"; solutionUniqueName: string };

export type SearchCommandParseResult =
  | { command: DataverseSearchCommand }
  | { error: string };

const components: Record<string, SearchComponent> = {
  pa: "powerAutomateFlow",
  t: "table",
  br: "businessRule",
  a: "app",
};
const names: Record<SearchComponent, string> = {
  powerAutomateFlow: "flow",
  table: "table",
  businessRule: "business rule",
  app: "app",
};

/** Parse a component search, optionally restricted to one solution. */
export function parseSearchCommand(input: string): SearchCommandParseResult {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { error: "Enter a search command." };
  if (parts[0].toLowerCase() === "s") {
    if (parts.length < 2) return { error: "Add a solution name after s." };
    const component = components[parts[2]?.toLowerCase()];
    if (!component) return { command: { component: "solution", query: parts.slice(1).join(" ") } };
    return parseComponent(component, parts.slice(3), parts[2], parts[1]);
  }
  const offset = parts[0].toLowerCase() === "g" ? 1 : 0;
  const component = components[parts[offset]?.toLowerCase()];
  if (!component) return { error: "Use s <solution>, or [g | s <solution>] <pa | t | br | a> <name>." };
  return parseComponent(component, parts.slice(offset + 1), parts[offset]);
}

function parseComponent(component: SearchComponent, words: string[], token: string, solutionUniqueName?: string): SearchCommandParseResult {
  if (component === "app") {
    const actionToken = words.at(-1)?.toLowerCase();
    if (actionToken !== "e" && actionToken !== "r") return { error: "End app searches with e (edit) or r (run)." };
    const query = words.slice(0, -1).join(" ");
    if (!query) return { error: "Add an app name before e or r." };
    const action: AppAction = actionToken === "e" ? "edit" : "run";
    return solutionUniqueName
      ? { command: { component, query, action, scope: "solution", solutionUniqueName } }
      : { command: { component, query, action, scope: "global" } };
  }
  const query = words.join(" ");
  if (!query) return { error: `Add a ${names[component]} name after ${token}.` };
  return solutionUniqueName
    ? { command: { component, query, scope: "solution", solutionUniqueName } }
    : { command: { component, query, scope: "global" } };
}
