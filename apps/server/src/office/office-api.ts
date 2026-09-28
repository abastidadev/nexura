import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RepoConfig } from "@nexura/shared";
import type { AzureRepo } from "../azure/repo-remote.ts";
import { repoRemoteOf } from "../forge/remote.ts";
import * as board from "./azure-board.ts";

type Handler = (params: string[], body: unknown, url: URL) => unknown;
type Route = (method: string, path: string, handler: Handler) => void;

/** An error the office can show as is, with the HTTP status it deserves. */
export class OfficeApiError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A floor of the office is a local checkout: its `dir` says which repo (and remote) a call is about. */
async function remoteOf(url: URL): Promise<{ dir: string; remote: AzureRepo }> {
  const dir = url.searchParams.get("dir") ?? "";
  if (!isAbsolute(dir) || !existsSync(dir)) {
    throw new OfficeApiError(400, `Carpeta no válida: ${dir}`);
  }
  const remote = await repoRemoteOf(dir);
  if (remote?.provider !== "azure") {
    throw new OfficeApiError(400, "Este proyecto no está en Azure DevOps");
  }
  return { dir, remote };
}

function number(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new OfficeApiError(400, `Número no válido: ${value}`);
  }
  return n;
}

function kindOf(value: string | undefined): "issue" | "pull" {
  if (value === "issues") {
    return "issue";
  }
  if (value === "pulls") {
    return "pull";
  }
  throw new OfficeApiError(404, `Tablero desconocido: ${value}`);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.trim().length > 0).map((name) => name.trim().slice(0, 100)) : [];
}

/**
 * What the 3D office asks Nexura for (third_party/agent-office/src/server/nexura/): the boards of
 * floors whose repo lives on Azure DevOps, and the repos Nexura knows, to open as floors.
 */
export function registerOfficeRoutes(route: Route, repos: () => RepoConfig[]): void {
  route("GET", "/api/office/board", async (_params, _body, url) => {
    const dir = url.searchParams.get("dir") ?? "";
    const remote = isAbsolute(dir) && existsSync(dir) ? await repoRemoteOf(dir) : undefined;
    if (remote?.provider !== "azure") {
      return { provider: remote?.provider ?? null };
    }
    return { provider: "azure", repo: board.repoInfo(remote) };
  });
  route("GET", "/api/office/board/issues", async (_params, _body, url) => board.listIssues((await remoteOf(url)).remote));
  route("GET", "/api/office/board/pulls", async (_params, _body, url) => {
    const { dir, remote } = await remoteOf(url);
    return board.listPulls(remote, dir);
  });
  route("GET", "/api/office/board/labels", async (_params, _body, url) => board.repoLabels((await remoteOf(url)).remote));
  route("GET", "/api/office/board/viewer", async (_params, _body, url) => ({ name: (await board.viewer((await remoteOf(url)).remote)).name }));
  route("GET", "/api/office/board/pull-by-branch", async (_params, _body, url) => {
    const branch = url.searchParams.get("branch") ?? "";
    if (!branch) {
      throw new OfficeApiError(400, "Falta la rama");
    }
    return { pull: (await board.findPull((await remoteOf(url)).remote, branch)) ?? null };
  });
  route("POST", "/api/office/board/pulls", async (_params, body, url) => {
    const input = (body ?? {}) as Record<string, unknown>;
    const branch = text(input.branch, 250);
    const base = text(input.base, 250);
    const title = text(input.title, 400).trim();
    if (!branch || !base || !title) {
      throw new OfficeApiError(400, "Faltan la rama, la rama destino o el título");
    }
    const issue = typeof input.issue === "number" && Number.isInteger(input.issue) && input.issue > 0 ? input.issue : undefined;
    return board.createPull((await remoteOf(url)).remote, { branch, base, title, body: text(input.body, 20_000), issue });
  });
  route("GET", "/api/office/board/issues/:n", async ([n], _body, url) => board.issueDetail((await remoteOf(url)).remote, number(n)));
  route("GET", "/api/office/board/pulls/:n", async ([n], _body, url) => board.pullDetail((await remoteOf(url)).remote, number(n)));
  route("GET", "/api/office/board/pulls/:n/diff", async ([n], _body, url) => {
    const { dir, remote } = await remoteOf(url);
    return { diff: await board.pullDiff(remote, dir, number(n)) };
  });
  route("POST", "/api/office/board/:kind/:n/comment", async ([kind, n], body, url) => {
    const text_ = text((body as { body?: unknown })?.body, 60_000);
    if (!text_.trim()) {
      throw new OfficeApiError(400, "El comentario está vacío");
    }
    return { comment: await board.comment((await remoteOf(url)).remote, kindOf(kind), number(n), text_) };
  });
  route("POST", "/api/office/board/:kind/:n/close", async ([kind, n], body, url) => {
    const input = (body ?? {}) as Record<string, unknown>;
    await board.close((await remoteOf(url)).remote, kindOf(kind), number(n), {
      comment: text(input.comment, 60_000) || undefined,
      reason: input.reason === "not planned" ? "not planned" : "completed",
      deleteBranch: input.deleteBranch === true,
    });
    return { ok: true };
  });
  route("POST", "/api/office/board/:kind/:n/labels", async ([kind, n], body, url) => {
    const input = (body ?? {}) as Record<string, unknown>;
    return { labels: await board.setLabels((await remoteOf(url)).remote, kindOf(kind), number(n), names(input.add), names(input.remove)) };
  });
  route("POST", "/api/office/board/pulls/:n/merge", async ([n], body, url) => {
    const input = (body ?? {}) as Record<string, unknown>;
    const method = input.method === "merge" || input.method === "rebase" ? input.method : "squash";
    await board.merge((await remoteOf(url)).remote, number(n), method, input.deleteBranch === true, input.auto === true);
    return { ok: true };
  });
  route("POST", "/api/office/board/pulls/:n/review", async ([n], body, url) => {
    const text_ = text((body as { body?: unknown })?.body, 150_000);
    if (!text_.trim()) {
      throw new OfficeApiError(400, "La revisión está vacía");
    }
    return { url: await board.review((await remoteOf(url)).remote, number(n), text_) };
  });
  route("POST", "/api/office/board/issues/:n/claim", async ([n], _body, url) => {
    await board.claim((await remoteOf(url)).remote, number(n));
    return { ok: true };
  });

  // The repos Nexura works on, so the office's elevator can open them as floors (they're already cloned).
  route("GET", "/api/office/repos", async () =>
    Promise.all(
      repos().map(async (repo) => {
        const remote = existsSync(repo.path) ? await repoRemoteOf(repo.path) : undefined;
        return { name: repo.name, path: repo.path, provider: remote?.provider ?? null };
      }),
    ),
  );
}
