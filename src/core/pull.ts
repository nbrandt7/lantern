import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client } from "./clients";
import { copyTree, isBinary, listFiles, sameContent } from "./files";
import { ignoredPaths, showHead } from "./git";
import { PacContext, solutionClone, solutionSync } from "./pac";
import { findSolutionFolders, solutionNameOf } from "./solutions";

export type ChangeKind = "changed" | "new" | "removed";
export type Choice = "pending" | "dataverse" | "keep";

export interface Change {
  id: string;
  kind: ChangeKind;
  /** Path relative to the client folder. */
  display: string;
  localPath: string;
  /** The Dataverse version, in the temporary staging folder. */
  stagedPath: string;
  /** Committed (HEAD) content, when the client is a repo and the file is committed. */
  base: Buffer | null;
  binary: boolean;
  /** You have uncommitted edits to this file. */
  edited: boolean;
  choice: Choice;
}

export interface PullResult {
  cloned: string[];
  session?: PullSession;
}

/**
 * Pulls a client's solutions. Missing solutions are cloned straight into the folder
 * (nothing local to conflict with). Existing solution folders are synced into a
 * temporary copy and compared, and the differences come back as a PullSession for review.
 */
export async function pull(ctx: PacContext, client: Client): Promise<PullResult> {
  const existing = findSolutionFolders(client.dir);
  const existingNames = new Set(existing.map((f) => solutionNameOf(f).toLowerCase()));
  const toClone = client.config.solutions.filter((s) => !existingNames.has(s.toLowerCase()));

  for (const solution of toClone) await solutionClone(ctx, client, solution, client.dir);
  if (!existing.length) return { cloned: toClone };

  const session = new PullSession(client);
  try {
    for (const folder of existing) {
      const rel = path.relative(client.dir, folder);
      const staged = path.join(session.stagingDir, rel || "_root");
      copyTree(folder, staged);
      ctx.log(`Fetching the Dataverse version of ${rel || "."} into a temporary copy...\n`);
      await solutionSync(ctx, client, staged);
      session.compare(folder, staged, rel);
    }
  } catch (err) {
    session.dispose();
    throw err;
  }
  return { cloned: toClone, session };
}

export class PullSession {
  readonly stagingDir: string;
  readonly changes: Change[] = [];
  /** Git-ignored files (usually build output) that were left alone. */
  ignoredCount = 0;
  private backupRoot?: string;
  private readonly backedUp = new Set<string>();
  private disposed = false;

  constructor(public readonly client: Client) {
    this.stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `dataverse-pull-${client.name}-`));
  }

  compare(localRoot: string, stagedRoot: string, rel: string): void {
    const local = new Set(listFiles(localRoot));
    const staged = new Set(listFiles(stagedRoot));
    const all = [...new Set([...local, ...staged])];
    const repo = this.client.isRepo;
    const ignored = ignoredPaths(this.client.dir, all.map((f) => path.join(rel, f)));

    for (const file of all) {
      const display = path.join(rel, file);
      if (ignored.has(display)) {
        this.ignoredCount++;
        continue;
      }
      const localPath = path.join(localRoot, file);
      const stagedPath = path.join(stagedRoot, file);
      const mine = local.has(file) ? fs.readFileSync(localPath) : null;
      const theirs = staged.has(file) ? fs.readFileSync(stagedPath) : null;
      if (mine && theirs && sameContent(mine, theirs)) continue;

      const base = repo ? showHead(this.client.dir, display) : null;
      const binary = [mine, theirs].some((b) => b !== null && isBinary(b));
      let kind: ChangeKind;
      let edited = false;
      if (mine && theirs) {
        kind = "changed";
        edited = base !== null && !sameContent(mine, base);
      } else if (theirs) {
        kind = "new";
      } else {
        kind = "removed";
        edited = repo && (base === null || !sameContent(mine as Buffer, base));
      }
      this.changes.push({ id: display, kind, display, localPath, stagedPath, base, binary, edited, choice: "pending" });
    }
    this.changes.sort((a, b) => a.display.localeCompare(b.display));
  }

  get pendingCount(): number {
    return this.changes.filter((c) => c.choice === "pending").length;
  }

  /** Copies a local file to .pull-backup/ before it's replaced, deleted, or edited in a merge. */
  backup(file: string): void {
    if (this.backedUp.has(file) || !fs.existsSync(file)) return;
    if (!this.backupRoot) {
      this.backupRoot = path.join(this.client.dir, ".pull-backup");
      fs.rmSync(this.backupRoot, { recursive: true, force: true });
    }
    const target = path.join(this.backupRoot, path.relative(this.client.dir, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    this.backedUp.add(file);
  }

  /** Applies every "dataverse" choice. Pending and "keep" files are left as they are. */
  apply(): { taken: number; kept: number; backups: number } {
    let taken = 0;
    for (const c of this.changes) {
      if (c.choice !== "dataverse") continue;
      taken++;
      if (c.kind === "removed") {
        this.backup(c.localPath);
        fs.rmSync(c.localPath, { force: true });
      } else {
        this.backup(c.localPath);
        fs.mkdirSync(path.dirname(c.localPath), { recursive: true });
        fs.copyFileSync(c.stagedPath, c.localPath);
      }
    }
    return { taken, kept: this.changes.length - taken, backups: this.backedUp.size };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    fs.rmSync(this.stagingDir, { recursive: true, force: true });
  }
}
