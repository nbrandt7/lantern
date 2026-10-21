import * as fs from "fs";
import * as path from "path";
import { run, RunOptions } from "./process";
import { UserError } from "./errors";

export async function git(args: string[], cwd: string, options: RunOptions = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await run("git", args, { ...options, cwd });
  if (r.missing) throw new UserError("Git isn't installed or isn't on your PATH.");
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export async function currentBranch(dir: string): Promise<string> {
  if (!fs.existsSync(path.join(dir, ".git"))) return "";
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return r.ok ? r.out : "";
}

export async function originUrl(dir: string): Promise<string> {
  const r = await git(["remote", "get-url", "origin"], dir);
  return r.ok ? r.out : "";
}

// https://dev.azure.com/org/project/_git/Repo-Name -> Repo-Name
// git@ssh.dev.azure.com:v3/org/project/Repo-Name   -> Repo-Name
export function repoNameFromUrl(url: string): string {
  const last = url.replace(/[?#].*$/, "").replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  try {
    return decodeURIComponent(last).replace(/\.git$/i, "");
  } catch {
    return last.replace(/\.git$/i, "");
  }
}

/** ADO HTTPS URLs often carry "org@" before the host; ignore it when comparing. */
export function sameRemote(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/\/\/[^@/]+@/, "//").replace(/(\.git)?\/*$/, "");
  return norm(a) === norm(b);
}

/**
 * Connects dir to the repo:
 *  - doesn't exist        -> clone
 *  - exists, not a repo   -> init, fetch, check out the default branch (git refuses to overwrite local files)
 *  - already a clone      -> verify it's the same repo
 */
export async function connectRepo(dir: string, url: string, log: (text: string) => void): Promise<void> {
  const onOutput = log;
  if (!fs.existsSync(dir)) {
    const r = await git(["clone", url, path.basename(dir)], path.dirname(dir), { onOutput });
    if (!r.ok) throw new UserError("Clone failed. Check the URL and that you have access to the repo.");
    return;
  }
  if (fs.existsSync(path.join(dir, ".git"))) {
    const origin = await originUrl(dir);
    if (origin && !sameRemote(origin, url)) {
      throw new UserError(`${path.basename(dir)} is already a clone of a different repo (${origin}).`);
    }
    if (!origin && !(await git(["remote", "add", "origin", url], dir)).ok) throw new UserError("Couldn't add the origin remote.");
    return;
  }

  const rollback = (message: string): never => {
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    throw new UserError(message);
  };
  if (!(await git(["init"], dir, { onOutput })).ok) rollback("git init failed.");
  if (!(await git(["remote", "add", "origin", url], dir)).ok) rollback("Couldn't add the origin remote.");
  if (!(await git(["fetch", "origin"], dir, { onOutput })).ok) rollback("Fetch failed. Check the URL and your access.");
  await git(["remote", "set-head", "origin", "--auto"], dir);
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
  if (!head.ok || !head.out) rollback("Couldn't find the repo's default branch. Is the repo empty?");
  const branch = head.out.replace(/^origin\//, "");
  const checkout = await git(["checkout", "-b", branch, "--track", head.out], dir, { onOutput });
  if (!checkout.ok) {
    rollback(`Local files would be overwritten by the checkout. Move them out and try again.\n${checkout.err}`);
  }
}
