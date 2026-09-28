import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Azure DevOps needs `az`: record the requests instead of sending them.
const azureCalls: { organization: string; path: string; init?: { method?: string; body?: unknown; apiVersion?: string } }[] = [];
const azureRoutes: [RegExp, unknown][] = [];
vi.mock("../azure/azure-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../azure/azure-client.ts")>()),
  azureRequest: async (organization: string, path: string, init?: { method?: string; body?: unknown; apiVersion?: string }) => {
    azureCalls.push({ organization, path, init });
    return azureRoutes.find(([pattern]) => pattern.test(path))?.[1] ?? {};
  },
}));

const { resetGithubTokenCache } = await import("../github/github-client.ts");
const { getPrDetail: getGithubPrDetail, listOpenPrs, postReview } = await import("../github/pull-requests.ts");
const { getPrDetail: getAzurePrDetail, listActivePrs, vote } = await import("../azure/pull-requests.ts");
const { createThread } = await import("../azure/pr-threads.ts");
const { repoRemoteOf } = await import("./remote.ts");

describe("GitHub PR review (fetch stubbed)", () => {
  const remote = { owner: "abastidadev", repo: "nexura" };
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    resetGithubTokenCache();
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init.method ?? "GET", body });
      if (String(url).includes("/pulls?")) {
        return Response.json([
          {
            number: 12,
            title: "Añade saludo",
            body: null,
            user: { login: "ana" },
            head: { ref: "feature/greet", sha: "abc123" },
            base: { ref: "main" },
            draft: true,
            html_url: "https://github.com/abastidadev/nexura/pull/12",
            created_at: "2026-09-20T10:00:00Z",
          },
        ]);
      }
      return Response.json({ id: 1 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GH_TOKEN;
  });

  it("lists the open PRs with their branches and head commit", async () => {
    expect(await listOpenPrs(remote)).toEqual([
      {
        id: 12,
        title: "Añade saludo",
        description: "",
        author: "ana",
        sourceBranch: "feature/greet",
        targetBranch: "main",
        isDraft: true,
        url: "https://github.com/abastidadev/nexura/pull/12",
        createdAt: "2026-09-20T10:00:00Z",
        headSha: "abc123",
      },
    ]);
    expect(calls[0]!.url).toContain("repos/abastidadev/nexura/pulls?state=open");
  });

  it("posts one review on the reviewed commit: anchored comments, the rest in the body, the vote as its event", async () => {
    await postReview(
      remote,
      12,
      "abc123",
      [
        { path: "src/a.ts", startLine: 4, endLine: 6, body: "Validate this" },
        { path: "src/b.ts", startLine: 2, body: "Rename to x" },
        { body: "`src/c.ts:9` Why here?" },
      ],
      "waitingForAuthor",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.github.com/repos/abastidadev/nexura/pulls/12/reviews" });
    expect(calls[0]!.body).toEqual({
      commit_id: "abc123",
      event: "REQUEST_CHANGES",
      body: "`src/c.ts:9` Why here?",
      comments: [
        { path: "src/a.ts", line: 6, side: "RIGHT", start_line: 4, start_side: "RIGHT", body: "Validate this" },
        { path: "src/b.ts", line: 2, side: "RIGHT", body: "Rename to x" },
      ],
    });

    calls.length = 0;
    await postReview(remote, 12, "abc123", [], "approveWithSuggestions");
    expect(calls[0]!.body).toMatchObject({ event: "APPROVE", comments: [] });

    calls.length = 0;
    await postReview(remote, 12, "abc123", []);
    expect(calls).toHaveLength(0);
  });

  it("reads a PR's detail: files, counts, the latest review per reviewer and the issues it closes", async () => {
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      const path = String(url);
      calls.push({ url: path, method: init.method ?? "GET" });
      if (path.endsWith("/graphql")) {
        return Response.json({
          data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 6, title: "Panel", url: "https://github.com/abastidadev/nexura/issues/6" }] } } } },
        });
      }
      if (path.includes("/files")) {
        return Response.json([
          { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
          { filename: "src/b.ts", status: "removed", additions: 0, deletions: 9 },
        ]);
      }
      if (path.includes("/reviews")) {
        return Response.json([
          { user: { login: "luis" }, state: "APPROVED" },
          { user: { login: "luis" }, state: "COMMENTED" },
          { user: { login: "eva" }, state: "CHANGES_REQUESTED" },
        ]);
      }
      return Response.json({ additions: 3, deletions: 10, commits: 2, changed_files: 2, labels: [{ name: "bug" }], requested_reviewers: [{ login: "ana" }] });
    });
    expect(await getGithubPrDetail(remote, 12)).toEqual({
      files: [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
        { path: "src/b.ts", status: "deleted", additions: 0, deletions: 9 },
      ],
      changedFiles: 2,
      additions: 3,
      deletions: 10,
      commits: 2,
      labels: ["bug"],
      reviewers: [
        { name: "luis", state: "approved" },
        { name: "eva", state: "waiting" },
        { name: "ana", state: "pending" },
      ],
      tickets: [{ id: "6", title: "Panel", url: "https://github.com/abastidadev/nexura/issues/6" }],
    });
  });
});

