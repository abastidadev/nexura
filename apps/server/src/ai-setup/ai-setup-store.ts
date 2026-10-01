import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AiSetupSession } from "@nexura/shared";
import { DB_FILE } from "../config/paths.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_setup_sessions (
    id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
`;

/** Sessions of the Setup IA section, as JSON, in the same SQLite file as the runs (own connection, WAL). */
export class AiSetupStore {
  private readonly db: DatabaseSync;

  public constructor(file = DB_FILE) {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  public list(): AiSetupSession[] {
    const rows = this.db.prepare("SELECT data FROM ai_setup_sessions ORDER BY updated_at DESC").all() as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as AiSetupSession);
  }

  public get(id: string): AiSetupSession | undefined {
    const row = this.db.prepare("SELECT data FROM ai_setup_sessions WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AiSetupSession) : undefined;
  }

  public save(session: AiSetupSession): void {
    // What the assistant is doing right now only lives in memory.
    const { activity: _activity, ...stored } = session;
    this.db
      .prepare(
        `INSERT INTO ai_setup_sessions (id, updated_at, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(session.id, session.updatedAt, JSON.stringify(stored));
  }

  public delete(id: string): void {
    this.db.prepare("DELETE FROM ai_setup_sessions WHERE id = ?").run(id);
  }

  public close(): void {
    this.db.close();
  }
}
