import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeInventory, resolveMcpServers } from "./claude-inventory.ts";

const root = mkdtempSync(join(tmpdir(), "nexura-inventory-"));
const home = join(root, "claude-home");
const repo = join(root, "repo");
const plugin = join(home, "plugins", "cache", "market", "docs", "1.0.0");

function write(file: string, content: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = home;
  // User level: settings with an enabled plugin, a user MCP server, a skill and a local server for the repo.
  write(join(home, "settings.json"), { enabledPlugins: { "docs@market": true, "off@market": false } });
  write(join(home, ".claude.json"), {
    mcpServers: { shared: { command: "shared-mcp" }, github: { command: "user-github" } },
    projects: { [repo.replace(/\\/g, "/")]: { mcpServers: { secrets: { command: "vault", env: { TOKEN: "x" } } }, enabledMcpjsonServers: ["github"] } },
  });
  write(join(home, "skills", "commit", "SKILL.md"), "---\nname: commit\ndescription: Conventional commits\n---\nbody");
  // Skills are often linked from elsewhere (e.g. ~/.agents/skills).
  write(join(root, "shared-skills", "linked", "SKILL.md"), "---\nname: linked\ndescription: From a link\n---\n");
  symlinkSync(join(root, "shared-skills", "linked"), join(home, "skills", "linked"), "junction");
  write(join(home, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "docs@market": [{ scope: "user", installPath: plugin }],
      "off@market": [{ scope: "user", installPath: join(root, "nowhere") }],
    },
  });
  write(join(plugin, ".mcp.json"), { docs: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] }, "bad name": { command: "x" } });
  write(join(plugin, "skills", "search", "SKILL.md"), "---\nname: search\ndescription: \"Search the docs\"\n---\n");
  write(join(plugin, "agents", "librarian.md"), "---\nname: librarian\ndescription: Finds docs\n---\n");
  // Project level: .mcp.json (github approved, playwright not), a skill and an agent.
  write(join(repo, ".mcp.json"), { mcpServers: { github: { type: "http", url: "https://api.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" } }, playwright: { command: "npx", args: ["@playwright/mcp"] } } });
  write(join(repo, ".claude", "skills", "try-fake", "SKILL.md"), "---\nname: try-fake\ndescription: Runs with fake agents\n---\n");
  write(join(repo, ".claude", "skills", "no-front-matter", "SKILL.md"), "Just text");
  write(join(repo, ".claude", "agents", "reviewer.md"), "---\nname: security-reviewer\ndescription: Reviews security\ntools: Read\n---\n");
});

afterAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("claude inventory of a repo", () => {
  it("lists skills, agents and MCP servers of the project, the user and enabled plugins", () => {
    const inventory = claudeInventory(repo);
    expect(inventory.skills).toEqual([
      { name: "no-front-matter", description: "", source: "project" },
      { name: "try-fake", description: "Runs with fake agents", source: "project" },
      { name: "commit", description: "Conventional commits", source: "user" },
      { name: "linked", description: "From a link", source: "user" },
      { name: "docs:search", description: "Search the docs", source: "plugin:docs" },
    ]);
    expect(inventory.agents).toEqual([
      { name: "security-reviewer", description: "Reviews security", source: "project" },
      { name: "docs:librarian", description: "Finds docs", source: "plugin:docs" },
    ]);
    expect(inventory.mcpServers).toEqual([
      { name: "secrets", source: "local", transport: "stdio", enabled: true },
      { name: "github", source: "project", transport: "http", enabled: true },
      { name: "playwright", source: "project", transport: "stdio", enabled: false },
      { name: "shared", source: "user", transport: "stdio", enabled: true },
      { name: "github", source: "user", transport: "stdio", enabled: true },
      { name: "docs", source: "plugin:docs", transport: "stdio", enabled: true },
      { name: "bad name", source: "plugin:docs", transport: "stdio", enabled: true },
    ]);
  });

  it("resolves a step's servers: '*' takes the enabled ones, names win by precedence, missing ones are reported", () => {
    const all = resolveMcpServers(repo, ["*"], ["secrets"]);
    expect(Object.keys(all.servers)).toEqual(["github", "shared", "docs"]);
    // The project's github shadows the user's one; the plugin root is filled in.
    expect(all.servers["github"]).toEqual({ type: "http", url: "https://api.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" } });
    expect(all.servers["docs"]).toEqual({ command: "node", args: [`${plugin}/server.js`] });

    // A server named explicitly is loaded even if the project has not approved it.
    const named = resolveMcpServers(repo, ["playwright", "nope", "secrets"]);
    expect(named.servers).toEqual({ playwright: { command: "npx", args: ["@playwright/mcp"] }, secrets: { command: "vault", env: { TOKEN: "x" } } });
    expect(named.missing).toEqual(["nope"]);
    expect(resolveMcpServers(repo, [])).toEqual({ servers: {}, missing: [] });
  });

  it("returns empty lists for a folder with no Claude config", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const inventory = claudeInventory(empty);
    expect(inventory.mcpServers.filter((server) => server.source === "project" || server.source === "local")).toEqual([]);
    expect(inventory.skills.filter((skill) => skill.source === "project")).toEqual([]);
  });
});
