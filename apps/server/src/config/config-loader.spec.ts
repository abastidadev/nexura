import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("updates step.json allowlists but never its kind", () => {
    saveStepDefinition(
      "qaCode",
      { tools: ["Read"], allowedTools: [" Bash(node *) ", ""], disallowedTools: [], useMcp: true, timeoutMs: 60_000 },
      configDir,
    );
    const step = loadSteps(configDir).get("qaCode")!;
    expect(step.kind).toBe("builtin");
    expect(step.allowedTools).toEqual(["Bash(node *)"]);
    expect(() =>
      saveStepDefinition("qaCode", { tools: [], allowedTools: [], disallowedTools: [], useMcp: false, timeoutMs: 5 }, configDir),
    ).toThrow(/timeoutMs/);
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
    saveStepDefinition("qaCode", { tools: [], allowedTools: [], disallowedTools: [], useMcp: false, memory: "read", timeoutMs: 60_000 }, configDir);
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
      "classify", "enrich", "plan", "implement", "audit", "docs", "changelog", "codeReview", "qaCode", "release", "qaNotes", "addressReview",
    ]);

    saveStepDefinition("docs", { tools: ["Read", "Edit"], allowedTools: [], disallowedTools: [], useMcp: false, timeoutMs: 60_000, after: "codeReview" }, configDir);
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
