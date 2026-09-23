import { exec as execCallback } from "node:child_process";
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

/** Token from the Azure CLI session (`az login`). No PAT stored anywhere. */
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
    throw new AzureError("No hay sesión de Azure CLI. Ejecuta `az login` en una terminal y vuelve a intentarlo.");
  }
}

/** JSON request against dev.azure.com; `path` is relative to the organisation, e.g. `Schedule/_apis/git/...`. */
export async function azureRequest<T>(
  organization: string,
  path: string,
  init: { method?: string; body?: unknown; apiVersion?: string } = {},
): Promise<T> {
  const url = new URL(`https://dev.azure.com/${organization}/${path}`);
  if (!url.searchParams.has("api-version")) {
    url.searchParams.set("api-version", init.apiVersion ?? API_VERSION);
  }
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${await azureToken()}`,
      "content-type": "application/json",
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
  return (await response.json()) as T;
}

/** For tests. */
export function resetAzureTokenCache(): void {
  cachedToken = undefined;
}
