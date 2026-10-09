import { spawn, spawnSync } from "child_process";

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
    let stdout = "";
    let stderr = "";
    const child = isWindows
      ? spawn([cmd, ...args].map(quoteWindowsArg).join(" "), { cwd: options.cwd, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: options.cwd });

    options.token?.onCancellationRequested(() => child.kill());
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.onOutput?.(text);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();

    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ code: -1, stdout, stderr: stderr || err.message, missing: err.code === "ENOENT" });
    });
    child.on("close", (code) => {
      const missing = isWindows && code !== 0 && /is not recognized as an internal or external command/i.test(stderr);
      resolve({ code: code ?? -1, stdout, stderr, missing });
    });
  });
}

/** Synchronous variant that returns raw bytes. Used for small git plumbing calls. */
export function runBuffer(cmd: string, args: string[], cwd: string, input?: string): { code: number; stdout: Buffer } {
  const result = spawnSync(cmd, args, { cwd, input, windowsHide: true });
  return { code: result.status ?? -1, stdout: result.stdout ?? Buffer.alloc(0) };
}

export function quoteWindowsArg(arg: string): string {
  return /^[\w\-.:/\\=@,]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}
