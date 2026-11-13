import * as vscode from "vscode";
import { Client } from "../core/clients";
import { MetadataService } from "../core/metadata";
import { CSharpClassRequests, lanternTools } from "./lanternTools";

/**
 * Tools Copilot Chat (agent mode) can call: they read from the client's Dataverse org
 * through Lantern's sign-in. Nothing here changes data: queries are SELECT or FetchXML
 * only, and each query asks before it runs. The same tools are served to other
 * assistants over MCP (see mcpServer.ts); each is declared in package.json for Copilot.
 */
type LmApi = {
  registerTool?: (name: string, tool: unknown) => vscode.Disposable;
};

interface ToolOptions<T> {
  input: T;
}

export function registerCopilotTools(serviceFor: (c: Client) => MetadataService, csharp?: CSharpClassRequests): vscode.Disposable[] {
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  const ResultClass = (vscode as unknown as { LanguageModelToolResult?: new (parts: unknown[]) => unknown }).LanguageModelToolResult;
  const TextPart = (vscode as unknown as { LanguageModelTextPart?: new (text: string) => unknown }).LanguageModelTextPart;
  if (!lm?.registerTool || !ResultClass || !TextPart) return [];
  const text = (t: string) => new ResultClass([new TextPart(t)]);

  return lanternTools(serviceFor, csharp).map((t) =>
    lm.registerTool!(t.name, {
      async invoke(options: ToolOptions<Record<string, unknown>>) {
        try {
          return text(await t.invoke(options.input ?? {}));
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      ...(t.confirm ? { prepareInvocation: (options: ToolOptions<Record<string, unknown>>) => ({ confirmationMessages: t.confirm!(options.input ?? {}) }) } : {}),
    })
  );
}