describe("Azure DevOps PR review (requests recorded)", () => {
  const remote = { organization: "org", project: "My Project", repository: "repo" };

  beforeEach(() => {
    azureCalls.length = 0;
    azureRoutes.length = 0;
  });

  it("lists the active PRs with short branch names and the web URL", async () => {
    azureRoutes.push([
      /pullrequests\?/,
      {
        value: [
          {
            pullRequestId: 7635,
            title: "Sign in",
            description: "Adds sign in",
            createdBy: { displayName: "Ana" },
            sourceRefName: "refs/heads/feature/sign-in",
            targetRefName: "refs/heads/develop",
            creationDate: "2026-09-20T10:00:00Z",
            lastMergeSourceCommit: { commitId: "def456" },
          },
        ],
      },
    ]);
    expect(await listActivePrs(remote)).toEqual([
      {
        id: 7635,
        title: "Sign in",
        description: "Adds sign in",
        author: "Ana",
        sourceBranch: "feature/sign-in",
        targetBranch: "develop",
        isDraft: false,
        url: "https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/7635",
        createdAt: "2026-09-20T10:00:00Z",
        headSha: "def456",
      },
    ]);
    expect(azureCalls[0]!.path).toBe("My%20Project/_apis/git/repositories/repo/pullrequests?searchCriteria.status=active&$top=100");
  });

  it("anchors threads on the new file with offsets that are never 0, and PR-level threads without context", async () => {
    await createThread(remote, 7635, { path: "src/app/x.ts", startLine: 42, endLine: 43, startOffset: 5, endOffset: 30, body: "Rename to SharedWithTab" });
    await createThread(remote, 7635, { path: "/src/app/y.ts", startLine: 3, startOffset: 0, endOffset: 0, body: "Why?" });
    await createThread(remote, 7635, { body: "Add the inactive list too" });
    expect(azureCalls.map((call) => call.path)).toEqual(Array(3).fill("My%20Project/_apis/git/repositories/repo/pullRequests/7635/threads"));
    expect(azureCalls[0]!.init).toMatchObject({
      method: "POST",
      body: {
        comments: [{ parentCommentId: 0, content: "Rename to SharedWithTab", commentType: "text" }],
        status: "active",
        threadContext: { filePath: "/src/app/x.ts", rightFileStart: { line: 42, offset: 5 }, rightFileEnd: { line: 43, offset: 30 } },
      },
    });
    expect(azureCalls[1]!.init!.body).toMatchObject({
      threadContext: { filePath: "/src/app/y.ts", rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } },
    });
    expect(azureCalls[2]!.init!.body).not.toHaveProperty("threadContext");
  });

  it("votes as the signed-in identity", async () => {
    azureRoutes.push([/connectionData/, { authenticatedUser: { id: "user-1" } }]);
    await vote(remote, 7635, "approveWithSuggestions");
    expect(azureCalls.map((call) => [call.init?.method ?? "GET", call.path])).toEqual([
      ["GET", "_apis/connectionData"],
      ["PUT", "My%20Project/_apis/git/repositories/repo/pullrequests/7635/reviewers/user-1"],
    ]);
    expect(azureCalls[1]!.init!.body).toEqual({ vote: 5 });
  });

  it("reads a PR's detail: files of the latest iteration, votes and linked work items with their titles", async () => {
    azureRoutes.push(
      [/iterations\/3\/changes/, { changeEntries: [{ changeType: "edit", item: { path: "/src/a.ts" } }, { changeType: "add", item: { path: "/src", isFolder: true } }, { changeType: "edit, rename", item: { path: "/src/b.ts" } }] }],
      [/iterations$/, { value: [{ id: 1 }, { id: 3 }] }],
      [/commits/, { value: [{}, {}], count: 2 }],
      [/pullrequests\/7635\/workitems/, { value: [{ id: "41" }] }],
      [/_apis\/wit\/workitems/, { value: [{ id: 41, fields: { "System.Title": "Sign in" } }] }],
      [/pullrequests\/7635$/, { reviewers: [{ displayName: "Luis", vote: 10 }, { displayName: "Eva", vote: -5 }, { displayName: "Ana", vote: 0 }], labels: [{ name: "auth" }, { name: "old", active: false }] }],
    );
    expect(await getAzurePrDetail(remote, 7635)).toEqual({
      files: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "renamed" },
      ],
      changedFiles: 2,
      commits: 2,
      labels: ["auth"],
      reviewers: [
        { name: "Luis", state: "approved" },
        { name: "Eva", state: "waiting" },
        { name: "Ana", state: "pending" },
      ],
      tickets: [{ id: "41", title: "Sign in", url: "https://dev.azure.com/org/My%20Project/_workitems/edit/41" }],
    });
  });
});

describe("repoRemoteOf", () => {
  const root = mkdtempSync(join(tmpdir(), "nexura-remote-"));
  const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads the configured URL first (a local stand-in) and the resolved one for aliases", async () => {
    const standIn = join(root, "stand-in");
    mkdirSync(standIn);
    git(standIn, "init", "-q");
    git(standIn, "remote", "add", "origin", "https://github.com/nexura-fake/sandbox.git");
    git(standIn, "config", `url.${join(root, "bare.git")}.insteadOf`, "https://github.com/nexura-fake/sandbox.git");
    expect(await repoRemoteOf(standIn)).toEqual({ provider: "github", owner: "nexura-fake", repo: "sandbox" });

    const alias = join(root, "alias");
    mkdirSync(alias);
    git(alias, "init", "-q");
    git(alias, "remote", "add", "origin", "gh:abastidadev/nexura");
    git(alias, "config", "url.https://github.com/.insteadOf", "gh:");
    expect(await repoRemoteOf(alias)).toEqual({ provider: "github", owner: "abastidadev", repo: "nexura" });

    const none = join(root, "none");
    mkdirSync(none);
    git(none, "init", "-q");
    expect(await repoRemoteOf(none)).toBeUndefined();
  });
});
