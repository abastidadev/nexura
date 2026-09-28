import type { RepoConfig, Run, ServerMessage, StepRun } from "@nexura/shared";
import { describe, expect, it } from "vitest";
import { liveAfter, OfficeBridge, officeWorkers, RECENT_MS } from "./office-bridge.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const repos: RepoConfig[] = [{ name: "app", path: "C:/code/app", baseBranch: "main", checks: [] }];

function step(overrides: Partial<StepRun> = {}): StepRun {
  return {
    id: "s1",
    runId: "r1",
    step: "implement",
    attempt: 1,
    seq: 1,
    status: "running",
    kind: "claude",
    agent: "claude",
    model: "opus",
    effort: "medium",
    startedAt: "2026-09-28T11:59:00Z",
    costUsd: 0,
    numTurns: 0,
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    request: { ticketId: "4521", ticketText: "Añadir login con SSO\nDetalles…", repos: ["app"], tasks: [], prompt: "", profile: "standard", stepByStep: false },
    status: "running",
    createdAt: "2026-09-28T11:58:00Z",
    steps: [step()],
    worktrees: [],
    totalCostUsd: 0,
    ...overrides,
  };
}

const options = { repos, nexuraUrl: "http://localhost:4310/", now: NOW };

describe("officeWorkers", () => {
  it("turns a running run into a working worker at the desk of its repo", () => {
    const [worker] = officeWorkers([run()], options);
    expect(worker).toEqual({
      id: "nexura-r1",
      runId: "r1",
      name: "#4521",
      title: "Añadir login con SSO",
      status: "working",
      step: "implement",
      provider: "claude",
      model: "opus",
      activity: undefined,
      tool: undefined,
      repoDirs: ["C:/code/app"],
      pr: undefined,
      url: "http://localhost:4310/runs/r1",
      createdAt: Date.parse("2026-09-28T11:58:00Z"),
      waitingSince: undefined,
    });
  });

  it("shows a paused or rate-limited run waiting on the user, since the moment it started waiting", () => {
    const waitingSince = new Map([["r1", NOW - 5000]]);
    const [paused] = officeWorkers([run({ status: "paused", pendingStep: { step: "release", prDrafts: [] } })], { ...options, waitingSince });
    expect(paused).toMatchObject({ status: "needs_input", activity: "esperando aprobación del PR", waitingSince: NOW - 5000 });
    const [quota] = officeWorkers([run({ status: "waiting-rate-limit" })], options);
    expect(quota).toMatchObject({ status: "needs_input", activity: "esperando cuota", waitingSince: NOW });
  });

  it("keeps finished runs for a while, with their PR, and then lets them go home", () => {
    const done = run({
      status: "done",
      steps: [step({ status: "succeeded", finishedAt: "2026-09-28T11:59:30Z" })],
      pullRequests: [{ repo: "app", id: 77, url: "https://dev.azure.com/o/p/_git/app/pullrequest/77", title: "SSO" }],
    });
    expect(officeWorkers([done], options)[0]).toMatchObject({ status: "done", pr: { number: 77, url: "https://dev.azure.com/o/p/_git/app/pullrequest/77" } });
    expect(officeWorkers([done], { ...options, now: Date.parse("2026-09-28T11:59:30Z") + RECENT_MS + 1 })).toEqual([]);
    expect(officeWorkers([run({ status: "failed", error: "tests rotos" })], options)[0]).toMatchObject({ status: "exited", activity: "falló: tests rotos" });
  });

  it("maps Copilot to the office's custom provider and leaves builtin steps without one", () => {
    expect(officeWorkers([run({ steps: [step({ agent: "copilot" })] })], options)[0]?.provider).toBe("custom");
    expect(officeWorkers([run({ steps: [step({ kind: "builtin", step: "qaCode" })] })], options)[0]).toMatchObject({ provider: undefined, model: undefined });
  });

  it("names runs without a ticket id by their title, and PR reviews by their PR", () => {
    const untitled = run({ request: { ...run().request, ticketId: undefined, ticketText: "Refactor completo del módulo de pagos" } });
    expect(officeWorkers([untitled], options)[0]?.name).toBe("Refactor completo…");
    const review = run({
      request: {
        ...run().request,
        ticketId: undefined,
        kind: "prReview",
        prReview: { id: 9, title: "Fix", author: "a", sourceBranch: "f", targetBranch: "main", isDraft: false, url: "https://github.com/o/r/pull/9", headSha: "x", provider: "github" },
      },
    });
    expect(officeWorkers([review], options)[0]).toMatchObject({ title: "PR #9 · Fix", pr: { number: 9, url: "https://github.com/o/r/pull/9" } });
  });

  it("acts out the live tool only while the run is running that same step", () => {
    const live = new Map([["r1", { stepRunId: "s1", bubble: "Bash npm test", tool: { name: "Bash", command: "npm test" } }]]);
    expect(officeWorkers([run()], { ...options, live })[0]).toMatchObject({ activity: "Bash npm test", tool: { name: "Bash", command: "npm test" } });
    expect(officeWorkers([run({ steps: [step({ id: "s2" })] })], { ...options, live })[0]?.tool).toBeUndefined();
  });
});

