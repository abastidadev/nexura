import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CheckTrial, RepoConfig } from "@nexura/shared";
import { git, linkNodeModules, removeWorktree, runShell } from "./git.ts";

const OUTPUT_TAIL = 4000;
const NESTED_DEPTH = 3;

type TrialRepo = Pick<RepoConfig, "path" | "baseBranch" | "nodeModules">;

/**
 * Drops every `node_modules` link below the worktree root (a post-checkout hook may add one,
 * e.g. `frontend/node_modules`), so removing the worktree never touches the main checkout's.
 */
function unlinkNestedNodeModules(dir: string, depth = 0): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (lstatSync(path).isSymbolicLink()) {
      if (entry.name === "node_modules") {
        unlinkSync(path);
      }
    } else if (entry.isDirectory() && depth < NESTED_DEPTH && entry.name !== ".git" && entry.name !== "node_modules") {
      unlinkNestedNodeModules(path, depth + 1);
    }
  }
}

/**
 * Runs a repo's checks on a clean worktree of its base branch, one at a time, and keeps the
 * results in memory for the UI to poll. A check that already fails there would fail every run.
 */
export class CheckTrials {
  private readonly trials = new Map<string, CheckTrial>();
  private readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  public get(id: string): CheckTrial | undefined {
    return this.trials.get(id);
  }

  public start(repo: TrialRepo, checks: string[]): CheckTrial {
    const commands = checks.map((check) => check.trim()).filter(Boolean);
    if (!commands.length) {
      throw new Error("No hay checks que probar");
    }
    if (!repo.path || !existsSync(repo.path)) {
      throw new Error(`No existe la carpeta ${repo.path}`);
    }
    const repoPath = resolve(repo.path);
    if ([...this.trials.values()].some((trial) => trial.repoPath === repoPath && trial.status === "running")) {
      throw new Error("Ya hay una prueba de checks en marcha para este repo");
    }
    const trial: CheckTrial = {
      id: randomUUID().slice(0, 8),
      repoPath,
      status: "running",
      results: commands.map((command) => ({ command, status: "pending" })),
    };
    this.trials.set(trial.id, trial);
    void this.run(trial, { ...repo, path: repoPath }).catch((error: unknown) => {
      trial.status = "failed";
      trial.error = error instanceof Error ? error.message : String(error);
      for (const result of trial.results.filter((item) => item.status === "pending" || item.status === "running")) {
        result.status = "skipped";
      }
    });
    return trial;
  }

  private async run(trial: CheckTrial, repo: TrialRepo): Promise<void> {
    await git(repo.path, ["rev-parse", "--git-dir"]).catch(() => {
      throw new Error(`${repo.path} no es un repo git`);
    });
    await git(repo.path, ["fetch", "--quiet", "origin", repo.baseBranch]).catch(() => undefined);
    const baseRef = await this.baseRef(repo);
    trial.baseRef = baseRef;
    const path = join(`${repo.path}.worktrees`, `nexura-checks-${trial.id}`);
    await git(repo.path, ["worktree", "add", "--detach", path, baseRef]);
    try {
      const mode = repo.nodeModules ?? "link";
      if (mode === "link" && existsSync(join(repo.path, "node_modules")) && !existsSync(join(path, "node_modules"))) {
        linkNodeModules(repo.path, path);
      } else if (mode === "install") {
        await runShell("npm ci", path, this.timeoutMs);
      }
      for (const result of trial.results) {
        result.status = "running";
        const started = Date.now();
        const shell = await runShell(result.command, path, this.timeoutMs);
        result.durationMs = Date.now() - started;
        result.exitCode = shell.exitCode;
        result.outputTail = shell.output.slice(-OUTPUT_TAIL);
        result.status = shell.timedOut ? "timedOut" : shell.exitCode === 0 ? "passed" : "failed";
      }
    } finally {
      unlinkNestedNodeModules(path);
      await removeWorktree({ repo: "", repoPath: repo.path, path, branch: "", baseRef, detached: true });
    }
    // Only once the worktree is gone: the next trial of this repo may start.
    trial.status = "done";
  }

  private async baseRef(repo: TrialRepo): Promise<string> {
    for (const ref of [`origin/${repo.baseBranch}`, repo.baseBranch]) {
      if (await git(repo.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(() => true, () => false)) {
        return ref;
      }
    }
    throw new Error(`No existe la rama base ${repo.baseBranch} en ${repo.path}`);
  }
}
