import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Azure DevOps needs `az`: record the requests instead of sending them.
type Call = { organization: string; path: string; init?: { method?: string; body?: unknown; apiVersion?: string; contentType?: string } };
const calls: Call[] = [];
let routes: [string | RegExp, (call: Call) => unknown][] = [];
vi.mock("../azure/azure-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../azure/azure-client.ts")>()),
  azureRequest: async (organization: string, path: string, init?: Call["init"]) => {
    const call = { organization, path, init };
    calls.push(call);
    const method = init?.method ?? "GET";
    const hit = routes.find(([pattern]) => (typeof pattern === "string" ? `${method} ${path}`.startsWith(pattern) : pattern.test(`${method} ${path}`)));
    return hit ? hit[1](call) : {};
  },
}));

const board = await import("./azure-board.ts");
const { registerOfficeRoutes } = await import("./office-api.ts");

const remote = { organization: "acme", project: "Shop", repository: "web" };
const PULLS = "Shop/_apis/git/repositories/web/pullrequests";
const ME = { authenticatedUser: { id: "u1", providerDisplayName: "Ana Dev", properties: { Account: { $value: "ana@acme.com" } } } };

beforeEach(() => {
  calls.length = 0;
  routes = [];
});

describe("Issues board from work items", () => {
  it("lists open and recently closed items, with the type and tags as labels", async () => {
    routes = [
      [/POST Shop\/_apis\/wit\/wiql/, (call) => ({ workItems: String((call.init?.body as { query: string }).query).includes("NOT IN ('Closed'") ? [{ id: 7 }] : [{ id: 3 }] })],
      [
        "GET _apis/wit/workitems?ids=7,3",
        () => ({
          value: [
            {
              id: 7,
              fields: {
                "System.Title": "Login con SSO",
                "System.State": "Active",
                "System.WorkItemType": "User Story",
                "System.AssignedTo": { displayName: "Ana Dev" },
                "System.CreatedBy": { displayName: "Luis" },
                "System.CreatedDate": "2026-09-01T00:00:00Z",
                "System.ChangedDate": "2026-09-20T00:00:00Z",
                "System.Tags": "frontend; urgente",
                "System.Description": "<p>Entrar con <b>SSO</b></p>",
                "System.CommentCount": 2,
              },
            },
            { id: 3, fields: { "System.Title": "Viejo", "System.State": "Closed", "System.WorkItemType": "Bug" } },
          ],
        }),
      ],
    ];
    const issues = await board.listIssues(remote);
    expect(issues[0]).toMatchObject({
      number: 7,
      title: "Login con SSO",
      state: "OPEN",
      url: "https://dev.azure.com/acme/Shop/_workitems/edit/7",
      author: "Luis",
      assignees: ["Ana Dev"],
      body: "Entrar con **SSO**",
      comments: 2,
    });
    expect(issues[0]!.labels.map((label) => label.name)).toEqual(["User Story", "frontend", "urgente"]);
    expect(issues[0]!.labels[1]!.color).toBe(board.labelColor("frontend"));
    expect(issues[1]).toMatchObject({ number: 3, state: "CLOSED", assignees: [] });
  });

  it("closes an item to its type's completed state, or to Removed when it is not planned", async () => {
    routes = [
      ["GET _apis/wit/workitems/9?fields=System.WorkItemType", () => ({ id: 9, fields: { "System.WorkItemType": "Bug" } })],
      ["GET Shop/_apis/wit/workitemtypes/Bug/states", () => ({ value: [{ name: "New", category: "Proposed" }, { name: "Done", category: "Completed" }, { name: "Removed", category: "Removed" }] })],
    ];
    await board.close(remote, "issue", 9, { comment: "Hecho en el PR 12", reason: "completed" });
    expect(calls.find((call) => call.path.includes("/comments"))?.init).toMatchObject({ method: "POST", body: { text: expect.stringContaining("Hecho en el PR 12") } });
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch).toMatchObject({ path: "_apis/wit/workitems/9", init: { contentType: "application/json-patch+json", body: [{ op: "add", path: "/fields/System.State", value: "Done" }] } });

    calls.length = 0;
    await board.close(remote, "issue", 9, { reason: "not planned" });
    expect(calls.find((call) => call.init?.method === "PATCH")?.init?.body).toEqual([{ op: "add", path: "/fields/System.State", value: "Removed" }]);
  });

  it("edits tags without turning the work item type into one", async () => {
    routes = [
      ["GET _apis/wit/workitems/7?fields=System.Tags", () => ({ id: 7, fields: { "System.Tags": "frontend; urgente", "System.WorkItemType": "User Story" } })],
      ["PATCH _apis/wit/workitems/7", (call) => ({ id: 7, fields: { "System.Tags": ((call.init?.body as { value: string }[])[0]!).value } })],
    ];
    const labels = await board.setLabels(remote, "issue", 7, ["backend", "User Story", "Frontend"], ["urgente"]);
    expect(calls.find((call) => call.init?.method === "PATCH")?.init?.body).toEqual([{ op: "replace", path: "/fields/System.Tags", value: "frontend; backend" }]);
    expect(labels.map((label) => label.name)).toEqual(["User Story", "frontend", "backend"]);
  });

  it("claims an item for the az login account", async () => {
    routes = [["GET _apis/connectionData", () => ME]];
    await board.claim(remote, 7);
    expect(calls.at(-1)).toMatchObject({ path: "_apis/wit/workitems/7", init: { method: "PATCH", body: [{ op: "add", path: "/fields/System.AssignedTo", value: "ana@acme.com" }] } });
  });
});

