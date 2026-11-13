import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { isDirectory } from "./files";
import { logEvent } from "./logger";

export interface Cancellation {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): unknown;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  onOutput?: (text: string) => void;
  token?: Cancellation;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command isn't installed or isn't on PATH. */
  missing: boolean;
}

const isWindows = process.platform === "win32";

/**
 * Runs a CLI and collects its output. On Windows, tools like pac and code are
 * .cmd shims that can't be spawned directly, so they run through the shell
 * with every argument quoted.
 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tool = path.basename(cmd);
    // Nothing starts once cancelled, e.g. the sign-in that would follow a cancelled "pac auth select".
    if (options.token?.isCancellationRequested) return resolve({ code: -1, stdout: "", stderr: "Cancelled.", missing: false });
    // Checked up front because cmd.exe misreports both: a missing folder as cmd.exe itself missing,
    // and a missing configured path (lantern.pacPath) as an ordinary failure.
    const notStarted = (message: string, missing: boolean) => {
      logEvent(`Process not started: ${tool} (${message})`);
      options.onOutput?.(`${message}\n`);
      resolve({ code: -1, stdout: "", stderr: message, missing });
    };
    if (options.cwd && !isDirectory(options.cwd)) return notStarted(`The folder ${options.cwd} doesn't exist.`, false);
    if (tool !== cmd && !commandFileExists(path.resolve(options.cwd ?? "", cmd))) return notStarted(`${cmd} doesn't exist.`, true);
    logEvent(`Process started: ${tool}`);
    let stdout = "";
    let stderr = "";
    const child = isWindows
      ? spawn([cmd, ...args].map(quoteWindowsArg).join(" "), { cwd: options.cwd, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: options.cwd });

    const cancelling = options.token?.onCancellationRequested(() => stop(child)) as { dispose?: () => void } | undefined;
    // Decoded per stream, not per chunk, so a character split across two chunks stays whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => {
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (text: string) => {
      stderr += text;
      options.onOutput?.(text);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();

    child.on("error", (err: NodeJS.ErrnoException) => {
      cancelling?.dispose?.();
      logEvent(`Process failed: ${tool} (${err.code ?? err.message}, ${Date.now() - started} ms)`);
      resolve({ code: -1, stdout, stderr: stderr || err.message, missing: err.code === "ENOENT" });
    });
    child.on("close", (code) => {
      cancelling?.dispose?.();
      logEvent(`Process finished: ${tool} (exit ${code ?? -1}, ${Date.now() - started} ms)`);
      // cmd.exe's message about this command itself; one from inside a script ("'pcf-scripts' is not
      // recognized" under npm run build) means the command ran.
      const missing = isWindows && code !== 0 && stderr.startsWith(`'${quoteWindowsArg(cmd)}' is not recognized as an internal or external command`);
      resolve({ code: code ?? -1, stdout, stderr, missing });
    });
  });
}

/** A command given as a path. On Windows "C:/tools/pac" also runs pac.exe or pac.cmd. */
function commandFileExists(file: string): boolean {
  const extensions = isWindows ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  return extensions.some((ext) => fs.existsSync(file + ext));
}

/** On Windows the command runs under cmd.exe, and killing only that leaves the tool it started running. */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return; // its pid may belong to something else by now
  if (!isWindows || !child.pid) {
    child.kill();
    return;
  }
  const taskkill = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "taskkill.exe");
  spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
}

/** Synchronous variant that returns raw bytes. Used for small git plumbing calls. */
export function runBuffer(cmd: string, args: string[], cwd: string, input?: string): { code: number; stdout: Buffer } {
  const result = spawnSync(cmd, args, { cwd, input, windowsHide: true });
  return { code: result.status ?? -1, stdout: result.stdout ?? Buffer.alloc(0) };
}

/**
 * Backslashes before a quote escape it, so they're doubled there (a trailing one kept the argument
 * open). cmd.exe expands %NAME% even inside quotes, so each % stands outside them, where
 * %"NAME"% names no variable and is left alone.
 */
export function quoteWindowsArg(arg: string): string {
  if (/^[\w\-.:/\\=@,]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\+)(?=["%]|$)/g, "$1$1").replace(/"/g, '""').replace(/%/g, '"%"')}"`;
}
