import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrDraft, ReviewReply, ReviewThread, Run, RunRequest, Worktree } from "@nexura/shared";

// Never push or call Azure DevOps from tests: record what would have been created.
const createdPrs: PrDraft[] = [];
const postedReplies: ReviewReply[] = [];
const pushed: string[] = [];
const activeThreads: ReviewThread[] = [];
vi.mock("../azure/pr-threads.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../azure/pr-threads.ts")>()),
  getActiveThreads: async () => activeThreads,
  replyToThread: async (_worktree: Worktree, _prId: number, reply: ReviewReply) => {
    postedReplies.push(reply);
  },
  pushBranch: async (worktree: Worktree) => {
    pushed.push(worktree.branch);
  },
}));
const prStatus = { value: "active" };
vi.mock("../azure/pull-requests.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../azure/pull-requests.ts")>()),
  getPrStatus: async () => prStatus.value,
  pushAndCreatePr: async (worktree: Worktree, draft: PrDraft) => {
    createdPrs.push(draft);
    return { repo: worktree.repo, id: 42, url: "https://dev.azure.com/org/p/_git/r/pullrequest/42", title: draft.title };
  },
}));

// Env must be set before the modules read their paths.
const root = mkdtempSync(join(tmpdir(), "nexura-test-"));
const repoPath = join(root, "sandbox");
const stateDir = join(root, "state");
process.env.NEXURA_DATA_DIR = join(root, "data");
process.env.NEXURA_REPOS = join(root, "repos.json");
process.env.NEXURA_CLAUDE_BIN = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "fake-claude.mjs");
process.env.FAKE_STATE_DIR = stateDir;
// Never touch the real ~/.claude.json from tests.
process.env.NEXURA_TRUST_WORKTREES = "0";

const { loadConfig } = await import("../config/config-loader.ts");
const { RunStore } = await import("../store/run-store.ts");
const { Orchestrator } = await import("./orchestrator.ts");
const { PrWatcher } = await import("../azure/pr-watcher.ts");
const { readRepoNotes, saveRepoNotes } = await import("../workspace/repo-context.ts");

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
  delete process.env.FAKE_WAIT_MESSAGE;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Orchestrator (fake claude)", () => {
  it("runs a custom step after its anchor, commits its changes, then deletes the run but keeps the branch", async () => {
    const config = loadConfig();
    const implement = config.steps.get("implement")!;
    config.steps.set("docs", {
      ...implement,
      name: "docs",
      custom: true,
      label: "Docs",
      after: "implement",
      schema: undefined,
      promptTemplate: "Eres el paso **docs**.\n{{output.implement}}",
    });
    const minimal = config.profiles.get("minimal")!;
    config.profiles.set("docs-profile", { ...minimal, name: "docs-profile", steps: { ...minimal.steps, docs: { model: "haiku", effort: "low", enabled: true } } });
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(config, store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "docs-profile" }));
    await expect(orchestrator.deleteRun(started.id)).rejects.toThrow(/activo/);
    const run = await waitFor(orchestrator, started.id);

    expect(run.error).toBeUndefined();
    expect(run.steps.map((step) => step.step)).toEqual(["enrich", "implement", "docs", "qaCode", "release"]);
    expect(run.steps.find((step) => step.step === "docs")!.structuredOutput).toBe("hecho docs");
    const worktree = run.worktrees[0]!;
    expect(git(worktree.path, "log", "-1", "--format=%s")).toBe("chore: Docs (nexura)");

    const deleted: string[] = [];
    orchestrator.on("message", (message) => message.type === "runDeleted" && deleted.push(message.runId));
    await orchestrator.deleteRun(run.id);
    expect(store.getRun(run.id)).toBeUndefined();
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repoPath, "branch", "--list", worktree.branch)).toContain(worktree.branch);
    expect(deleted).toEqual([run.id]);
    git(repoPath, "branch", "-D", worktree.branch);
  });

  it("delivers a message typed while a claude step runs to that same turn", async () => {
    process.env.FAKE_WAIT_MESSAGE = "1";
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal" }));
    expect(() => orchestrator.sendMessage(started.id, "   ")).toThrow(/vacío/);
    orchestrator.on("message", (message) => {
      if (message.type === "event" && message.event.kind === "text" && message.event.text === "esperando mensaje") {
        orchestrator.sendMessage(started.id, "usa signals");
      }
    });
    const run = await waitFor(orchestrator, started.id);

    expect(run.status).toBe("done");
    const enrich = run.steps.find((step) => step.step === "enrich")!;
    expect(enrich.structuredOutput).toMatchObject({ summary: "fake + usa signals" });
    expect(store.getEvents(enrich.id, -1).map((stored) => stored.event)).toContainEqual({ kind: "userMessage", text: "usa signals" });
    expect(() => orchestrator.sendMessage(run.id, "tarde")).toThrow(/no hay ningún paso/);
    await orchestrator.cleanup(run.id, true);
  });

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

