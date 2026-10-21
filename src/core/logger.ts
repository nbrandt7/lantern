import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let enabled = false;
let failureReported = false;

/** The log follows the user's local calendar day, including across midnight. */
export function logFilePath(at = new Date()): string {
  const day = [at.getFullYear(), String(at.getMonth() + 1).padStart(2, "0"), String(at.getDate()).padStart(2, "0")].join("-");
  return path.join(os.homedir(), ".lantern", "log", `${day}.log`);
}

export function startFileLogging(): string {
  const file = logFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n[${new Date().toISOString()}] Lantern started\n`, "utf8");
  enabled = true;
  return file;
}

/** Mirror Lantern output without changing CLI output or multiline stack traces. */
export function appendLog(text: string): void {
  if (!enabled) return;
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text, "utf8");
  } catch (error) {
    enabled = false;
    if (!failureReported) {
      failureReported = true;
      console.error("Lantern could not write its daily log:", error);
    }
  }
}

/** Timestamped activity that does not need to appear in the Output channel. */
export function logEvent(message: string): void {
  appendLog(`[${new Date().toISOString()}] ${message}\n`);
}
