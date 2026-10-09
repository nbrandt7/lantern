import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Change, PullSession } from "../core/pull";
import { reportError } from "./context";

const KIND_LABEL: Record<Change["kind"], string> = {
  changed: "changed in Dataverse",
  new: "only in Dataverse",
  removed: "not in Dataverse",
};

/**
 * Holds the active pull session and shows its differences. Each file gets a
 * choice (take Dataverse / keep mine), and nothing touches disk until Apply.
 */
export class ReviewTree implements vscode.TreeDataProvider<Change> {
  private readonly changed = new vscode.EventEmitter<Change | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  session?: PullSession;
  private view?: vscode.TreeView<Change>;

  attach(view: vscode.TreeView<Change>): void {
    this.view = view;
  }

  async start(session: PullSession): Promise<void> {
    this.end();
    this.session = session;
    await vscode.commands.executeCommand("setContext", "lantern.reviewActive", true);
    this.update();
    await vscode.commands.executeCommand("lantern.review.focus");
  }

  end(): void {
    this.session?.dispose();
    this.session = undefined;
    void vscode.commands.executeCommand("setContext", "lantern.reviewActive", false);
    this.update();
  }

  update(): void {
    if (this.view) {
      const s = this.session;
      this.view.message = s
        ? `${s.client.name}: ${s.changes.length} difference(s), ${s.pendingCount} still to decide.` +
          (s.ignoredCount ? ` ${s.ignoredCount} git-ignored file(s) left alone.` : "")
        : undefined;
      this.view.badge = s && s.pendingCount ? { value: s.pendingCount, tooltip: `${s.pendingCount} to review` } : undefined;
    }
    this.changed.fire(undefined);
  }

  getChildren(node?: Change): Change[] {
    return node || !this.session ? [] : this.session.changes;
  }

  getTreeItem(c: Change): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(c.display), vscode.TreeItemCollapsibleState.None);
    const choice = c.choice === "dataverse" ? "→ take Dataverse" : c.choice === "keep" ? "→ keep mine" : "";
    item.description = [path.dirname(c.display) === "." ? "" : path.dirname(c.display), choice].filter(Boolean).join("  ");
    item.iconPath =
      c.choice === "dataverse"
        ? new vscode.ThemeIcon("cloud-download", new vscode.ThemeColor("charts.blue"))
        : c.choice === "keep"
          ? new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon(
              c.kind === "new" ? "diff-added" : c.kind === "removed" ? "diff-removed" : "diff-modified",
              new vscode.ThemeColor(c.edited ? "charts.orange" : "foreground")
            );
    const notes = [KIND_LABEL[c.kind], c.binary && "binary, no diff", c.edited && "you have uncommitted edits"].filter(Boolean);
    item.tooltip = `${c.display}\n${notes.join(" · ")}`;
    item.contextValue = c.binary ? "change.binary" : "change";
    item.command = { command: "lantern.review.open", title: "Open", arguments: [c] };
    return item;
  }

  setChoice(changes: Change[], choice: Change["choice"]): void {
    for (const c of changes) c.choice = choice;
    this.update();
  }

  /** Changes the command applies to: the clicked one, plus any others selected with it. */
  targets(clicked?: Change, selected?: Change[]): Change[] {
    if (selected && selected.length) return selected;
    if (clicked) return [clicked];
    return [...(this.view?.selection ?? [])];
  }
}

/**
 * Opens a change for inspection:
 *  - uncommitted edits + committed base -> 3-way merge editor (yours, Dataverse, base), result written to your file
 *  - other changed text files           -> diff editor, Dataverse left, your file right (editable)
 *  - new / removed                      -> the one file that exists
 */
export async function openChange(tree: ReviewTree, c: Change): Promise<void> {
  const session = tree.session;
  if (!session) return;
  if (c.binary) {
    void vscode.window.showInformationMessage(`${path.basename(c.display)} is binary, so there's nothing to diff. Choose take or keep.`);
    return;
  }
  const local = vscode.Uri.file(c.localPath);
  const staged = vscode.Uri.file(c.stagedPath);
  const name = path.basename(c.display);

  if (c.kind === "new") {
    await vscode.commands.executeCommand("vscode.open", staged, { preview: true });
    return;
  }
  if (c.kind === "removed") {
    await vscode.commands.executeCommand("vscode.open", local, { preview: true });
    return;
  }

  if (c.edited && c.base) {
    session.backup(c.localPath);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dataverse-merge-"));
    const ext = path.extname(c.localPath);
    const yours = path.join(tmp, `yours${ext}`);
    const base = path.join(tmp, `committed${ext}`);
    fs.copyFileSync(c.localPath, yours);
    fs.writeFileSync(base, c.base);
    try {
      // Same internal command VS Code's git extension uses to open the merge editor.
      await vscode.commands.executeCommand("_open.mergeEditor", {
        base: vscode.Uri.file(base),
        input1: { uri: vscode.Uri.file(yours), title: "Yours", description: "working copy" },
        input2: { uri: staged, title: "Dataverse", description: session.client.orgHost },
        output: local,
      });
      c.choice = "keep";
      tree.update();
      void vscode.window.showInformationMessage(`Resolve ${name} in the merge editor and save. It's marked "keep mine" since the result is your file.`);
      return;
    } catch (err) {
      reportError(new Error(`Merge editor unavailable (${err instanceof Error ? err.message : String(err)}). Opening a diff instead.`));
    }
  }

  session.backup(c.localPath);
  await vscode.commands.executeCommand("vscode.diff", staged, local, `${name}: Dataverse ↔ Yours`, { preview: true });
}