describe("Release to Azure DevOps (push and PR mocked)", () => {
  function onPause(orchestrator: InstanceType<typeof Orchestrator>, runId: string, act: (run: Run) => void): void {
    orchestrator.on("message", (message) => {
      if (message.type === "run" && message.run.id === runId && message.run.status === "paused" && message.run.pendingStep?.prDrafts) {
        const run = message.run;
        setImmediate(() => act(run));
      }
    });
  }

  it("pauses with a PR draft and creates it with the approved edits, linking the work item", async () => {
    createdPrs.length = 0;
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal", ticketId: "59128", ticketText: "Ticket con PR", release: "pr" }));
    let seenDraft: PrDraft | undefined;
    onPause(orchestrator, started.id, (run) => {
      seenDraft = run.pendingStep!.prDrafts![0];
      orchestrator.continue(started.id, { prDrafts: [{ ...seenDraft!, title: "feat(fake): título editado", branch: "hack/other" }] });
    });
    const run = await waitFor(orchestrator, started.id);

    expect(run.status).toBe("done");
    expect(seenDraft).toMatchObject({ repo: "sandbox", target: "main", workItemId: 59128, title: "feat(fake): implement 1" });
    expect(seenDraft!.description).not.toContain("59128");
    // Title is editable; the branch is not.
    expect(createdPrs).toEqual([expect.objectContaining({ title: "feat(fake): título editado", branch: seenDraft!.branch })]);
    expect(run.pullRequests).toEqual([expect.objectContaining({ id: 42 })]);
    await orchestrator.cleanup(run.id, true);
  });

  it("skipping at the approval keeps the branch local and finishes the run", async () => {
    createdPrs.length = 0;
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal", ticketText: "Ticket sin PR", release: "pr" }));
    onPause(orchestrator, started.id, () => orchestrator.continue(started.id, { skip: true }));
    const run = await waitFor(orchestrator, started.id);

    expect(run.status).toBe("done");
    expect(createdPrs).toHaveLength(0);
    expect(run.pullRequests).toBeUndefined();
    await orchestrator.cleanup(run.id, true);
  });
});

describe("addressReview (Azure mocked)", () => {
  it("fixes, commits, pauses with the replies and only pushes and answers after approval", async () => {
    createdPrs.length = 0;
    postedReplies.length = 0;
    pushed.length = 0;
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal", ticketId: "7", ticketText: "Ticket revisado", release: "pr" }));
    orchestrator.on("message", (message) => {
      if (message.type === "run" && message.run.id === started.id && message.run.pendingStep?.prDrafts) {
        setImmediate(() => orchestrator.continue(started.id));
      }
    });
    const released = await waitFor(orchestrator, started.id);
    expect(released.pullRequests).toHaveLength(1);

    activeThreads.splice(0, activeThreads.length,
      { repo: "sandbox", prId: 42, threadId: 11, filePath: "/math.js", line: 3, comments: [{ author: "Ana", content: "Falta validar" }] },
      { repo: "sandbox", prId: 42, threadId: 12, comments: [{ author: "Luis", content: "¿Por qué así?" }] },
    );
    expect(await orchestrator.reviewThreads(started.id)).toHaveLength(2);

    let pending: Run["pendingStep"];
    orchestrator.on("message", (message) => {
      if (message.type === "run" && message.run.id === started.id && message.run.pendingStep?.replies) {
        pending = message.run.pendingStep;
        const edited = pending.replies!.filter((reply) => reply.threadId === 11).map((reply) => ({ ...reply, reply: "Validado, gracias" }));
        setImmediate(() => orchestrator.continue(started.id, { replies: edited }));
      }
    });
    const reviewed = waitFor(orchestrator, started.id);
    orchestrator.addressReview(started.id);
    const run = await reviewed;

    expect(run.status).toBe("done");
    // The invented thread 999 never reaches the approval; the prompt listed both real threads.
    expect(pending!.replies!.map((reply) => reply.threadId)).toEqual([11, 12]);
    expect(pending!.commits).toHaveLength(1);
    expect(run.steps.at(-1)).toMatchObject({ step: "addressReview", status: "succeeded" });
    expect(run.steps.at(-1)!.prompt).toContain("thread 11 · /math.js:3");
    // Only the approved (edited) reply was posted, after pushing the fix.
    expect(pushed).toEqual([run.worktrees[0]!.branch]);
    expect(postedReplies).toEqual([{ repo: "sandbox", threadId: 11, reply: "Validado, gracias", action: "fixed" }]);
    const log = git(run.worktrees[0]!.path, "log", "--format=%s", "-1");
    expect(log).toBe("fix(fake): address review");
    await orchestrator.cleanup(run.id, true);
  });

  it("finishes without spending anything when there are no active threads", async () => {
    postedReplies.length = 0;
    activeThreads.length = 0;
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal", ticketText: "Sin comentarios", release: "pr" }));
    orchestrator.on("message", (message) => {
      if (message.type === "run" && message.run.id === started.id && message.run.pendingStep?.prDrafts) {
        setImmediate(() => orchestrator.continue(started.id));
      }
    });
    await waitFor(orchestrator, started.id);
    const steps = store.getRun(started.id)!.steps.length;

    const reviewed = waitFor(orchestrator, started.id);
    orchestrator.addressReview(started.id);
    const run = await reviewed;
    expect(run.status).toBe("done");
    expect(run.steps).toHaveLength(steps);
    expect(postedReplies).toHaveLength(0);
    await orchestrator.cleanup(run.id, true);
  });
});

