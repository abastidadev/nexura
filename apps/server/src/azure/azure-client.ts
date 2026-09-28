import { exec as execCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execCallback);

/** Azure DevOps application id: `az` issues AAD tokens for it, the same auth the azure-devops plugin uses. */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";
const TOKEN_MARGIN_MS = 5 * 60_000;

export class AzureError extends Error {
  public readonly status?: number;

  public constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | undefined;

/**
 * A personal access token, only when set: NEXURA_AZURE_PAT, or the file NEXURA_AZURE_PAT_FILE points at
 * (so the secret never goes on a command line). For organizations `az` can't sign in to, such as those
 * of personal Microsoft or GitHub accounts. Nexura never writes it anywhere.
 */
export function azurePat(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.NEXURA_AZURE_PAT?.trim();
  if (direct) {
    return direct;
  }
  const file = env.NEXURA_AZURE_PAT_FILE?.trim();
  if (!file) {
    return undefined;
  }
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    throw new AzureError(`No se pudo leer el PAT de Azure DevOps de ${file} (NEXURA_AZURE_PAT_FILE).`);
  }
}

const basic = (pat: string): string => `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

/** The Authorization header for dev.azure.com: the PAT when there is one, else the `az login` token. */
export async function azureAuthorization(): Promise<string> {
  const pat = azurePat();
  return pat ? basic(pat) : `Bearer ${await azureToken()}`;
}

/**
 * Environment for git commands against dev.azure.com when a PAT is set: the header goes in through
 * GIT_CONFIG_* (git 2.31+), never on the command line. Empty without a PAT (git's own credentials).
 */
export function azureGitEnv(): Record<string, string> {
  const pat = azurePat();
  return pat ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://dev.azure.com/.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${basic(pat)}` } : {};
}

/** Token from the Azure CLI session (`az login`). */
export async function azureToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
    return cachedToken.value;
  }
  try {
    // Fixed command line (no user input), run through the shell so az.cmd resolves on Windows.
    const { stdout } = await exec(`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE} -o json`, { windowsHide: true });
    const token = JSON.parse(stdout) as { accessToken: string; expires_on?: number; expiresOn?: string };
    const expiresAt = token.expires_on ? token.expires_on * 1000 : Date.parse(token.expiresOn ?? "") || Date.now() + 30 * 60_000;
    cachedToken = { value: token.accessToken, expiresAt };
    return token.accessToken;
  } catch {
    throw new AzureError("No hay sesión de Azure CLI. Ejecuta `az login` en una terminal y vuelve a intentarlo (o define NEXURA_AZURE_PAT_FILE con un PAT si tu organización no admite `az`).");
  }
}

/**
 * JSON request against dev.azure.com; `path` is relative to the organisation, e.g. `Schedule/_apis/git/...`.
 * `contentType` for the few endpoints that want another one (creating a work item takes `application/json-patch+json`).
 */
export async function azureRequest<T>(
  organization: string,
  path: string,
  init: { method?: string; body?: unknown; apiVersion?: string; contentType?: string } = {},
): Promise<T> {
  const url = new URL(`https://dev.azure.com/${organization}/${path}`);
  if (!url.searchParams.has("api-version")) {
    url.searchParams.set("api-version", init.apiVersion ?? API_VERSION);
  }
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: await azureAuthorization(),
      "content-type": init.contentType ?? "application/json",
      accept: "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let message = detail;
    try {
      message = (JSON.parse(detail) as { message?: string }).message ?? detail;
    } catch {
      // Not JSON.
    }
    throw new AzureError(`Azure DevOps ${response.status}: ${message.slice(0, 500)}`, response.status);
  }
  // Some calls (deleting a PR label) answer 204 with no body.
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** For tests. */
export function resetAzureTokenCache(): void {
  cachedToken = undefined;
}
