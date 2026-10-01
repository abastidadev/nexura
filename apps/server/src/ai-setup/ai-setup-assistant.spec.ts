import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AiSetupSession, RepoConfig } from "@nexura/shared";

// Env must be set before the modules read their paths.
const root = mkdtempSync(join(tmpdir(), "nexura-ai-setup-"));
const repoPath = join(root, "sandbox");
const toolkitPath = join(root, "toolkit");
const outside = join(root, "outside");
const stateDir = join(root, "state");
process.env.NEXURA_DATA_DIR = join(root, "data");
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures");
process.env.NEXURA_CLAUDE_BIN = join(FIXTURES, "fake-claude.mjs");
process.env.NEXURA_CODEX_BIN = join(FIXTURES, "fake-codex.mjs");
process.env.NEXURA_COPILOT_BIN = join(FIXTURES, "fake-copilot.mjs");
process.env.FAKE_STATE_DIR = stateDir;
process.env.NEXURA_TRUST_WORKTREES = "0";
process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");

const { AiSetupAssistant, AiSetupError } = await import("./ai-setup-assistant.ts");
const { AiSetupStore } = await import("./ai-setup-store.ts");
const { checkSetupPath } = await import("./setup-files.ts");
type Assistant = InstanceType<typeof AiSetupAssistant>;

const repos: RepoConfig[] = [
  { name: "sandbox", path: repoPath, baseBranch: "main", checks: [] },
  { name: "toolkit", path: toolkitPath, baseBranch: "main", checks: [] },
];

function assistant(store = new AiSetupStore(":memory:")): Assistant {
  return new AiSetupAssistant(store, { repos: () => repos, settings: () => ({ memoryEnabled: false }), timeoutMs: 20_000 });
}

/** Resolves when the session stops thinking. */
function settled(setup: Assistant, id: string): Promise<AiSetupSession> {
  return new Promise((resolve) => {
    const check = (message: { type: string; session?: AiSetupSession }): void => {
      if (message.type === "aiSetup" && message.session?.id === id && message.session.status !== "thinking") {
        setup.off("message", check);
        resolve(message.session);
      }
    };
    setup.on("message", check);
  });
}

async function created(setup: Assistant, agent?: "codex"): Promise<AiSetupSession> {
  const session = setup.start({ repo: "sandbox", mode: "create", idea: "Una skill para lanzar los tests", ...(agent ? { agent: { agent, model: "gpt-5.5", effort: "medium" } } : {}) });
  return settled(setup, session.id);
}

function gitRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: path });
}

gitRepo(repoPath, { "CLAUDE.md": "# Sandbox\n", "package.json": '{ "scripts": { "test": "vitest" } }\n', ".claude/agents/explorer.md": "---\nname: explorer\ndescription: Finds code.\n---\n" });
gitRepo(toolkitPath, { ".claude-plugin/marketplace.json": '{ "name": "toolkit", "plugins": [] }\n', "CHANGELOG.md": "# Changelog\n" });
mkdirSync(outside, { recursive: true });

beforeEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  rmSync(join(repoPath, ".claude", "skills"), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkSetupPath", () => {
  it("only lets agent configuration through, relative and inside the repo", () => {
    expect(checkSetupPath(".claude/skills/x/SKILL.md", false)).toBe(".claude/skills/x/SKILL.md");
    expect(checkSetupPath("./src/app/CLAUDE.md", false)).toBe("src/app/CLAUDE.md");
    expect(checkSetupPath(".claude\\agents\\a.md", false)).toBe(".claude/agents/a.md");
    expect(checkSetupPath(".mcp.json", false)).toBe(".mcp.json");
    expect(checkSetupPath(".github/copilot-instructions.md", false)).toBe(".github/copilot-instructions.md");
    for (const bad of ["src/main.ts", "package.json", "../x/CLAUDE.md", ".claude/../src/a.ts", "/etc/CLAUDE.md", "C:/x/CLAUDE.md", ".git/hooks/CLAUDE.md", ".claude//x.md", ""]) {
      expect(() => checkSetupPath(bad, false), bad).toThrow();
    }
  });

  it("a plugin marketplace may also write its plugins, catalogue and changelog", () => {
    expect(() => checkSetupPath("plugins/core/skills/x/SKILL.md", false)).toThrow();
    expect(checkSetupPath("plugins/core/skills/x/SKILL.md", true)).toBe("plugins/core/skills/x/SKILL.md");
    expect(checkSetupPath("CHANGELOG.md", true)).toBe("CHANGELOG.md");
    expect(() => checkSetupPath("scripts/validate.ps1", true)).toThrow();
  });
});