describe("Budgets, classify feedback, qaNotes and metrics", () => {
  it("caps each step with the remaining profile budget and stops when it is spent", async () => {
    const config = loadConfig();
    config.profiles.set("tight", { ...structuredClone(config.profiles.get("minimal")!), name: "tight", budgetUsd: 0.015 });
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(config, store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "tight", ticketText: "Con presupuesto" }));
    const run = await waitFor(orchestrator, started.id);

    // enrich spends 0.01 of 0.015 -> implement gets --max-budget-usd 0.005, spends 0.01 -> nothing left.
    expect(run.steps[0]!.args).toEqual(expect.arrayContaining(["--max-budget-usd", "0.015"]));
    expect(run.steps[1]!.args).toEqual(expect.arrayContaining(["--max-budget-usd", "0.005"]));
    expect(run.status).toBe("done");

    const config2 = loadConfig();
    config2.profiles.set("broke", { ...structuredClone(config2.profiles.get("minimal")!), name: "broke", budgetUsd: 0.01 });
    const orchestrator2 = new Orchestrator(config2, store, { concurrency: 1 });
    const started2 = orchestrator2.start(request({ profile: "broke", ticketText: "Sin presupuesto" }));
    const failed = await waitFor(orchestrator2, started2.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Falló el paso implement: Presupuesto del perfil agotado/);
    await orchestrator.cleanup(run.id, true);
    await orchestrator2.cleanup(failed.id, true);
  });

  it("runs qaNotes in the full profile, rates classify and aggregates metrics", async () => {
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });

    const full = await waitFor(orchestrator, orchestrator.start(request({ profile: "full", ticketText: "Grande" })).id);
    expect(full.steps.map((s) => s.step)).toEqual(["enrich", "plan", "implement", "codeReview", "qaCode", "release", "qaNotes"]);
    expect(full.steps.at(-1)!.structuredOutput).toMatchObject({ cases: [expect.objectContaining({ title: "Caso feliz" })] });

    const auto = await waitFor(orchestrator, orchestrator.start(request({ profile: "auto", ticketText: "Auto" })).id);
    expect(() => orchestrator.rateClassify(full.id, true)).toThrow(/no pasó por classify/);
    expect(() => orchestrator.rateClassify(auto.id, false, "nope")).toThrow(/Perfil desconocido/);
    expect(orchestrator.rateClassify(auto.id, false, "standard").classifyFeedback).toMatchObject({ correct: false, expected: "standard" });

    const metrics = store.metrics();
    expect(metrics.totals).toMatchObject({ runs: 2, done: 2, failed: 0 });
    // full: enrich, plan, implement, codeReview, qaNotes; auto: classify, enrich, implement.
    expect(metrics.totals.costUsd).toBeCloseTo(0.01 * 5 + 0.01 * 3);
    expect(metrics.byStep.find((row) => row.step === "qaCode")).toMatchObject({ model: "sin LLM", runs: 2 });
    expect(metrics.byProfile.map((row) => row.profile).sort()).toEqual(["full", "minimal"]);
    expect(metrics.classify).toMatchObject({ rated: 1, correct: 0, mistakes: [{ runId: auto.id, chosen: "minimal", expected: "standard" }] });
    expect(metrics.byDay).toHaveLength(1);
    await orchestrator.cleanup(full.id, true);
    await orchestrator.cleanup(auto.id, true);
  });
});

