import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const GITHUB_API = "https://api.github.com";

/**
 * `NEXURA_GITHUB_API_URL` points it at the fake GitHub of /try-fake (fixtures/fake-github.mjs).
 * Only a loopback address is accepted: the user's GitHub token goes with every request.
 */
function apiRoot(): string {
  const override = process.env.NEXURA_GITHUB_API_URL?.trim();
  if (!override) {
    return GITHUB_API;
  }
  try {
    const host = new URL(override).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") {
      return override.replace(/\/+$/, "");
    }
  } catch {
    // Not a URL: ignored like any other address.
  }
  return GITHUB_API;
}

const API_ROOT = apiRoot();
const API_VERSION = "2022-11-28";
const TOKEN_TTL_MS = 30 * 60_000;
/** `gh` on PATH, or where its Windows installer puts it. */
const GH_CANDIDATES = ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"];

export class GithubError extends Error {
  public readonly status?: number;

  public constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | undefined;

/**
 * Token from the GitHub CLI session (`gh auth login`), the same one the github MCP server
 * uses; `GH_TOKEN` / `GITHUB_TOKEN` win when set. No PAT stored anywhere.
 */
export async function githubToken(): Promise<string> {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  for (const gh of GH_CANDIDATES) {
    if (gh !== "gh" && !existsSync(gh)) {
      continue;
    }
    try {
      const { stdout } = await execFile(gh, ["auth", "token"], { windowsHide: true });
      const token = stdout.trim();
      if (token) {
        cachedToken = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
        return token;
      }
    } catch {
      // Not on PATH or not logged in: try the next one.
    }
  }
  throw new GithubError("No hay sesión de GitHub CLI. Ejecuta `gh auth login` en una terminal y vuelve a intentarlo.");
}

async function send(url: string, init: { method?: string; body?: unknown }): Promise<Response> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${await githubToken()}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "nexura",
      "x-github-api-version": API_VERSION,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    if (response.status === 401) {
      cachedToken = undefined;
    }
    const detail = await response.text().catch(() => "");
    let message = detail;
    try {
      const parsed = JSON.parse(detail) as { message?: string; errors?: { message?: string }[] };
      message = [parsed.message, ...(parsed.errors ?? []).map((error) => error.message)].filter(Boolean).join(": ") || detail;
    } catch {
      // Not JSON.
    }
    throw new GithubError(`GitHub ${response.status}: ${message.slice(0, 500)}`, response.status);
  }
  return response;
}

/** JSON request against the REST API; `path` is relative to api.github.com, e.g. `repos/o/r/issues/1`. */
export async function githubRequest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return (await (await send(`${API_ROOT}/${path}`, init)).json()) as T;
}

/** GraphQL query or mutation (review threads can only be read with their resolved state, and resolved, through it). */
export async function githubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await send(`${API_ROOT}/graphql`, { method: "POST", body: { query, variables } });
  const { data, errors } = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (errors?.length || !data) {
    throw new GithubError(`GitHub GraphQL: ${(errors ?? []).map((error) => error.message).join("; ").slice(0, 500) || "sin datos"}`);
  }
  return data;
}

/** For tests. */
export function resetGithubTokenCache(): void {
  cachedToken = undefined;
}
