import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Run, RunRequest } from "@nexura/shared";

// Env must be set before the modules read their paths.
const root = mkdtempSync(join(tmpdir(), "nexura-test-"));
const repoPath = join(root, "sandbox");
const stateDir = join(root, "state");
process.env.NEXURA_DATA_DIR = join(root, "data");
process.env.NEXURA_REPOS = join(root, "repos.json");
process.env.NEXURA_CLAUDE_BIN = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "fake-claude.mjs");
process.env.FAKE_STATE_DIR = stateDir;

const { loadConfig } = await import("../config/config-loader.ts");
const { RunStore } = await import("../store/run-store.ts");
const { Orchestrator } = await import("./orchestrator.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function waitFor(orchestrator: InstanceType<typeof Orchestrator>, runId: string): Promise<Run> {
  return new Promise((resolve) => {
    const listener = (message: { type: string; run?: Run }): void => {
      if (message.type === "run" && message.run?.id === runId && ["done", "failed", "cancelled"].includes(message.run.status)) {
        orchestrator.off("message", listener);
        resolve(message.run);
      }
    };
    orchestrator.on("message", listener);
  });
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketText: "Cambiar el color del badge",
    repos: ["sandbox"],
    tasks: [{ id: "t1", title: "Cambiar color", selected: true, done: false }],
    prompt: "",
    profile: "standard",
    stepByStep: false,
    ...overrides,
  };
}

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.email", "test@nexura.local");
  git(repoPath, "config", "user.name", "nexura-test");
  writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(repoPath, "package.json"),
    JSON.stringify({ name: "sandbox", scripts: { check: "node -e \"process.exit(require('fs').existsSync('done.txt')?0:1)\"" } }),
  );
  mkdirSync(join(repoPath, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repoPath, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-q", "-m", "init");
  writeFileSync(
    process.env.NEXURA_REPOS!,
    JSON.stringify({ repos: [{ name: "sandbox", path: repoPath, baseBranch: "main", checks: ["npm run check"] }] }),
  );
});

beforeEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  delete process.env.FAKE_REVIEW_REJECTS;
  delete process.env.FAKE_FAIL_MARKER;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Orchestrator (fake claude)", () => {
  it("runs the standard profile, loops review -> implement once and commits each implement", async () => {
    process.env.FAKE_REVIEW_REJECTS = "1";
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request());
    const run = await waitFor(orchestrator, started.id);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "enrich:succeeded",
      "plan:succeeded",
      "implement:succeeded",
      "codeReview:succeeded",
      "implement:succeeded",
      "codeReview:succeeded",
      "qaCode:succeeded",
      "release:succeeded",
    ]);
    expect(run.request.tasks[0]!.done).toBe(true);
    expect(run.totalCostUsd).toBeCloseTo(0.06);

    const worktree = run.worktrees[0]!;
    expect(worktree.branch).toMatch(/^feat\/[\w]+-cambiar-el-color-del-badge$/);
    const commits = git(worktree.path, "log", "--format=%s", `${worktree.baseRef}..HEAD`).split("\n");
    expect(commits).toEqual(["feat(fake): implement 2", "feat(fake): implement 1"]);
    // The node_modules junction exists but is never committed.
    expect(existsSync(join(worktree.path, "node_modules", "dep", "index.js"))).toBe(true);
    expect(git(worktree.path, "ls-files")).not.toContain("node_modules");

    // The second implement got the review feedback in its prompt.
    const implementRuns = run.steps.filter((s) => s.step === "implement");
    expect(implementRuns[1]!.prompt).toContain("[major] x: p → f");
    expect(readFileSync(join(process.env.NEXURA_DATA_DIR!, "runs", run.id, "ledger.md"), "utf8")).toContain("Commits: sandbox@");

    // Events were persisted per step.
    expect(store.getEvents(run.steps[0]!.id).map((e) => e.event.kind)).toEqual(
      expect.arrayContaining(["init", "rateLimit", "text", "result"]),
    );
    expect(orchestrator.getQuota()?.fiveHour?.utilization).toBe(0.1);

    await orchestrator.cleanup(run.id, true);
    expect(existsSync(worktree.path)).toBe(false);
    expect(existsSync(join(repoPath, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("auto profile runs classify first and follows the chosen profile", async () => {
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "auto", ticketText: "Ticket auto" }));
    const run = await waitFor(orchestrator, started.id);

    expect(run.status).toBe("done");
    expect(run.resolvedProfile).toBe("minimal");
    expect(run.classifyReason).toContain("fake");
    expect(run.steps.map((s) => s.step)).toEqual(["classify", "enrich", "implement", "qaCode", "release"]);
    expect(run.steps[0]!.model).toBe("haiku");
    await orchestrator.cleanup(run.id, true);
  });

  it("stops at the failing step and a retry with an edited prompt finishes the run", async () => {
    process.env.FAKE_FAIL_MARKER = "ROMPER";
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal", ticketText: "Ticket ROMPER" }));
    const failed = await waitFor(orchestrator, started.id);

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Falló el paso enrich");
    expect(failed.steps.at(-1)).toMatchObject({ step: "enrich", status: "failed" });

    const retried = waitFor(orchestrator, started.id);
    orchestrator.retry(started.id, { prompt: "Eres el paso **enrich**. Versión corregida." });
    const run = await retried;

    expect(run.status).toBe("done");
    expect(run.steps.map((s) => `${s.step}#${s.attempt}:${s.status}`)).toEqual([
      "enrich#1:failed",
      "enrich#2:succeeded",
      "implement#1:succeeded",
      "qaCode#1:succeeded",
      "release#1:succeeded",
    ]);
    // The same worktree was reused on retry.
    expect(run.worktrees).toEqual(failed.worktrees);
    await orchestrator.cleanup(run.id, true);
  });

  it("pauses on breakpoints and applies the edited prompt passed to continue()", async () => {
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal", stepByStep: true, ticketText: "Paso a paso" }));
    const done = waitFor(orchestrator, started.id);

    orchestrator.on("message", (message) => {
      if (message.type === "run" && message.run.id === started.id && message.run.status === "paused") {
        const pending = message.run.pendingStep!;
        const edited = pending.step === "enrich" ? { prompt: `${pending.prompt}\nEDITADO` } : undefined;
        setImmediate(() => orchestrator.continue(started.id, edited));
      }
    });
    const run = await done;

    expect(run.status).toBe("done");
    expect(run.steps[0]!.prompt).toContain("EDITADO");
    await orchestrator.cleanup(run.id, true);
  });
});
