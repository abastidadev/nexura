import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderSteps, type FlowProfile } from "@nexura/shared";
import {
  createStep,
  deleteProfile,
  deleteStep,
  loadProfiles,
  loadSteps,
  saveProfile,
  saveRepos,
  saveStepDefinition,
} from "./config-loader.ts";

const REAL_CONFIG = join(import.meta.dirname, "..", "..", "..", "..", "config");
const root = mkdtempSync(join(tmpdir(), "nexura-config-"));
const configDir = join(root, "config");

beforeAll(() => {
  cpSync(REAL_CONFIG, configDir, { recursive: true });
  process.env.NEXURA_REPOS = join(configDir, "repos.test.json");
});

afterAll(() => {
  delete process.env.NEXURA_REPOS;
  rmSync(root, { recursive: true, force: true });
});

const profile = (overrides: Partial<FlowProfile> = {}): FlowProfile => ({
  name: "rapido",
  description: "solo implement",
  maxLoops: 0,
  steps: { implement: { model: "sonnet", effort: "low", enabled: true } },
  ...overrides,
});

describe("config editing", () => {
  it("saves, reloads and deletes a profile", () => {
    saveProfile(profile(), configDir);
    expect(loadProfiles(configDir).get("rapido")?.steps.implement?.effort).toBe("low");
    deleteProfile("rapido", configDir);
    expect(loadProfiles(configDir).has("rapido")).toBe(false);
  });

  it("keeps the blind review mode and leaves single-review profiles untouched", () => {
    saveProfile(profile({ reviewMode: "blind" }), configDir);
    expect(loadProfiles(configDir).get("rapido")!.reviewMode).toBe("blind");
    saveProfile(profile({ reviewMode: "single" }), configDir);
    expect(readFileSync(join(configDir, "profiles", "rapido.json"), "utf8")).not.toContain("reviewMode");
    saveProfile(profile(), configDir);
    expect(readFileSync(join(configDir, "profiles", "rapido.json"), "utf8")).not.toContain("reviewMode");
    expect(() => saveProfile(profile({ reviewMode: "triple" as never }), configDir)).toThrow(/Modo de revisión/);
    deleteProfile("rapido", configDir);
  });

  it("rejects unsafe names, the reserved 'auto' and invalid models", () => {
    expect(() => saveProfile(profile({ name: "../x" }), configDir)).toThrow(/no válido/);
    expect(() => saveProfile(profile({ name: "auto" }), configDir)).toThrow(/reservado/);
    expect(() =>
      saveProfile(profile({ steps: { implement: { model: "gpt" as never, effort: "low", enabled: true } } }), configDir),
    ).toThrow(/Modelo/);
    expect(() =>
      saveProfile(profile({ steps: { implement: { model: "haiku", effort: "low", enabled: false } } }), configDir),
    ).toThrow(/al menos un paso/);
  });

  it("saves the agent of each step and judge B, validating models per agent", () => {
    saveProfile(
      profile({
        reviewMode: "blind",
        judgeB: { agent: "copilot", model: "gpt-5", effort: "high" },
        steps: {
          implement: { agent: "codex", model: "gpt-5-codex", effort: "high", enabled: true },
          codeReview: { agent: "claude", model: "claude-opus-4-1", effort: "high", enabled: true },
        },
      }),
      configDir,
    );
    const saved = loadProfiles(configDir).get("rapido")!;
    expect(saved.steps.implement).toEqual({ agent: "codex", model: "gpt-5-codex", effort: "high", enabled: true });
    // Claude is the default: not written, so the file stays as before agents existed.
    expect(saved.steps.codeReview).toEqual({ model: "claude-opus-4-1", effort: "high", enabled: true });
    expect(saved.judgeB).toEqual({ agent: "copilot", model: "gpt-5", effort: "high" });

    const withImplement = (step: object) => profile({ steps: { implement: { effort: "low", enabled: true, ...step } as never } });
    expect(() => saveProfile(withImplement({ agent: "gemini", model: "x" }), configDir)).toThrow(/Agente no válido/);
    expect(() => saveProfile(withImplement({ agent: "claude", model: "gpt-5" }), configDir)).toThrow(/Modelo/);
    // The model is a CLI argument: nothing that could pass for a flag or break the quoting.
    expect(() => saveProfile(withImplement({ agent: "codex", model: "--yolo" }), configDir)).toThrow(/Modelo/);
    expect(() => saveProfile(withImplement({ agent: "codex", model: "gpt 5" }), configDir)).toThrow(/Modelo/);
    expect(() => saveProfile(profile({ judgeB: { agent: "codex", model: "", effort: "low" } }), configDir)).toThrow(/juez B/);
    deleteProfile("rapido", configDir);
  });

  it("updates step.json allowlists but never its kind", () => {
    saveStepDefinition(
      "qaCode",
      { tools: ["Read"], allowedTools: [" Bash(node *) ", ""], disallowedTools: [], mcpServers: ["context7", " context7", "*"], timeoutMs: 60_000 },
      configDir,
    );
    const step = loadSteps(configDir).get("qaCode")!;
    expect(step.kind).toBe("builtin");
    expect(step.allowedTools).toEqual(["Bash(node *)"]);
    expect(step.mcpServers).toEqual(["context7", "*"]);
    expect(() =>
      saveStepDefinition("qaCode", { tools: [], allowedTools: [], disallowedTools: [], mcpServers: ["a,b"], timeoutMs: 60_000 }, configDir),
    ).toThrow(/MCP/);
    expect(() =>
      saveStepDefinition("qaCode", { tools: [], allowedTools: [], disallowedTools: [], mcpServers: [], timeoutMs: 5 }, configDir),
    ).toThrow(/timeoutMs/);
  });

  it("reads the old useMcp flag as every MCP server of the repo (true) or none (false)", () => {
    const file = join(configDir, "steps", "qaNotes", "step.json");
    const original = readFileSync(file, "utf8");
    const { mcpServers: _, ...rest } = JSON.parse(original);
    try {
      writeFileSync(file, JSON.stringify({ ...rest, useMcp: true }));
      expect(loadSteps(configDir).get("qaNotes")).toMatchObject({ mcpServers: ["*"] });
      expect(loadSteps(configDir).get("qaNotes")).not.toHaveProperty("useMcp");
      writeFileSync(file, JSON.stringify({ ...rest, useMcp: false }));
      expect(loadSteps(configDir).get("qaNotes")!.mcpServers).toEqual([]);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("keeps the memory mode of claude steps (builtin steps have none) and rejects unknown modes", () => {
    const plan = loadSteps(configDir).get("plan")!;
    expect(plan.memory).toBe("read");
    saveStepDefinition("plan", { ...plan, memory: "readwrite" }, configDir);
    expect(loadSteps(configDir).get("plan")!.memory).toBe("readwrite");
    // Clients that do not send it keep the current mode.
    saveStepDefinition("plan", { ...plan, memory: undefined }, configDir);
    expect(loadSteps(configDir).get("plan")!.memory).toBe("readwrite");
    expect(() => saveStepDefinition("plan", { ...plan, memory: "all" as never }, configDir)).toThrow(/memoria/);
    saveStepDefinition("qaCode", { tools: [], allowedTools: [], disallowedTools: [], mcpServers: [], memory: "read", timeoutMs: 60_000 }, configDir);
    expect(loadSteps(configDir).get("qaCode")!.memory).toBeUndefined();
  });

  it("creates custom steps after another step, keeps their metadata on save and deletes them from profiles", () => {
    createStep({ name: "docs", label: "Docs", after: "implement" }, configDir);
    createStep({ name: "changelog", after: "docs" }, configDir);
    createStep({ name: "audit", after: "implement" }, configDir);
    expect(() => createStep({ name: "docs", after: "plan" }, configDir)).toThrow(/Ya existe/);
    expect(() => createStep({ name: "implement", after: "plan" }, configDir)).toThrow(/Ya existe/);
    expect(() => createStep({ name: "1bad", after: "plan" }, configDir)).toThrow(/no válido/);
    expect(() => createStep({ name: "orphan", after: "nope" }, configDir)).toThrow(/Después de/);

    const steps = loadSteps(configDir);
    expect(steps.get("docs")).toMatchObject({ kind: "claude", custom: true, label: "Docs", after: "implement", tools: ["Read", "Glob", "Grep"] });
    expect(steps.get("docs")!.promptTemplate).toContain("paso **docs**");
    expect(orderSteps(steps.values()).map((step) => step.name)).toEqual([
      "classify", "enrich", "plan", "implement", "audit", "docs", "changelog", "codeReview", "qaCode", "release", "qaNotes", "addressReview", "prReview",
    ]);

    saveStepDefinition("docs", { tools: ["Read", "Edit"], allowedTools: [], disallowedTools: [], mcpServers: [], timeoutMs: 60_000, after: "codeReview" }, configDir);
    expect(loadSteps(configDir).get("docs")).toMatchObject({ custom: true, label: "Docs", after: "codeReview", tools: ["Read", "Edit"] });

    saveProfile(profile({ steps: { implement: { model: "sonnet", effort: "low", enabled: true }, audit: { model: "haiku", effort: "low", enabled: true } } }), configDir);
    expect(() => deleteStep("implement", configDir)).toThrow(/no se puede borrar/);
    expect(() => deleteStep("docs", configDir)).toThrow(/changelog/);
    deleteStep("audit", configDir);
    expect(loadSteps(configDir).has("audit")).toBe(false);
    expect(loadProfiles(configDir).get("rapido")!.steps).not.toHaveProperty("audit");
    deleteStep("changelog", configDir);
    deleteStep("docs", configDir);
    deleteProfile("rapido", configDir);
  });

  it("only accepts repos that are git checkouts", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    saveRepos([{ name: "demo", path: repo, baseBranch: "main", checks: ["npm run lint", " "], nodeModules: "link" }], configDir);
    const saved = JSON.parse(readFileSync(process.env.NEXURA_REPOS!, "utf8"));
    expect(saved.repos).toEqual([{ name: "demo", path: repo, baseBranch: "main", checks: ["npm run lint"] }]);
    expect(() => saveRepos([{ name: "nope", path: join(root, "missing"), baseBranch: "main", checks: [] }], configDir)).toThrow(
      /no es un repositorio git/,
    );
    expect(existsSync(process.env.NEXURA_REPOS!)).toBe(true);
  });
});
