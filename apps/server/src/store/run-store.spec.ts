import { describe, expect, it } from "vitest";
import type { AgentKind, Run, StepRun } from "@nexura/shared";
import { RunStore } from "./run-store.ts";

describe("provider metrics", () => {
  it("groups token usage by agent, profile and day while keeping unknown costs out of the comparison", () => {
    const store = new RunStore(":memory:");
    const today = new Date().toISOString();
    const steps: { agent: AgentKind; profile: string; tokens: number; cost: number }[] = [
      { agent: "claude", profile: "full", tokens: 10, cost: 0.02 },
      { agent: "codex", profile: "full", tokens: 20, cost: 0 },
      { agent: "copilot", profile: "minimal", tokens: 30, cost: 0 },
    ];
    for (const [index, item] of steps.entries()) {
      const id = `run-${index}`;
      const run: Run = {
        id,
        request: { ticketText: "", repos: [], tasks: [], prompt: "", profile: item.profile, stepByStep: false },
        status: "done",
        resolvedProfile: item.profile,
        createdAt: today,
        steps: [],
        worktrees: [],
        totalCostUsd: item.cost,
      };
      const step: StepRun = {
        id: `step-${index}`, runId: id, step: "implement", attempt: 1, seq: 0,
        status: "succeeded", kind: "claude", agent: item.agent, model: item.agent,
        effort: "medium", costUsd: item.cost, numTurns: 1,
        usage: { inputTokens: item.tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 },
      };
      store.saveRun(run);
      store.saveStepRun(step);
    }

    const metrics = store.metrics();
    expect(metrics.totals).toMatchObject({ tokens: 60, costUsd: 0.02 });
    expect(Object.fromEntries(metrics.byAgent.map((row) => [row.agent, row.tokens]))).toEqual({ claude: 10, codex: 20, copilot: 30 });
    expect(Object.fromEntries(metrics.byProfile.map((row) => [row.profile, row.tokens]))).toEqual({ full: 30, minimal: 30 });
    expect(metrics.byDay).toMatchObject([{ runs: 3, done: 3, tokens: 60 }]);
    expect(metrics.byModel.map((row) => [row.agent, row.model, row.tokens])).toEqual([
      ["copilot", "copilot", 30],
      ["codex", "codex", 20],
      ["claude", "claude", 10],
    ]);
    expect(metrics.tokenSplit).toEqual({ input: 60, output: 0, cacheRead: 0, cacheCreation: 0 });
    store.close();
  });

  it("counts the commits of each run's latest successful release by Conventional Commits type", () => {
    const store = new RunStore(":memory:");
    const run: Run = {
      id: "run-1",
      request: { ticketText: "", repos: [], tasks: [], prompt: "", profile: "standard", stepByStep: false },
      status: "done",
      createdAt: new Date().toISOString(),
      steps: [],
      worktrees: [],
      totalCostUsd: 0,
      pullRequests: [{ repo: "web", id: 7, url: "https://example.test/pr/7", title: "Login" }],
    };
    const release = (seq: number, status: StepRun["status"], commits: string[]): StepRun => ({
      id: `release-${seq}`, runId: run.id, step: "release", attempt: seq, seq,
      status, kind: "builtin", model: "", effort: "low", costUsd: 0, numTurns: 0,
      structuredOutput: { pushed: false, branches: [{ repo: "web", branch: "nexura/login", sha: "abc", commits, diffStat: "" }] },
    });
    store.saveRun(run);
    store.saveStepRun(release(1, "succeeded", ["1111111 feat: old attempt"]));
    store.saveStepRun(release(2, "succeeded", ["aaaaaaa feat(web): add login", "bbbbbbb fix!: guard empty form", "ccccccc Tidy up"]));
    store.saveStepRun(release(3, "failed", ["ddddddd feat: failed attempt"]));

    const { commits } = store.metrics();
    expect(commits).toMatchObject({ total: 3, runs: 1, prs: 1 });
    expect(commits.byType).toEqual([
      { type: "feat", count: 1 },
      { type: "fix", count: 1 },
      { type: "otros", count: 1 },
    ]);
    expect(commits.recent[0]).toMatchObject({ runId: "run-1", repo: "web", sha: "aaaaaaa", subject: "feat(web): add login", type: "feat" });
    store.close();
  });
});