describe("liveAfter", () => {
  it("follows the step's own tools and keeps the last one while its result comes back", () => {
    const using = liveAfter(undefined, "s1", { kind: "toolUse", id: "t1", name: "Bash", input: { command: "npm test" }, parentToolUseId: null });
    expect(using).toEqual({ stepRunId: "s1", bubble: "Bash npm test", tool: { name: "Bash", command: "npm test" } });
    const failed = liveAfter(using, "s1", { kind: "toolResult", toolUseId: "t1", isError: true, content: "2 failed", parentToolUseId: null });
    expect(failed).toEqual({ stepRunId: "s1", bubble: "error: 2 failed", tool: { name: "Bash", command: "npm test" } });
  });

  it("ignores subagent tools and events that do not change the activity", () => {
    expect(liveAfter(undefined, "s1", { kind: "toolUse", id: "t2", name: "Read", input: {}, parentToolUseId: "t1" })).toBeUndefined();
    expect(liveAfter(undefined, "s1", { kind: "init", sessionId: "x", model: "opus", tools: [], mcpServers: [] } as never)).toBeUndefined();
  });
});

describe("OfficeBridge", () => {
  function bridge(runs: Run[]) {
    const posts: { url: string; auth: string; body: { workers: { id: string; status: string; activity?: string }[] } }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      posts.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const instance = OfficeBridge.fromEnv(
      { NEXURA_OFFICE_URL: "http://127.0.0.1:4600", NEXURA_OFFICE_TOKEN: "secret" },
      { port: 4310, listRuns: () => runs, repos: () => repos, fetch: fake, now: () => NOW },
    )!;
    return { instance, posts };
  }

  it("is off unless start:all gave it the office URL and token", () => {
    expect(OfficeBridge.fromEnv({}, { port: 4310, listRuns: () => [], repos: () => [] })).toBeUndefined();
    expect(OfficeBridge.fromEnv({ NEXURA_OFFICE_URL: "http://127.0.0.1:4600" }, { port: 4310, listRuns: () => [], repos: () => [] })).toBeUndefined();
  });

  it("posts the snapshot with the shared token, and only again when it changes", async () => {
    const { instance, posts } = bridge([run()]);
    await instance.push(false);
    await instance.push(false);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: "http://127.0.0.1:4600/nexura/workers", auth: "Bearer secret" });
    expect(posts[0]!.body.workers[0]).toMatchObject({ id: "nexura-r1", status: "working", url: "http://localhost:4310/runs/r1" });

    const event: ServerMessage = { type: "event", runId: "r1", stepRunId: "s1", seq: 1, ts: "2026-09-28T11:59:10Z", event: { kind: "toolUse", id: "t1", name: "Edit", input: { file_path: "src/login.ts" }, parentToolUseId: null } };
    instance.onMessage(event);
    instance.stop();
    await instance.push(false);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body.workers[0]).toMatchObject({ activity: "Edit login.ts" });
    await instance.push(true);
    expect(posts).toHaveLength(3);
  });
});
