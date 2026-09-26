import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { forgetWorktree, trustWorktree } from "./claude-trust.ts";

const root = mkdtempSync(join(tmpdir(), "nexura-trust-"));
const file = join(root, ".claude.json");
const worktree = "C:\\Dev\\Repo.worktrees\\nexura-ab12cd34";
const read = (): { projects: Record<string, Record<string, unknown>>; other: string } => JSON.parse(readFileSync(file, "utf8"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("claude trust for Nexura worktrees", () => {
  it("trusts only Nexura worktrees, keeps the rest of the file and forgets on cleanup", () => {
    writeFileSync(file, JSON.stringify({ other: "keep", projects: { "C:/Dev/Repo": { hasTrustDialogAccepted: true, lastCost: 1 } } }));

    expect(trustWorktree("C:\\Dev\\Repo", undefined, file)).toBe(false);
    expect(trustWorktree("C:\\Dev\\Repo.worktrees\\something-else", undefined, file)).toBe(false);
    expect(trustWorktree(worktree, undefined, file)).toBe(true);
    expect(trustWorktree(worktree, undefined, file)).toBe(false);

    const config = read();
    expect(config.other).toBe("keep");
    expect(config.projects["C:/Dev/Repo.worktrees/nexura-ab12cd34"]).toEqual({ hasTrustDialogAccepted: true });
    expect(config.projects["C:/Dev/Repo"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 1 });

    forgetWorktree(worktree, file);
    expect(read().projects["C:/Dev/Repo.worktrees/nexura-ab12cd34"]).toBeUndefined();
    expect(read().projects["C:/Dev/Repo"]).toBeDefined();
  });

  it("copies the repo's MCP approvals and local servers, and refreshes them when they change", () => {
    const servers = { db: { command: "node", args: ["db.js"] } };
    writeFileSync(file, JSON.stringify({ projects: { "c:/dev/repo": { enabledMcpjsonServers: ["github"], mcpServers: servers, lastCost: 1 } } }));

    expect(trustWorktree(worktree, "C:\\Dev\\Repo", file)).toBe(true);
    expect(read().projects["C:/Dev/Repo.worktrees/nexura-ab12cd34"]).toEqual({ enabledMcpjsonServers: ["github"], mcpServers: servers, hasTrustDialogAccepted: true });
    expect(trustWorktree(worktree, "C:\\Dev\\Repo", file)).toBe(false);

    const config = read();
    config.projects["c:/dev/repo"]!["enableAllProjectMcpServers"] = true;
    writeFileSync(file, JSON.stringify(config));
    expect(trustWorktree(worktree, "C:\\Dev\\Repo", file)).toBe(true);
    expect(read().projects["C:/Dev/Repo.worktrees/nexura-ab12cd34"]!["enableAllProjectMcpServers"]).toBe(true);
  });

  it("does nothing when the Claude config does not exist or trust is disabled", () => {
    expect(trustWorktree(worktree, undefined, join(root, "missing.json"))).toBe(false);
    process.env.NEXURA_TRUST_WORKTREES = "0";
    try {
      writeFileSync(file, JSON.stringify({ projects: {} }));
      expect(trustWorktree(worktree, undefined, file)).toBe(false);
    } finally {
      delete process.env.NEXURA_TRUST_WORKTREES;
    }
  });
});
