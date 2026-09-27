import { describe, expect, it, vi } from "vitest";
import type { PullRequestSummary, RepoConfig, Run, RunRequest } from "@nexura/shared";

vi.mock("./remote.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote.ts")>()),
  repoRemoteOf: vi.fn(async (path: string) =>
    path === "/repos/web" ? { provider: "github", owner: "acme", repo: "web" } : path === "/repos/api" ? { provider: "github", owner: "acme", repo: "api" } : undefined,
  ),
}));
vi.mock("./forge.ts", () => ({
  listPullRequests: vi.fn(async ({ repo }: { repo: string }) => {
    if (repo === "api") {
      throw new Error("GitHub respondió 401");
    }
    return [pr(1, "sha-1"), pr(2, "sha-2-new"), pr(3, "sha-3"), pr(4, "sha-4"), pr(5, "sha-5")];
  }),
}));
vi.mock("./tickets.ts", () => ({
  listTickets: vi.fn(async (target: { repo: string }, scope: string) => {
    if (target.repo !== "web") {
      return [];
    }
    const ticket = (id: number, changedDate: string, assignedTo = "") => ({ id, type: "Issue", title: `T${id}`, state: "open", project: "acme/web", assignedTo, iteration: "", changedDate });
    return scope === "mine"
      ? [ticket(10, "2026-09-20", "me")]
      : [ticket(10, "2026-09-20", "me"), ticket(11, "2026-09-25"), ticket(12, "2026-09-26")];
  }),
}));

const { loadInbox } = await import("./inbox.ts");

function pr(id: number, headSha: string): PullRequestSummary {
  return { id, title: `PR ${id}`, description: "", author: "ana", sourceBranch: `b${id}`, targetBranch: "main", isDraft: false, url: "", createdAt: `2026-09-0${id}`, headSha };
}

function run(id: string, status: Run["status"], request: Partial<RunRequest>, extra: Partial<Run> = {}): Run {
  return {
    id,
    request: { ticketText: "", repos: ["web"], tasks: [], prompt: "", profile: "standard", stepByStep: false, ...request },
    status,
    createdAt: "2026-09-27T10:00:00Z",
    steps: [],
    worktrees: [],
    totalCostUsd: 0,
    ...extra,
  };
}

const review = (id: string, prId: number, status: Run["status"], headSha: string, published = false): Run =>
  run(id, status, { kind: "prReview", prReview: { id: prId } as RunRequest["prReview"] }, {
    prReview: { verdict: "approve", summary: "", conventions: [], strengths: [], comments: [], headSha, published: published ? { commentIds: [], at: "" } : undefined },
  });

describe("loadInbox", () => {
  it("classifies other people's PRs by their latest review and links the tickets that a flow took", async () => {
    const repos = [
      { name: "web", path: "/repos/web" },
      { name: "api", path: "/repos/api" },
      { name: "local", path: "/repos/local" },
    ] as RepoConfig[];
    const runs = [
      review("r2-new", 2, "done", "sha-2-old"),
      review("r3", 3, "running", ""),
      review("r4", 4, "done", "sha-4", true),
      review("r1-old", 1, "done", "sha-1"),
      run("own", "done", { ticketId: "10", ticketSource: "github" }, { pullRequests: [{ repo: "web", id: 5, url: "", title: "PR 5" }] }),
    ];

    const inbox = await loadInbox(repos, runs);

    expect(inbox.pullRequests.map((item) => [item.id, item.state, item.reviewRunId])).toEqual([
      [1, "ready", "r1-old"],
      [2, "outdated", "r2-new"],
      [3, "reviewing", "r3"],
      [4, "published", "r4"],
    ]);
    // Unassigned tickets count too (a solo repo rarely assigns issues); the user's own come first.
    expect(inbox.tickets.map((item) => [item.id, item.mine, item.runId, item.runStatus])).toEqual([
      [10, true, "own", "done"],
      [12, false, undefined, undefined],
      [11, false, undefined, undefined],
    ]);
    expect(inbox.errors).toEqual([{ scope: "PRs de api", message: "GitHub respondió 401" }]);
  });
});
