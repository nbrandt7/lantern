import * as vscode from "vscode";
import { ensureAuth } from "../core/pac";
import { Change, pull } from "../core/pull";
import { resolveClient, withProgress } from "../ui/context";
import { openChange, ReviewTree } from "../ui/review";

export async function pullCommand(review: ReviewTree, arg: unknown, onDone: () => void): Promise<void> {
  const client = await resolveClient(arg);
  if (!client) return;
  if (review.session) {
    const replace = await vscode.window.showWarningMessage(
      `A review for ${review.session.client.name} is still open. Discard it and pull ${client.name}?`,
      { modal: true },
      "Discard and Pull"
    );
    if (!replace) return;
    review.end();
  }
  if (!client.config.org) {
    void vscode.window.showWarningMessage(`Set "org" in ${client.name}/.lantern/config.json first.`);
    return;
  }

  const result = await withProgress(`Pulling ${client.name} from Dataverse`, async (ctx, progress) => {
    progress.report({ message: "signing in..." });
    await ensureAuth(ctx, client);
    progress.report({ message: "fetching solutions..." });
    return pull(ctx, client);
  });
  onDone();
  if (!result) return;

  if (!result.session && !result.cloned.length) {
    void vscode.window.showWarningMessage(`No solutions found in ${client.name}. Add solution unique names to "solutions" in .lantern/config.json.`);
    return;
  }
  const cloned = result.cloned.length ? `Cloned ${result.cloned.join(", ")}. ` : "";
  if (!result.session) {
    void vscode.window.showInformationMessage(`${cloned}${client.name} is up to date with Dataverse.`);
    return;
  }
  if (!result.session.changes.length) {
    result.session.dispose();
    void vscode.window.showInformationMessage(`${cloned}Your files already match Dataverse.`);
    return;
  }
  await review.start(result.session);
  void vscode.window.showInformationMessage(
    `${cloned}Dataverse differs in ${result.session.changes.length} file(s). Choose what to take in the Pull Review panel, then Apply.`
  );
}

export function registerReviewCommands(review: ReviewTree, onApplied: () => void): vscode.Disposable[] {
  const r = vscode.commands.registerCommand;
  return [
    r("lantern.review.open", (c: Change) => openChange(review, c)),
    r("lantern.review.takeDataverse", (c?: Change, all?: Change[]) => review.setChoice(review.targets(c, all), "dataverse")),
    r("lantern.review.keepMine", (c?: Change, all?: Change[]) => review.setChoice(review.targets(c, all), "keep")),
    r("lantern.review.takeAllPending", () =>
      review.setChoice((review.session?.changes ?? []).filter((c) => c.choice === "pending"), "dataverse")
    ),
    r("lantern.review.keepAllPending", () =>
      review.setChoice((review.session?.changes ?? []).filter((c) => c.choice === "pending"), "keep")
    ),
    r("lantern.review.apply", async () => {
      const session = review.session;
      if (!session) return;
      if (session.pendingCount) {
        const answer = await vscode.window.showWarningMessage(
          `${session.pendingCount} file(s) are still undecided. They'll keep your version.`,
          { modal: true },
          "Apply"
        );
        if (!answer) return;
      }
      const { taken, kept, backups } = session.apply();
      const name = session.client.name;
      const isRepo = session.client.isRepo;
      review.end();
      onApplied();
      const backupNote = backups ? ` Previous versions of ${backups} file(s) are in ${name}/.pull-backup/.` : "";
      const choice = await vscode.window.showInformationMessage(
        `Took Dataverse for ${taken}, kept yours for ${kept}.${backupNote}`,
        ...(isRepo ? ["Open Source Control"] : [])
      );
      if (choice) await vscode.commands.executeCommand("workbench.view.scm");
    }),
    r("lantern.review.cancel", () => {
      review.end();
      void vscode.window.showInformationMessage("Review discarded. No Dataverse versions were applied.");
    }),
  ];
}
