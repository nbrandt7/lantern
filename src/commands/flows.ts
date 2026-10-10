import * as vscode from "vscode";
import { Client } from "../core/clients";
import { UserError } from "../core/errors";
import { flowEditorUrl, SolutionFlow } from "../core/flows";
import { dataverseFor } from "../ui/auth";

/** Use a top-level browser so the portal's sign-in and framing policies work. */
export async function openFlow(node?: { client: Client; flow: SolutionFlow }): Promise<void> {
  if (!node?.client || !node.flow) throw new UserError("Select a flow under Solutions > Power Automate flows.");
  const command = "workbench.action.browser.open";
  if (!(await vscode.commands.getCommands(true)).includes(command)) {
    throw new UserError("Opening Power Automate inside VS Code requires a desktop version with the Integrated Browser. Update VS Code, then select the flow again.");
  }
  const url = await flowEditorUrl(dataverseFor(node.client), node.flow.id);
  await vscode.commands.executeCommand(command, url);
}