describe("PR board from pull requests", () => {
  it("lists active, completed and abandoned PRs with GitHub's states and review decision", async () => {
    const pr = (id: number, status: string, extra: object = {}) => ({
      pullRequestId: id,
      title: `PR ${id}`,
      status,
      creationDate: "2026-09-01T00:00:00Z",
      sourceRefName: "refs/heads/feature/x",
      targetRefName: "refs/heads/main",
      ...extra,
    });
    routes = [
      [`GET ${PULLS}?searchCriteria.status=active`, () => ({ value: [pr(1, "active", { description: "Cierra AB#7 y #8", reviewers: [{ vote: 10 }, { vote: 0 }], labels: [{ name: "ux" }] })] })],
      [`GET ${PULLS}?searchCriteria.status=completed`, () => ({ value: [pr(2, "completed", { closedDate: "2026-09-02T00:00:00Z", reviewers: [{ vote: -10 }] })] })],
      [`GET ${PULLS}?searchCriteria.status=abandoned`, () => ({ value: [pr(3, "abandoned")] })],
    ];
    const pulls = await board.listPulls(remote);
    expect(pulls.map((p) => [p.number, p.state, p.reviewDecision])).toEqual([
      [1, "OPEN", "APPROVED"],
      [2, "MERGED", "CHANGES_REQUESTED"],
      [3, "CLOSED", ""],
    ]);
    expect(pulls[0]).toMatchObject({ headRefName: "feature/x", baseRefName: "main", closes: [7, 8], url: "https://dev.azure.com/acme/Shop/_git/web/pullrequest/1" });
    expect(pulls[0]!.labels[0]!.name).toBe("ux");
    expect(pulls[1]!.updatedAt).toBe("2026-09-02T00:00:00Z");
  });

  it("splits a PR's threads into conversation and line comments, with votes and policies", async () => {
    routes = [
      [`GET ${PULLS}/5/threads`, () => ({
        value: [
          { id: 1, comments: [{ id: 1, content: "¿Probado?", author: { displayName: "Luis" }, publishedDate: "t1" }] },
          { id: 2, threadContext: { filePath: "/src/app.ts", rightFileStart: { line: 4 } }, comments: [{ id: 1, content: "Nombre raro" }, { id: 2, parentCommentId: 1, content: "Cambiado" }] },
          { id: 3, comments: [{ id: 1, commentType: "system", content: "Ana voted 10" }] },
        ],
      })],
      [`GET ${PULLS}/5/commits`, () => ({ value: [{}, {}], count: 2 })],
      [`GET ${PULLS}/5`, () => ({
        pullRequestId: 5,
        title: "SSO",
        status: "active",
        creationDate: "x",
        sourceRefName: "refs/heads/sso",
        targetRefName: "refs/heads/main",
        mergeStatus: "succeeded",
        reviewers: [{ displayName: "Ana", vote: 10 }, { displayName: "Bot", vote: 0 }],
        repository: { project: { id: "p1" } },
      })],
      ["GET _apis/connectionData", () => ME],
      ["GET Shop/_apis/policy/evaluations", () => ({ value: [{ status: "running", configuration: { type: { displayName: "Build" } } }] })],
    ];
    const detail = await board.pullDetail(remote, 5);
    expect(detail.comments).toEqual([{ id: "1.1", author: "Luis", body: "¿Probado?", createdAt: "t1", url: "https://dev.azure.com/acme/Shop/_git/web/pullrequest/5?discussionId=1" }]);
    expect(detail.reviewComments.map((c) => [c.id, c.replyTo, c.path, c.line, c.side])).toEqual([
      [2001, undefined, "src/app.ts", 4, "RIGHT"],
      [2002, 2001, "src/app.ts", 4, "RIGHT"],
    ]);
    expect(detail.reviews).toEqual([{ id: "Ana", author: "Ana", body: "", createdAt: "", state: "APPROVED" }]);
    expect(detail).toMatchObject({ commits: 2, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", checks: [{ name: "Build", state: "pending" }], viewer: "Ana Dev" });
    expect(calls.find((call) => call.path.includes("policy"))?.path).toContain(encodeURIComponent("vstfs:///CodeReview/CodeReviewId/p1/5"));
  });

  it("completes a PR with the chosen strategy, or sets auto-complete", async () => {
    routes = [
      [`GET ${PULLS}/5`, () => ({ pullRequestId: 5, lastMergeSourceCommit: { commitId: "abc" } })],
      ["GET _apis/connectionData", () => ME],
    ];
    await board.merge(remote, 5, "squash", true, false);
    expect(calls.at(-1)?.init).toMatchObject({
      method: "PATCH",
      body: { status: "completed", lastMergeSourceCommit: { commitId: "abc" }, completionOptions: { mergeStrategy: "squash", deleteSourceBranch: true } },
    });
    await board.merge(remote, 5, "merge", false, true);
    expect(calls.at(-1)?.init?.body).toEqual({ autoCompleteSetBy: { id: "u1" }, completionOptions: { mergeStrategy: "noFastForward", deleteSourceBranch: false } });
  });

  it("opens a PR from a pushed branch, linking its work item, and finds it again by branch", async () => {
    routes = [
      [`POST ${PULLS}`, () => ({ pullRequestId: 44 })],
      [`GET ${PULLS}?searchCriteria.status=active&searchCriteria.sourceRefName=`, () => ({ value: [{ pullRequestId: 44 }] })],
    ];
    const created = await board.createPull(remote, { branch: "office/sso", base: "main", title: "SSO", body: "Hecho\n\nCo-Authored-By: Claude <x@y>", issue: 7 });
    expect(created).toEqual({ number: 44, url: "https://dev.azure.com/acme/Shop/_git/web/pullrequest/44" });
    expect(calls[0]?.init?.body).toEqual({ sourceRefName: "refs/heads/office/sso", targetRefName: "refs/heads/main", title: "SSO", description: "Hecho", workItemRefs: [{ id: "7" }] });
    expect(await board.findPull(remote, "office/sso")).toEqual(created);
    expect(calls[1]?.path).toContain(encodeURIComponent("refs/heads/office/sso"));
  });
});

describe("office routes", () => {
  const dirs: string[] = [];
  const checkout = (url: string) => {
    const dir = mkdtempSync(join(tmpdir(), "nexura-office-"));
    dirs.push(dir);
    execFileSync("git", ["init", "--quiet", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function api() {
    const table: { method: string; pattern: RegExp; handler: (params: string[], body: unknown, url: URL) => unknown }[] = [];
    registerOfficeRoutes(
      (method, path, handler) => table.push({ method, pattern: new RegExp("^" + path.replace(/:\w+/g, "([^/]+)") + "$"), handler }),
      () => [{ name: "web", path: dirs[0]!, baseBranch: "main", checks: [] }],
    );
    return async (method: string, target: string, body?: unknown) => {
      const url = new URL(target, "http://127.0.0.1");
      for (const route of table) {
        const match = route.method === method ? route.pattern.exec(url.pathname) : null;
        if (match) {
          return route.handler(match.slice(1), body, url);
        }
      }
      throw new Error(`no route: ${method} ${url.pathname}`);
    };
  }

  it("says which provider a floor is on, and only serves boards for Azure DevOps checkouts", async () => {
    const azure = checkout("https://acme@dev.azure.com/acme/Shop/_git/web");
    const github = checkout("https://github.com/o/r.git");
    const call = api();
    expect(await call("GET", `/api/office/board?dir=${encodeURIComponent(azure)}`)).toEqual({ provider: "azure", repo: { nameWithOwner: "Shop/web", methods: ["squash", "merge", "rebase"] } });
    expect(await call("GET", `/api/office/board?dir=${encodeURIComponent(github)}`)).toEqual({ provider: "github" });
    await expect(call("GET", `/api/office/board/issues?dir=${encodeURIComponent(github)}`)).rejects.toThrow("no está en Azure DevOps");
    await expect(call("GET", "/api/office/board/issues?dir=relative")).rejects.toThrow("Carpeta no válida");
    expect(await call("GET", "/api/office/repos")).toEqual([{ name: "web", path: azure, provider: "azure" }]);
  });

  it("comments on a work item from its board, and rejects empty comments and unknown boards", async () => {
    const azure = checkout("https://dev.azure.com/acme/Shop/_git/web");
    routes = [["POST Shop/_apis/wit/workItems/7/comments", () => ({ id: 31, createdBy: { displayName: "Ana Dev" }, createdDate: "t" })]];
    const call = api();
    const dir = encodeURIComponent(azure);
    expect(await call("POST", `/api/office/board/issues/7/comment?dir=${dir}`, { body: "Voy con ello" })).toEqual({
      comment: { id: "31", author: "Ana Dev", body: "Voy con ello", createdAt: "t", url: "https://dev.azure.com/acme/Shop/_workitems/edit/7#31" },
    });
    await expect(call("POST", `/api/office/board/issues/7/comment?dir=${dir}`, { body: " " })).rejects.toThrow("vacío");
    await expect(call("POST", `/api/office/board/boards/7/comment?dir=${dir}`, { body: "x" })).rejects.toThrow("Tablero desconocido");
    await expect(call("POST", `/api/office/board/issues/abc/comment?dir=${dir}`, { body: "x" })).rejects.toThrow("Número no válido");
  });
});

describe("line counts of open PRs", () => {
  it("reads git's shortstat, with or without deletions", () => {
    expect(board.shortstat(" 2 files changed, 12 insertions(+), 1 deletion(-)")).toEqual({ additions: 12, deletions: 1 });
    expect(board.shortstat(" 1 file changed, 3 insertions(+)")).toEqual({ additions: 3, deletions: 0 });
    expect(board.shortstat("")).toEqual({ additions: 0, deletions: 0 });
  });
});
