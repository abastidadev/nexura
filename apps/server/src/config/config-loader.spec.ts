import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlowProfile } from "@nexura/shared";
import {
  deleteProfile,
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
