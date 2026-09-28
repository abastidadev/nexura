import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACHIEVEMENTS_DB_FILE } from "../config/paths.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS facts (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  );
  CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS unlocks (
    id TEXT PRIMARY KEY,
    unlocked_at TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0
  );
`;

/** Something that happened and counts towards achievements, e.g. a ticket resolved or a review published. */
export type Fact<T = Record<string, unknown>> = { kind: string; key: string; at: string; data: T };

export type Unlock = { id: string; unlockedAt: string; seen: boolean };

/**
 * Achievements live in their own SQLite file: they must outlive the runs they came from (a
 * deleted flow does not take its trophy away). Facts are unique per kind+key, so seeing the
 * same run again only updates what it says.
 */
export class AchievementStore {
  private readonly db: DatabaseSync;

  public constructor(file = ACHIEVEMENTS_DB_FILE) {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Records a fact; seen again, its data is updated but it keeps the time it first happened. */
  public putFact(fact: Fact): void {
    this.db
      .prepare("INSERT INTO facts (kind, key, at, data) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET data = excluded.data")
      .run(fact.kind, fact.key, fact.at, JSON.stringify(fact.data));
  }

  public facts(): Fact[] {
    const rows = this.db.prepare("SELECT kind, key, at, data FROM facts ORDER BY at").all() as { kind: string; key: string; at: string; data: string }[];
    return rows.map((row) => ({ kind: row.kind, key: row.key, at: row.at, data: JSON.parse(row.data) as Record<string, unknown> }));
  }

  public bump(key: string, by = 1): number {
    const row = this.db
      .prepare("INSERT INTO counters (key, count) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET count = count + excluded.count RETURNING count")
      .get(key, by) as { count: number };
    return row.count;
  }

  public counters(): Map<string, number> {
    const rows = this.db.prepare("SELECT key, count FROM counters").all() as { key: string; count: number }[];
    return new Map(rows.map((row) => [row.key, row.count]));
  }

  public unlocks(): Map<string, Unlock> {
    const rows = this.db.prepare("SELECT id, unlocked_at, seen FROM unlocks").all() as { id: string; unlocked_at: string; seen: number }[];
    return new Map(rows.map((row) => [row.id, { id: row.id, unlockedAt: row.unlocked_at, seen: row.seen === 1 }]));
  }

  public unlock(id: string, at: string, seen: boolean): void {
    this.db.prepare("INSERT OR IGNORE INTO unlocks (id, unlocked_at, seen) VALUES (?, ?, ?)").run(id, at, seen ? 1 : 0);
  }

  public markSeen(): void {
    this.db.prepare("UPDATE unlocks SET seen = 1 WHERE seen = 0").run();
  }

  public close(): void {
    this.db.close();
  }
}
