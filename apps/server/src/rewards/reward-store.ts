import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Bet, CoinEntry, ShopOffer, ShopSlot } from "@nexura/shared";
import { REWARDS_DB_FILE } from "../config/paths.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS coins (
    key TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS owned (
    item TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS equipped (
    slot TEXT PRIMARY KEY,
    item TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shop_days (
    day TEXT PRIMARY KEY,
    offers TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
`;

/**
 * The wallet: every coin in or out is a row with a unique key (`flow:<runId>`, `buy:<item>`…), so
 * seeing the same thing twice never pays twice, and the balance is their sum. It lives in its own
 * SQLite file, like the trophies, so it outlives the runs it came from.
 */
export class RewardStore {
  private readonly db: DatabaseSync;

  public constructor(file = REWARDS_DB_FILE) {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Adds a movement unless one with the same key exists; true when it was new. */
  public add(entry: CoinEntry): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO coins (key, at, amount, reason) VALUES (?, ?, ?, ?)").run(entry.key, entry.at, entry.amount, entry.reason);
    return Number(result.changes) > 0;
  }

  public has(key: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM coins WHERE key = ?").get(key));
  }

  public balance(): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM coins").get() as { total: number }).total);
  }

  /** Coins earned (not spent) since `since`, optionally only movements whose key starts with `prefix`. */
  public earnedSince(since: string, prefix = ""): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM coins WHERE amount > 0 AND at >= ? AND key LIKE ?").get(since, `${prefix}%`) as { total: number };
    return Number(row.total);
  }

  public history(limit: number): CoinEntry[] {
    return this.db.prepare("SELECT key, at, amount, reason FROM coins ORDER BY at DESC, rowid DESC LIMIT ?").all(limit) as CoinEntry[];
  }

  /** Keys of the movements that start with `prefix`. */
  public keys(prefix: string): string[] {
    return (this.db.prepare("SELECT key FROM coins WHERE key LIKE ?").all(`${prefix}%`) as { key: string }[]).map((row) => row.key);
  }

  public owned(): Set<string> {
    return new Set((this.db.prepare("SELECT item FROM owned").all() as { item: string }[]).map((row) => row.item));
  }

  /** Pays and takes an item in one go: false when the coins were not there (nothing changes then). */
  public buy(item: string, price: number, at: string, reason: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.balance() < price || this.owned().has(item)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("INSERT INTO coins (key, at, amount, reason) VALUES (?, ?, ?, ?)").run(`buy:${item}`, at, -price, reason);
      this.db.prepare("INSERT INTO owned (item, at) VALUES (?, ?)").run(item, at);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public equipped(): Partial<Record<ShopSlot, string>> {
    const rows = this.db.prepare("SELECT slot, item FROM equipped").all() as { slot: ShopSlot; item: string }[];
    return Object.fromEntries(rows.map((row) => [row.slot, row.item]));
  }

  public equip(slot: ShopSlot, item: string | null): void {
    if (item) {
      this.db.prepare("INSERT INTO equipped (slot, item) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET item = excluded.item").run(slot, item);
    } else {
      this.db.prepare("DELETE FROM equipped WHERE slot = ?").run(slot);
    }
  }

  /** The offers drawn for `day`, kept so buying something doesn't reshuffle the shop. */
  public shopDay(day: string, draw: () => ShopOffer[]): ShopOffer[] {
    const row = this.db.prepare("SELECT offers FROM shop_days WHERE day = ?").get(day) as { offers: string } | undefined;
    if (row) {
      return JSON.parse(row.offers) as ShopOffer[];
    }
    const offers = draw();
    this.db.prepare("INSERT OR IGNORE INTO shop_days (day, offers) VALUES (?, ?)").run(day, JSON.stringify(offers));
    return offers;
  }

  /** Places a bet and takes its stake in one go: false without the coins. */
  public placeBet(bet: Bet, reason: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.balance() < bet.stake) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("INSERT INTO coins (key, at, amount, reason) VALUES (?, ?, ?, ?)").run(`bet:${bet.id}`, bet.placedAt, -bet.stake, reason);
      this.db.prepare("INSERT INTO bets (id, data) VALUES (?, ?)").run(bet.id, JSON.stringify(bet));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public bets(): Bet[] {
    return (this.db.prepare("SELECT data FROM bets").all() as { data: string }[]).map((row) => JSON.parse(row.data) as Bet).sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  }

  public saveBet(bet: Bet): void {
    this.db.prepare("UPDATE bets SET data = ? WHERE id = ?").run(JSON.stringify(bet), bet.id);
  }

  public close(): void {
    this.db.close();
  }
}
