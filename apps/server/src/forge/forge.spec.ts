import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedPr, Worktree } from "@nexura/shared";
import { resetGithubTokenCache } from "../github/github-client.ts";
import { getIssue, listOpenIssues } from "../github/issues.ts";
import { getActiveThreads, getPrStatus, prBody, replyToThread } from "../github/pull-requests.ts";
import { parseGithubRemote, parseOwnerRepo } from "../github/repo-remote.ts";
import { parseRemote } from "./remote.ts";
import { ticketTarget, ticketToText } from "./tickets.ts";

describe("parseRemote", () => {
  it("tells Azure DevOps and GitHub remotes apart", () => {
    expect(parseRemote("https://ags-devops@dev.azure.com/ags-devops/Schedule/_git/Lib")).toEqual({
      provider: "azure",
      organization: "ags-devops",
      project: "Schedule",
      repository: "Lib",
    });
    expect(parseRemote("git@github.com:abastidadev/nexura.git")).toEqual({ provider: "github", owner: "abastidadev", repo: "nexura" });
    expect(parseRemote("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });

  it("understands the https, scp-like and ssh GitHub forms", () => {
    const expected = { owner: "abastidadev", repo: "nexura" };
    expect(parseGithubRemote("https://github.com/abastidadev/nexura.git")).toEqual(expected);
    expect(parseGithubRemote("https://user@github.com/abastidadev/nexura")).toEqual(expected);
    expect(parseGithubRemote("ssh://git@github.com/abastidadev/nexura.git\n")).toEqual(expected);
    expect(parseGithubRemote("https://github.com/o/my.repo.js.git")).toEqual({ owner: "o", repo: "my.repo.js" });
    expect(parseGithubRemote("https://dev.azure.com/org/p/_git/r")).toBeUndefined();
    expect(parseOwnerRepo(" abastidadev/nexura ")).toEqual(expected);
    expect(parseOwnerRepo("nexura")).toBeUndefined();
  });
});

describe("ticketTarget", () => {
  afterEach(() => {
    delete process.env.NEXURA_GITHUB_REPO;
  });

  it("falls back to NEXURA_GITHUB_REPO and otherwise says what is missing", async () => {
    await expect(ticketTarget("github", [], null)).rejects.toThrow("Ningún repo tiene un remote origin de GitHub (o define NEXURA_GITHUB_REPO)");
    process.env.NEXURA_GITHUB_REPO = "abastidadev/nexura";
    expect(await ticketTarget("github", [], null)).toEqual({ source: "github", owner: "abastidadev", repo: "nexura" });
  });
});

describe("prBody", () => {
  it("adds the closing keyword after the approved description and drops attribution", () => {
    expect(prBody({ description: "Arregla el mapa\n\nCo-Authored-By: Claude <noreply@anthropic.com>", workItemId: 12 })).toBe(
      "Arregla el mapa\n\nCloses #12",
    );
    expect(prBody({ description: "X", workItemId: 3, workItemProject: "abastidadev/backlog" })).toBe("X\n\nCloses abastidadev/backlog#3");
    expect(prBody({ description: "Sin ticket" })).toBe("Sin ticket");
  });
});

describe("ticketToText", () => {
  it("puts the title on the first line and only the sections that exist", () => {
    const text = ticketToText({
      source: "azure",
      id: 1,
      type: "Bug",
      title: "Mapa no carga",
      state: "Active",
      project: "Schedule",
      url: "",
      description: "",
      acceptanceCriteria: "",
      reproSteps: "1. Abrir mapa",
      comments: [{ author: "Ana", date: "2026-09-01T10:00:00Z", text: "Pasa en Chrome" }],
      children: [],
    });
    expect(text.split("\n")[0]).toBe("Mapa no carga");
    expect(text).toContain("## Pasos para reproducir\n1. Abrir mapa");
    expect(text).toContain("- Ana (2026-09-01): Pasa en Chrome");
    expect(text).not.toContain("Descripción");
    expect(text).not.toContain("Etiquetas");
  });

  it("lists GitHub labels", () => {
    const text = ticketToText({
      source: "github",
      id: 7,
      type: "Issue",
      title: "Soportar GitHub",
      state: "open",
      project: "abastidadev/nexura",
      url: "",
      description: "Cuerpo en **markdown**",
      acceptanceCriteria: "",
      reproSteps: "",
      comments: [],
      children: [],
      labels: ["enhancement", "gentle-ai"],
    });
    expect(text).toBe("Soportar GitHub\n\nIssue · open · abastidadev/nexura\n\nEtiquetas: enhancement, gentle-ai\n\n## Descripción\nCuerpo en **markdown**");
  });
});

describe("GitHub REST/GraphQL (fetch stubbed)", () => {
  const remote = { owner: "abastidadev", repo: "nexura" };
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let routes: [RegExp, unknown][] = [];

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    resetGithubTokenCache();
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init.method ?? "GET", body });
      const key = String(url).endsWith("/graphql") ? `graphql:${(body as { query: string }).query.trim().split(/\s/)[0]}` : String(url);
      const route = routes.find(([pattern]) => pattern.test(key));
      if (!route) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(JSON.stringify(route[1]), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GH_TOKEN;
  });

  it("loads an issue with its latest comments and sub-issues, and refuses pull requests", async () => {
    routes = [
      [/issues\/7$/, { number: 7, title: "Soportar GitHub", state: "open", body: "Cuerpo", html_url: "https://github.com/abastidadev/nexura/issues/7", updated_at: "", comments: 1, labels: [{ name: "enhancement" }], type: { name: "Feature" } }],
      [/issues\/7\/comments/, [{ body: " Hecho a medias ", created_at: "2026-09-20T10:00:00Z", user: { login: "ana" } }]],
      [/issues\/7\/sub_issues/, [{ number: 8, title: "Parte 1", state: "closed", labels: [] }, { number: 9, title: "Parte 2", state: "open", labels: [] }]],
      [/issues\/5$/, { number: 5, title: "PR", state: "open", html_url: "", updated_at: "", comments: 0, labels: [], pull_request: {} }],
    ];
    const ticket = await getIssue(remote, 7);
    expect(ticket).toMatchObject({
      source: "github",
      id: 7,
      type: "Feature",
      project: "abastidadev/nexura",
      description: "Cuerpo",
      labels: ["enhancement"],
      comments: [{ author: "ana", text: "Hecho a medias" }],
      children: [
        { id: 8, title: "Parte 1", done: true },
        { id: 9, title: "Parte 2", done: false },
      ],
    });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/abastidadev/nexura/issues/7");
    await expect(getIssue(remote, 5)).rejects.toMatchObject({ status: 400 });
  });

  it("lists my open issues without the pull requests", async () => {
    routes = [
      [/\/user$/, { login: "abastidadev" }],
      [/\/issues\?/, [
        { number: 1, title: "Uno", state: "open", html_url: "", updated_at: "2026-09-01", comments: 0, labels: ["bug"], assignees: [{ login: "abastidadev" }], milestone: { title: "v1" } },
        { number: 2, title: "Una PR", state: "open", html_url: "", updated_at: "", comments: 0, labels: [], pull_request: {} },
      ]],
    ];
    const issues = await listOpenIssues(remote, "mine");
    expect(issues).toEqual([
      { id: 1, type: "Issue", title: "Uno", state: "open", project: "abastidadev/nexura", assignedTo: "abastidadev", iteration: "v1", changedDate: "2026-09-01", labels: ["bug"] },
    ]);
    expect(calls.at(-1)!.url).toContain("assignee=abastidadev");
  });

  it("maps PR status, reads unresolved threads and resolves them after replying", async () => {
    const threads = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { id: "T1", isResolved: false, path: "src/a.ts", line: 4, comments: { nodes: [{ databaseId: 101, body: "Falta validar", author: { login: "ana" } }] } },
              { id: "T2", isResolved: true, path: "src/b.ts", line: 1, comments: { nodes: [{ databaseId: 102, body: "ok", author: { login: "ana" } }] } },
            ],
          },
        },
      },
    };
    routes = [
      [/pulls\/3$/, { state: "closed", merged: true }],
      [/^graphql:query/, { data: threads }],
      [/^graphql:mutation/, { data: { resolveReviewThread: { thread: { id: "T1" } } } }],
      [/pulls\/3\/comments\/101\/replies$/, { id: 1 }],
    ];
    expect(await getPrStatus(remote, 3)).toBe("completed");

    const worktree = { repo: "nexura" } as Worktree;
    const pr: CreatedPr = { repo: "nexura", id: 3, url: "", title: "" };
    expect(await getActiveThreads(remote, worktree, pr)).toEqual([
      { repo: "nexura", prId: 3, threadId: 101, filePath: "src/a.ts", line: 4, comments: [{ author: "ana", content: "Falta validar" }] },
    ]);

    calls.length = 0;
    await replyToThread(remote, 3, { repo: "nexura", threadId: 101, reply: "Validado", action: "answered" });
    expect(calls.map((call) => call.method + " " + call.url)).toEqual(["POST https://api.github.com/repos/abastidadev/nexura/pulls/3/comments/101/replies"]);

    calls.length = 0;
    await replyToThread(remote, 3, { repo: "nexura", threadId: 101, reply: "Arreglado", action: "fixed" });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body).toMatchObject({ variables: { threadId: "T1" } });
  });
});
