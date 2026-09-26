import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Conversation } from "@nexura/shared";
import { DB_FILE } from "../config/paths.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
`;

/** Interactive conversations, as JSON, in the same SQLite file as the runs (own connection, WAL). */
export class ConversationStore {
  private readonly db: DatabaseSync;

  public constructor(file = DB_FILE) {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  public list(): Conversation[] {
    const rows = this.db.prepare("SELECT data FROM conversations ORDER BY updated_at DESC").all() as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Conversation);
  }

  public get(id: string): Conversation | undefined {
    const row = this.db.prepare("SELECT data FROM conversations WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Conversation) : undefined;
  }

  public save(conversation: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, updated_at, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(conversation.id, conversation.updatedAt, JSON.stringify(conversation));
  }

  public delete(id: string): void {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }
}
