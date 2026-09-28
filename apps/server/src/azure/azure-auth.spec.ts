import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { azureAuthorization, azureGitEnv, azurePat, azureRequest } from "./azure-client.ts";

const saved = { pat: process.env.NEXURA_AZURE_PAT, file: process.env.NEXURA_AZURE_PAT_FILE };

afterEach(() => {
  for (const [key, value] of [["NEXURA_AZURE_PAT", saved.pat], ["NEXURA_AZURE_PAT_FILE", saved.file]] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
});

describe("Azure DevOps with a personal access token", () => {
  it("takes the PAT from NEXURA_AZURE_PAT, or from the file NEXURA_AZURE_PAT_FILE names", () => {
    expect(azurePat({})).toBeUndefined();
    expect(azurePat({ NEXURA_AZURE_PAT: " abc \n" })).toBe("abc");
    const dir = mkdtempSync(join(tmpdir(), "nexura-pat-"));
    try {
      writeFileSync(join(dir, "pat"), "from-file\r\n");
      expect(azurePat({ NEXURA_AZURE_PAT_FILE: join(dir, "pat") })).toBe("from-file");
      expect(azurePat({ NEXURA_AZURE_PAT: "direct", NEXURA_AZURE_PAT_FILE: join(dir, "pat") })).toBe("direct");
      expect(() => azurePat({ NEXURA_AZURE_PAT_FILE: join(dir, "missing") })).toThrow("NEXURA_AZURE_PAT_FILE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends it as Basic auth to the REST API, instead of asking az", async () => {
    process.env.NEXURA_AZURE_PAT = "secret";
    delete process.env.NEXURA_AZURE_PAT_FILE;
    expect(await azureAuthorization()).toBe(`Basic ${Buffer.from(":secret").toString("base64")}`);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).authorization!);
      return Response.json({ value: [] });
    });
    await azureRequest("acme", "_apis/projects");
    expect(seen).toEqual([`Basic ${Buffer.from(":secret").toString("base64")}`]);
  });

  it("takes an empty 204 answer (deleting a PR label) as no data, not as broken JSON", async () => {
    process.env.NEXURA_AZURE_PAT = "secret";
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    await expect(azureRequest("acme", "Shop/_apis/git/repositories/web/pullRequests/2/labels/ux", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("gives git the header only for dev.azure.com, through the environment", () => {
    delete process.env.NEXURA_AZURE_PAT;
    delete process.env.NEXURA_AZURE_PAT_FILE;
    expect(azureGitEnv()).toEqual({});
    process.env.NEXURA_AZURE_PAT = "secret";
    expect(azureGitEnv()).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://dev.azure.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(":secret").toString("base64")}`,
    });
  });
});
