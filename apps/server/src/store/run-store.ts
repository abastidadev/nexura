import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Metrics, NexuraEvent, Run, StepRun } from "@nexura/shared";
import { DB_FILE, RUNS_DIR } from "../config/paths.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    profile TEXT,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS step_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    step TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    num_turns INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS step_runs_run ON step_runs(run_id, seq);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    step_run_id TEXT NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (step_run_id, seq)
  );
`;

export type StoredEvent = { seq: number; ts: string; event: NexuraEvent };

/**
 * SQLite persistence (node:sqlite, no native deps). Run and StepRun are stored as JSON
 * with a few flat columns for metrics queries. Raw stream lines also go to
 * data/runs/<runId>/steps/<seq>-<step>.jsonl for low-level debugging.
 */
export class RunStore {
  private readonly db: DatabaseSync;
  private readonly runsDir: string;

  public constructor(file = DB_FILE, runsDir = RUNS_DIR) {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.runsDir = runsDir;
  }

  public saveRun(run: Run): void {
    const { steps: _steps, ...data } = run;
    this.db
      .prepare(
        `INSERT INTO runs (id, status, created_at, profile, total_cost_usd, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, profile = excluded.profile,
           total_cost_usd = excluded.total_cost_usd, data = excluded.data`,
      )
      .run(run.id, run.status, run.createdAt, run.resolvedProfile ?? null, run.totalCostUsd, JSON.stringify(data));
  }

  public saveStepRun(stepRun: StepRun): void {
    this.db
      .prepare(
        `INSERT INTO step_runs (id, run_id, seq, step, status, model, effort, cost_usd, num_turns, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, model = excluded.model, effort = excluded.effort,
           cost_usd = excluded.cost_usd, num_turns = excluded.num_turns, data = excluded.data`,
      )
      .run(
        stepRun.id,
        stepRun.runId,
        stepRun.seq,
        stepRun.step,
        stepRun.status,
        stepRun.model,
        stepRun.effort,
        stepRun.costUsd,
        stepRun.numTurns,
        JSON.stringify(stepRun),
      );
  }

  public addEvent(runId: string, stepRun: StepRun, seq: number, event: NexuraEvent, ts = new Date().toISOString()): void {
    this.db
      .prepare("INSERT INTO events (step_run_id, seq, ts, kind, data) VALUES (?, ?, ?, ?, ?)")
      .run(stepRun.id, seq, ts, event.kind, JSON.stringify(event));
  }

  public rawLogFile(runId: string, stepRun: Pick<StepRun, "seq" | "step">): string {
    return join(this.runsDir, runId, "steps", `${String(stepRun.seq).padStart(2, "0")}-${stepRun.step}.jsonl`);
  }

  public appendRaw(runId: string, stepRun: StepRun, rawLine: string): void {
    const file = this.rawLogFile(runId, stepRun);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, rawLine + "\n");
  }

  /** Removes the run, its steps and events (FK cascade) and its logs/ledger folder. */
  public deleteRun(id: string): void {
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    rmSync(join(this.runsDir, id), { recursive: true, force: true });
  }

  public getRun(id: string): Run | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) {
      return undefined;
    }
    return { ...(JSON.parse(row.data) as Omit<Run, "steps">), steps: this.getStepRuns(id) };
  }

  public listRuns(limit = 100): Run[] {
    const rows = this.db.prepare("SELECT id FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string }[];
    return rows.map((row) => this.getRun(row.id)!);
  }

  public getStepRuns(runId: string): StepRun[] {
    const rows = this.db.prepare("SELECT data FROM step_runs WHERE run_id = ? ORDER BY seq").all(runId) as {
      data: string;
    }[];
    return rows.map((row) => JSON.parse(row.data) as StepRun);
  }

  public getEvents(stepRunId: string, afterSeq = -1): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, ts, data FROM events WHERE step_run_id = ? AND seq > ? ORDER BY seq")
      .all(stepRunId, afterSeq) as { seq: number; ts: string; data: string }[];
    return rows.map((row) => ({ seq: row.seq, ts: row.ts, event: JSON.parse(row.data) as NexuraEvent }));
  }

  /** Cost/turns aggregated per step and model, for the metrics view. */
  public costByStep(): { step: string; model: string; runs: number; costUsd: number; avgTurns: number }[] {
    return this.db
      .prepare(
        `SELECT step, model, COUNT(*) AS runs, SUM(cost_usd) AS costUsd, AVG(num_turns) AS avgTurns
         FROM step_runs GROUP BY step, model ORDER BY costUsd DESC`,
      )
      .all() as { step: string; model: string; runs: number; costUsd: number; avgTurns: number }[];
  }

  /** Aggregates for the metrics view (all from SQLite, no tokens). */
  public metrics(days = 14): Metrics {
    const all = <T>(sql: string, ...params: (string | number)[]): T[] => this.db.prepare(sql).all(...params) as T[];
    const one = <T>(sql: string): T => this.db.prepare(sql).get() as T;
    const tokens = `COALESCE(json_extract(data, '$.usage.inputTokens'), 0) + COALESCE(json_extract(data, '$.usage.outputTokens'), 0)
      + COALESCE(json_extract(data, '$.usage.cacheReadTokens'), 0) + COALESCE(json_extract(data, '$.usage.cacheCreationTokens'), 0)`;

    const totals = one<Metrics["totals"]>(
      `SELECT COUNT(*) AS runs,
         COALESCE(SUM(status = 'done'), 0) AS done,
         COALESCE(SUM(status = 'failed'), 0) AS failed,
         COALESCE(SUM(status = 'cancelled'), 0) AS cancelled,
         COALESCE(SUM(status IN ('queued', 'running', 'paused', 'waiting-rate-limit')), 0) AS active,
         COALESCE(SUM(total_cost_usd), 0) AS costUsd,
         (SELECT COALESCE(SUM(${tokens}), 0) FROM step_runs) AS tokens
       FROM runs`,
    );
    const byStep = all<Metrics["byStep"][number]>(
      `SELECT step, CASE WHEN json_extract(data, '$.kind') = 'builtin' THEN NULL ELSE COALESCE(json_extract(data, '$.agent'), 'claude') END AS agent,
         CASE WHEN json_extract(data, '$.kind') = 'builtin' THEN 'sin LLM' ELSE model END AS model,
         COUNT(*) AS runs, SUM(status = 'failed') AS failed, SUM(cost_usd) AS costUsd, AVG(cost_usd) AS avgCostUsd,
         AVG(num_turns) AS avgTurns, SUM(${tokens}) AS tokens
       FROM step_runs WHERE status != 'skipped' GROUP BY 1, 2, 3 ORDER BY costUsd DESC, runs DESC`,
    );
    const byProfile = all<Metrics["byProfile"][number]>(
      `SELECT COALESCE(profile, 'sin decidir') AS profile, COUNT(*) AS runs, SUM(status = 'done') AS done,
         SUM(total_cost_usd) AS costUsd, AVG(total_cost_usd) AS avgCostUsd
       FROM runs GROUP BY 1 ORDER BY runs DESC`,
    );
    const implementCounts = all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM step_runs WHERE step = 'implement' AND status = 'succeeded' GROUP BY run_id`,
    );
    const byDay = all<Metrics["byDay"][number]>(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS runs, SUM(total_cost_usd) AS costUsd
       FROM runs WHERE created_at >= ? GROUP BY 1 ORDER BY 1`,
      new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
    );

    const rated = all<{ id: string; data: string }>(
      `SELECT id, data FROM runs WHERE json_extract(data, '$.classifyFeedback') IS NOT NULL`,
    ).map((row) => ({ id: row.id, run: JSON.parse(row.data) as Omit<Run, "steps"> }));
    const mistakes = rated
      .filter(({ run }) => run.classifyFeedback?.correct === false)
      .map(({ id, run }) => ({
        runId: id,
        chosen: run.resolvedProfile ?? "?",
        expected: run.classifyFeedback?.expected,
        reason: run.classifyReason,
      }));

    return {
      totals,
      byStep,
      byProfile,
      loops: {
        avgImplementPerRun: implementCounts.length
          ? implementCounts.reduce((sum, row) => sum + row.n, 0) / implementCounts.length
          : 0,
        runsWithLoops: implementCounts.filter((row) => row.n > 1).length,
      },
      byDay,
      classify: { rated: rated.length, correct: rated.length - mistakes.length, mistakes },
    };
  }

  /** Runs left "running" by a crashed server are marked failed on start-up. */
  public failInterrupted(): void {
    for (const run of this.listRuns(1000)) {
      if (run.status === "running" || run.status === "queued" || run.status === "waiting-rate-limit") {
        this.saveRun({ ...run, status: "failed", error: "Servidor reiniciado durante la ejecución" });
      }
    }
  }

  public getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  public setSetting(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  public close(): void {
    this.db.close();
  }
}