describe("Quota guard, repo knowledge and PR watcher", () => {
  it("waits for the 5 h window reset before a claude step when usage is above the threshold", async () => {
    const store = new RunStore(":memory:");
    store.setSetting("quota", {
      status: "allowed",
      fiveHour: { utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 1 },
      updatedAt: new Date().toISOString(),
    });
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1, rateLimitMarginMs: 0 });
    expect(orchestrator.getSettings().quotaPausePercent).toBe(90);
    const statuses: string[] = [];
    orchestrator.on("message", (message) => {
      if (message.type === "run" && statuses.at(-1) !== message.run.status) {
        statuses.push(message.run.status);
      }
    });
    const run = await waitFor(orchestrator, orchestrator.start(request({ profile: "minimal", ticketText: "Cuota alta" })).id);

    expect(run.status).toBe("done");
    expect(statuses).toEqual(expect.arrayContaining(["waiting-rate-limit", "running", "done"]));
    expect(statuses.indexOf("waiting-rate-limit")).toBeLessThan(statuses.lastIndexOf("running"));
    await orchestrator.cleanup(run.id, true);
  });

  it("validates settings", () => {
    const orchestrator = new Orchestrator(loadConfig(), new RunStore(":memory:"), { concurrency: 1 });
    expect(orchestrator.saveSettings({ quotaPausePercent: null, prPollSeconds: 0 })).toEqual({ quotaPausePercent: null, prPollSeconds: 0 });
    expect(() => orchestrator.saveSettings({ quotaPausePercent: 150 })).toThrow(/umbral/);
    expect(() => orchestrator.saveSettings({ prPollSeconds: 5 })).toThrow(/al menos 30/);
  });

  it("learns enrich conventions per repo and hands them, with the repo map, to the next ticket", async () => {
    saveRepoNotes("sandbox", ""); // Earlier tests in this file already taught it.
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const first = await waitFor(orchestrator, orchestrator.start(request({ profile: "minimal", ticketText: "Aprende" })).id);
    expect(readRepoNotes("sandbox")).toContain("- Usa inject() en vez de constructores");
    expect(store.getEvents(first.steps[0]!.id).some((e) => e.event.kind === "text" && e.event.text.includes("Aprendidas"))).toBe(true);

    const second = await waitFor(orchestrator, orchestrator.start(request({ profile: "minimal", ticketText: "Usa lo aprendido" })).id);
    const enrichPrompt = second.steps[0]!.prompt!;
    expect(enrichPrompt).toContain("## Notas aprendidas del repo\n**sandbox**\n- Usa inject() en vez de constructores");
    expect(enrichPrompt).toMatch(/\*\*sandbox\*\* \(\d+ ficheros versionados\)/);
    expect(enrichPrompt).toContain("Scripts npm: check");
    // Already known: nothing new is learned the second time.
    expect(store.getEvents(second.steps[0]!.id).some((e) => e.event.kind === "text" && e.event.text.includes("Aprendidas"))).toBe(false);
    await orchestrator.cleanup(first.id, true);
    await orchestrator.cleanup(second.id, true);
  });

  it("polls open PRs for free, notifies new comments and stops when the PR is closed", async () => {
    prStatus.value = "active";
    activeThreads.length = 0;
    const store = new RunStore(":memory:");
    const orchestrator = new Orchestrator(loadConfig(), store, { concurrency: 1 });
    const started = orchestrator.start(request({ profile: "minimal", ticketId: "8", ticketText: "Vigilada", release: "pr" }));
    orchestrator.on("message", (message) => {
      if (message.type === "run" && message.run.id === started.id && message.run.pendingStep?.prDrafts) {
        setImmediate(() => orchestrator.continue(started.id));
      }
    });
    await waitFor(orchestrator, started.id);
    const notices: string[] = [];
    orchestrator.on("message", (message) => {
      if (message.type === "notice") {
        notices.push(message.body);
      }
    });
    const watcher = new PrWatcher(orchestrator);

    await watcher.tick();
    expect(store.getRun(started.id)!.reviewWatch).toMatchObject({ activeThreads: 0, prStatus: "active" });
    expect(notices).toEqual([]);

    activeThreads.push({ repo: "sandbox", prId: 42, threadId: 1, comments: [{ author: "Ana", content: "?" }] });
    await watcher.tick();
    expect(store.getRun(started.id)!.reviewWatch?.activeThreads).toBe(1);
    expect(notices).toEqual([expect.stringContaining("1 comentario(s) pendiente(s)")]);

    await watcher.tick();
    expect(notices).toHaveLength(1);

    prStatus.value = "completed";
    await watcher.tick();
    expect(notices.at(-1)).toContain("completado");
    const checkedAt = store.getRun(started.id)!.reviewWatch!.checkedAt;
    await watcher.tick();
    expect(store.getRun(started.id)!.reviewWatch!.checkedAt).toBe(checkedAt);
    await orchestrator.cleanup(started.id, true);
  });
});
