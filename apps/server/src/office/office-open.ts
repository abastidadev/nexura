import { OFFICE_PAGES, type RepoConfig, type ServerMessage } from "@nexura/shared";

export type OpenMessage = Extract<ServerMessage, { type: "open" }>;

function sameDir(a: string, b: string): boolean {
  const norm = (path: string): string => {
    // `b` comes from the office: never probe its filesystem path (especially a Windows UNC path).
    return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}

/**
 * What the 3D office asks Nexura to show (a run, or New flow for an issue), as a page of the
 * UI; undefined when it is not something the office may ask for. The office knows its floor by
 * folder, the form wants the configured repo's name.
 */
export function openTarget(body: unknown, repos: readonly RepoConfig[]): OpenMessage | undefined {
  const request = body as Record<string, unknown> | null;
  if (request?.kind === "run" && typeof request.runId === "string" && /^[\w-]{1,40}$/.test(request.runId)) {
    return { type: "open", path: ["/runs", request.runId] };
  }
  if (request?.kind === "new-run" && typeof request.ticketId === "string" && /^\d{1,12}$/.test(request.ticketId) && (request.source === "azure" || request.source === "github")) {
    const repoDir = typeof request.repoDir === "string" ? request.repoDir : undefined;
    const repo = repoDir ? repos.find((candidate) => sameDir(candidate.path, repoDir))?.name : undefined;
    return { type: "open", path: ["/new"], queryParams: { ticket: request.ticketId, source: request.source, ...(repo ? { repo } : {}) } };
  }
  if (request?.kind === "page" && typeof request.page === "string" && Object.hasOwn(OFFICE_PAGES, request.page)) {
    const repo = typeof request.repo === "string" && repos.some((candidate) => candidate.name === request.repo) ? request.repo : undefined;
    return { type: "open", path: [OFFICE_PAGES[request.page as keyof typeof OFFICE_PAGES]], ...(repo ? { queryParams: { repo } } : {}) };
  }
  return undefined;
}
