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
    expect(metrics.byDay).toMatchObject([{ runs: 3, tokens: 60 }]);
    store.close();
  });
});
