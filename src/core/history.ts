import * as fs from "fs";
import * as path from "path";

export interface HistoryEntry {
  sql: string;
  when: string;
  environment: string;
  rows: number;
}

/** Recent queries per client, kept in the extension's storage (newest first, 30 per client). */
export class QueryHistory {
  constructor(private readonly file: string) {}

  private read(): Record<string, HistoryEntry[]> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, HistoryEntry[]>;
    } catch {
      return {};
    }
  }

  list(client: string): HistoryEntry[] {
    return this.read()[client] ?? [];
  }

  add(client: string, entry: HistoryEntry): void {
    const all = this.read();
    const normalized = entry.sql.trim();
    const list = (all[client] ?? []).filter((e) => e.sql.trim() !== normalized);
    all[client] = [{ ...entry, sql: normalized }, ...list].slice(0, 30);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 1));
  }
}
