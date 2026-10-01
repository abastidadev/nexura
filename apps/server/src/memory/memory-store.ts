import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { MemoryObservation } from "@nexura/shared";

/**
 * Shared memory of Nexura (idea taken from engram): observations (decisions, bug causes,
 * conventions, ticket summaries...) per project, in their own SQLite file with an FTS5
 * index. The Nexura server writes to it, and so does the MCP server (mcp-server.ts) that
 * the steps and, if the user adds it, the interactive Claude Code run as separate
 * processes: WAL + busy_timeout let them share the file.
 *
 * Imports only node built-ins (and types) so the MCP server starts fast.
 */

export type { MemoryObservation };

export type NewObservation = Pick<MemoryObservation, "project" | "type" | "title" | "content"> &
  Partial<Pick<MemoryObservation, "topicKey" | "source" | "runId" | "files">>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    topic_key TEXT,
    source TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revisions INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS observations_project ON observations(project, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS observations_topic ON observations(project, topic_key)
    WHERE topic_key IS NOT NULL AND deleted_at IS NULL;
  CREATE TABLE IF NOT EXISTS observation_files (
    observation_id INTEGER NOT NULL REFERENCES observations(id),
    path TEXT NOT NULL COLLATE NOCASE,
    dir TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (observation_id, path)
  );
  CREATE INDEX IF NOT EXISTS observation_files_path ON observation_files(path);
  CREATE INDEX IF NOT EXISTS observation_files_dir ON observation_files(dir);
  CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    title, content, content = 'observations', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE OF title, content ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END;
`;

/** Words too common to help a search (FTS5 already ignores case and accents). */
const STOPWORDS = new Set(
  "los las del con por para que una uno unos unas como sus mas pero sin sobre entre este esta esto estos estas the and for with from that this into when".split(" "),
);
const MIN_WORD = 3;
const MAX_TERMS = 12;
const MAX_FILES = 50;
/** Days after which a search match ranks half as well as a fresh one with the same bm25. */
const HALF_RELEVANCE_DAYS = 180;

/** A repo-relative path as stored: forward slashes, no leading "./" or "/". Undefined when empty. */
export function normalizePath(path: string): string | undefined {
  const clean = path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return clean && clean !== "." ? clean : undefined;
}

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

function normalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter((path): path is string => Boolean(path)))].slice(0, MAX_FILES);
}

/**
 * Free text to an FTS5 query: each word quoted (so punctuation and FTS operators in a
 * ticket title are harmless), as a prefix, joined with OR and ranked by bm25. Undefined
 * when nothing is left to search for.
 */
export function ftsQuery(text: string): string | undefined {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD && !STOPWORDS.has(word));
  const unique = [...new Set(words)].slice(0, MAX_TERMS);
  return unique.length ? unique.map((word) => `"${word}"*`).join(" OR ") : undefined;
}

type Row = {
  id: number;
  project: string;
  type: string;
  title: string;
  content: string;
  topic_key: string | null;
  source: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  revisions: number;
  files: string | null;
};

function toObservation(row: Row): MemoryObservation {
  return {
    id: row.id,
    project: row.project,
    type: row.type,
    title: row.title,
    content: row.content,
    ...(row.topic_key ? { topicKey: row.topic_key } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revisions: row.revisions,
    ...(row.files ? { files: row.files.split("\n").sort() } : {}),
  };
}

const COLUMNS =
  "o.id, o.project, o.type, o.title, o.content, o.topic_key, o.source, o.run_id, o.created_at, o.updated_at, o.revisions, " +
  "(SELECT group_concat(path, char(10)) FROM observation_files WHERE observation_id = o.id) AS files";

export class MemoryStore {
  private readonly db: DatabaseSync;

  public constructor(file: string) {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /**
   * Saves an observation. With a `topicKey` that already exists in the project, updates
   * that one instead (revisions + 1): evolving topics stay as one observation. Without a
   * topic, an observation of the same type and title (case-insensitive) is updated too, so
   * an agent that learns the same thing twice does not duplicate it. `files` replaces the
   * files it is about; left out on an update, they are kept.
   */
  public save(entry: NewObservation): MemoryObservation {
    const now = new Date().toISOString();
    const topicKey = entry.topicKey?.trim() || null;
    const existing = (
      topicKey
        ? this.db.prepare("SELECT id FROM observations WHERE project = ? AND topic_key = ? AND deleted_at IS NULL").get(entry.project, topicKey)
        : this.db
            .prepare("SELECT id FROM observations WHERE project = ? AND type = ? AND lower(title) = lower(?) AND topic_key IS NULL AND deleted_at IS NULL ORDER BY id DESC")
            .get(entry.project, entry.type, entry.title.trim())
    ) as { id: number } | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let id: number;
      if (existing) {
        this.db
          .prepare(
            `UPDATE observations SET type = ?, title = ?, content = ?, source = ?, run_id = ?, updated_at = ?, revisions = revisions + 1
             WHERE id = ?`,
          )
          .run(entry.type, entry.title, entry.content, entry.source ?? null, entry.runId ?? null, now, existing.id);
        id = existing.id;
      } else {
        const { lastInsertRowid } = this.db
          .prepare(
            `INSERT INTO observations (project, type, title, content, topic_key, source, run_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(entry.project, entry.type, entry.title, entry.content, topicKey, entry.source ?? null, entry.runId ?? null, now, now);
        id = Number(lastInsertRowid);
      }
      if (entry.files) {
        this.db.prepare("DELETE FROM observation_files WHERE observation_id = ?").run(id);
        const insert = this.db.prepare("INSERT INTO observation_files (observation_id, path, dir) VALUES (?, ?, ?)");
        for (const path of normalizePaths(entry.files)) {
          insert.run(id, path, dirOf(path));
        }
      }
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public get(id: number): MemoryObservation | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM observations o WHERE o.id = ? AND o.deleted_at IS NULL`).get(id) as Row | undefined;
    return row ? toObservation(row) : undefined;
  }

  /**
   * Best matches first (bm25, title weighs more than content, discounted with age so a
   * fresh decision beats a stale one of similar relevance). Empty for a query with no usable words.
   */
  public search(project: string, text: string, limit = 10): MemoryObservation[] {
    const query = ftsQuery(text);
    if (!query) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM observations_fts f JOIN observations o ON o.id = f.rowid
         WHERE observations_fts MATCH ? AND o.project = ? AND o.deleted_at IS NULL
         ORDER BY bm25(observations_fts, 3.0, 1.0) / (1.0 + (julianday('now') - julianday(o.updated_at)) / ${HALF_RELEVANCE_DAYS}.0), o.id DESC LIMIT ?`,
      )
      .all(query, project, limit) as Row[];
    return rows.map(toObservation);
  }

  /**
   * Observations about these files (repo-relative paths): those that touch the same file
   * first, then those in the same folder; the latest first within each. The link between an
   * observation and the code it is about, which a text search on the path cannot give.
   */
  public byFiles(project: string, paths: readonly string[], limit = 10): MemoryObservation[] {
    const files = normalizePaths(paths);
    if (files.length === 0) {
      return [];
    }
    const dirs = [...new Set(files.map(dirOf))].filter((dir) => dir !== ".");
    const marks = (values: unknown[]): string => values.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS}, ranked.score FROM (
           SELECT observation_id, SUM(CASE WHEN path IN (${marks(files)}) THEN 2 ELSE 1 END) AS score FROM observation_files
           WHERE path IN (${marks(files)})${dirs.length ? ` OR dir IN (${marks(dirs)})` : ""}
           GROUP BY observation_id
         ) ranked JOIN observations o ON o.id = ranked.observation_id
         WHERE o.project = ? AND o.deleted_at IS NULL
         ORDER BY ranked.score DESC, o.updated_at DESC, o.id DESC LIMIT ?`,
      )
      .all(...files, ...files, ...dirs, project, limit) as Row[];
    return rows.map(toObservation);
  }

  /** Latest updated observations of the project. */
  public recent(project: string, limit = 10): MemoryObservation[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM observations o WHERE o.project = ? AND o.deleted_at IS NULL ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`)
      .all(project, limit) as Row[];
    return rows.map(toObservation);
  }

  /** Soft delete: it stops showing up, and its topic can be saved again. */
  public delete(id: number): boolean {
    return this.db.prepare("UPDATE observations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(new Date().toISOString(), id).changes > 0;
  }

  public projects(): { project: string; observations: number; updatedAt: string }[] {
    return this.db
      .prepare(
        `SELECT project, COUNT(*) AS observations, MAX(updated_at) AS updatedAt FROM observations
         WHERE deleted_at IS NULL GROUP BY project ORDER BY updatedAt DESC`,
      )
      .all() as { project: string; observations: number; updatedAt: string }[];
  }

  public close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------- project identity

const exec = promisify(execFile);
const projectCache = new Map<string, string>();

/** Repo name from a remote URL (GitHub, Azure DevOps https/ssh), lowercased. */
export function projectFromRemote(url: string): string | undefined {
  const name = url.trim().replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/i, "");
  return name ? name.toLowerCase() : undefined;
}

/**
 * The memory project of a checkout: its origin repo name (so every worktree and clone of a
 * repo, and the interactive sessions on it, share one project), else its folder name.
 */
export async function projectOf(cwd: string): Promise<string> {
  const cached = projectCache.get(cwd);
  if (cached) {
    return cached;
  }
  let project: string | undefined;
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd, windowsHide: true });
    project = projectFromRemote(stdout);
  } catch {
    try {
      // No remote: the main checkout's folder (a worktree's own folder would differ per run).
      const { stdout } = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, windowsHide: true });
      project = basename(dirname(stdout.trim())).toLowerCase();
    } catch {
      // Not a git checkout.
    }
  }
  project ??= basename(cwd).toLowerCase();
  projectCache.set(cwd, project);
  return project;
}