describe("AiSetupAssistant (fake agents)", () => {
  it("assessment: profile, issues and recommendations, with the inventory and the toolkit in the prompt", async () => {
    const setup = assistant();
    const session = setup.start({ repo: "sandbox", mode: "assess", idea: "" });
    const done = await settled(setup, session.id);

    expect(done.status).toBe("idle");
    expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(done.assessment?.profile).toContain("TypeScript");
    expect(done.assessment?.recommendations.map((entry) => entry.kind)).toEqual(["plugin", "skill"]);
    expect(done.assessment?.recommendations[0]).toMatchObject({ scope: "user", command: "claude plugin install core@ai-toolkit" });
    expect(done.assessment?.recommendations.every((entry) => entry.key)).toBe(true);
    expect(done.files).toEqual([]);
  });

  it("create: proposes the files with the version on disk pinned, and an answer completes them", async () => {
    const setup = assistant();
    const first = await created(setup);
    expect(first.status).toBe("idle");
    expect(first.ready).toBe(false);
    expect(first.messages[1]!.questions?.[0]?.options).toEqual(["Solo explicarlos", "Arreglarlos"]);
    expect(first.placement).toMatchObject({ scope: "project" });
    expect(first.files).toHaveLength(1);
    expect(first.files[0]).toMatchObject({ path: ".claude/skills/run-tests/SKILL.md", kind: "skill", baseHash: "" });

    setup.reply(first.id, "Solo explicarlos");
    const answered = await settled(setup, first.id);
    expect(answered.sessionId).toBe(first.sessionId);
    expect(answered.ready).toBe(true);
    expect(answered.files[0]!.key).toBe(first.files[0]!.key);
    expect(answered.files[0]!.content).toContain("## Limits");
  });

  it("writes into the repo only when asked, and then the session is closed", async () => {
    const setup = assistant();
    const session = await created(setup);
    const edited = { files: [{ key: session.files[0]!.key, path: session.files[0]!.path, content: session.files[0]!.content + "\n## Limits\n\n- Edited by hand.\n" }] };

    const done = setup.apply(session.id, edited);

    const written = readFileSync(join(repoPath, ".claude", "skills", "run-tests", "SKILL.md"), "utf8");
    expect(written).toContain("Edited by hand.");
    expect(done.status).toBe("applied");
    expect(done.files[0]!.written).toBe(true);
    expect(() => setup.reply(session.id, "otra cosa")).toThrow("ya están escritos");
  });

  it("never overwrites a file that changed after the assistant read it", async () => {
    const setup = assistant();
    const session = await created(setup);
    mkdirSync(join(repoPath, ".claude", "skills", "run-tests"), { recursive: true });
    writeFileSync(join(repoPath, ".claude", "skills", "run-tests", "SKILL.md"), "someone else's skill\n");

    expect(() => setup.apply(session.id)).toThrow("ya existe");
    expect(readFileSync(join(repoPath, ".claude", "skills", "run-tests", "SKILL.md"), "utf8")).toBe("someone else's skill\n");
  });

  it("refuses paths outside agent configuration, links out of the repo, broken JSON and credentials", async () => {
    const setup = assistant();
    const session = await created(setup);
    const key = session.files[0]!.key;
    const attempt = (path: string, content = "x\n") => () => setup.apply(session.id, { files: [{ key, path, content }] });

    expect(attempt("src/index.ts")).toThrow("solo escribe configuración de agentes");
    expect(attempt("../outside/CLAUDE.md")).toThrow(AiSetupError);
    expect(attempt(".mcp.json", "{ nope")).toThrow("no es JSON válido");
    expect(attempt(".claude/agents/leak.md", "token: ghp_abcdefghijklmnopqrstuvwxyz0123")).toThrow("token de GitHub");

    symlinkSync(outside, join(repoPath, ".claude", "linked"), "dir");
    try {
      expect(attempt(".claude/linked/evil.md")).toThrow("sale del repo");
      expect(existsSync(join(outside, "evil.md"))).toBe(false);
    } finally {
      rmSync(join(repoPath, ".claude", "linked"), { force: true });
    }
    expect(setup.get(session.id).status).toBe("idle");
  });

  it("an edit cannot add files or touch one already written", async () => {
    const setup = assistant();
    const session = await created(setup);
    setup.update(session.id, { files: [{ key: "forged", path: "CLAUDE.md", content: "pwned" }] });
    expect(setup.get(session.id).files.map((file) => file.key)).toEqual([session.files[0]!.key]);
    expect(setup.removeFile(session.id, session.files[0]!.key).files).toEqual([]);
  });

  it("the toolkit repo is told so, and may write its plugins", async () => {
    const setup = assistant();
    expect(setup.repoKinds()).toEqual([
      { name: "sandbox", toolkit: false },
      { name: "toolkit", toolkit: true },
    ]);
    const session = setup.start({ repo: "toolkit", mode: "create", idea: "Una skill de commits", agent: { agent: "codex", model: "gpt-5.5", effort: "medium" } });
    await settled(setup, session.id);
    const call = JSON.parse(readFileSync(join(stateDir, "codex-aiSetup-1.json"), "utf8")) as { prompt: string };
    expect(call.prompt).toContain("es un marketplace de plugins");
    expect(call.prompt).toContain("sube la `version` del `plugin.json`");
  });

  it("the first prompt carries the rules, the inventory, the catalogue and the templates (codex, read-only)", async () => {
    const setup = assistant();
    await created(setup, "codex");
    const call = JSON.parse(readFileSync(join(stateDir, "codex-aiSetup-1.json"), "utf8")) as { args: string[]; prompt: string };
    expect(call.prompt).toContain("Eres el paso **aiSetup**");
    expect(call.prompt).toContain("Una skill para lanzar los tests");
    expect(call.prompt).toContain("`explorer` (project): Finds code.");
    expect(call.prompt).toContain("- .claude/agents/explorer.md");
    expect(call.prompt).toContain("Tambien en espanol");
    expect(call.prompt).toContain("templates/SKILL.md.template");
    expect(call.prompt).toContain("claude-code-setup");
    expect(call.prompt.split("## Notas aprendidas")[0]).not.toContain("(nada)");
    expect(call.args.join(" ")).toContain("read-only");
  });

  it("rejects an unknown repo, an empty create request or an invalid model", () => {
    const setup = assistant();
    expect(() => setup.start({ repo: "ghost", mode: "assess", idea: "" })).toThrow("Repo desconocido");
    expect(() => setup.start({ repo: "sandbox", mode: "create", idea: " " })).toThrow("Cuenta qué quieres crear");
    expect(() => setup.start({ repo: "sandbox", mode: "assess", idea: "", agent: { agent: "claude", model: "--danger", effort: "medium" } })).toThrow("no válido");
  });

  it("a turn cut by a restart ends as an error, not thinking forever", () => {
    const store = new AiSetupStore(":memory:");
    const now = new Date().toISOString();
    store.save({
      id: "s1", repo: "sandbox", mode: "assess", idea: "", agent: { agent: "claude", model: "sonnet", effort: "medium" },
      messages: [], files: [], missing: [], ready: false, status: "thinking", createdAt: now, updatedAt: now,
    });
    expect(assistant(store).get("s1")).toMatchObject({ status: "error", error: expect.stringContaining("reiniciar") });
  });
});
