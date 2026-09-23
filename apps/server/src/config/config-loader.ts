import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEP_NAMES, type FlowProfile, type RepoConfig, type StepDefinition, type StepName } from "@nexura/shared";
import { CONFIG_DIR } from "./paths.ts";

export type LoadedStep = StepDefinition & {
  promptTemplate?: string;
  schema?: object;
};

export type NexuraConfig = {
  profiles: Map<string, FlowProfile>;
  steps: Map<StepName, LoadedStep>;
  repos: RepoConfig[];
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function loadProfiles(configDir = CONFIG_DIR): Map<string, FlowProfile> {
  const dir = join(configDir, "profiles");
  const profiles = new Map<string, FlowProfile>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const profile = readJson<FlowProfile>(join(dir, file));
    profiles.set(profile.name, profile);
  }
  return profiles;
}

export function loadSteps(configDir = CONFIG_DIR): Map<StepName, LoadedStep> {
  const steps = new Map<StepName, LoadedStep>();
  for (const name of STEP_NAMES) {
    const dir = join(configDir, "steps", name);
    if (!existsSync(join(dir, "step.json"))) {
      continue;
    }
    const definition = readJson<Omit<StepDefinition, "name">>(join(dir, "step.json"));
    const promptFile = join(dir, "prompt.md");
    const schemaFile = join(dir, "schema.json");
    steps.set(name, {
      ...definition,
      name,
      promptTemplate: existsSync(promptFile) ? readFileSync(promptFile, "utf8") : undefined,
      schema: existsSync(schemaFile) ? readJson<object>(schemaFile) : undefined,
    });
  }
  return steps;
}

export function loadRepos(configDir = CONFIG_DIR): RepoConfig[] {
  const file = process.env.NEXURA_REPOS ?? join(configDir, "repos.json");
  if (!existsSync(file)) {
    return [];
  }
  return readJson<{ repos: RepoConfig[] }>(file).repos;
}

export function loadConfig(configDir = CONFIG_DIR): NexuraConfig {
  return { profiles: loadProfiles(configDir), steps: loadSteps(configDir), repos: loadRepos(configDir) };
}

/** Persists an edited prompt template (pillar 2: fix the piece, not the output). */
export function saveStepPrompt(step: StepName, template: string, configDir = CONFIG_DIR): void {
  writeFileSync(join(configDir, "steps", step, "prompt.md"), template);
}

const PROFILE_NAME = /^[a-z0-9-]+$/;
const MODELS = new Set(["haiku", "sonnet", "opus"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const MIN_TIMEOUT_MS = 10_000;

function profileFile(name: string, configDir: string): string {
  if (!PROFILE_NAME.test(name) || name === "auto") {
    throw new Error(`Nombre de perfil no válido: "${name}" (usa a-z, 0-9 y -; "auto" está reservado)`);
  }
  return join(configDir, "profiles", `${name}.json`);
}

export function saveProfile(profile: FlowProfile, configDir = CONFIG_DIR): void {
  const file = profileFile(profile.name, configDir);
  if (!Number.isInteger(profile.maxLoops) || profile.maxLoops < 0) {
    throw new Error("maxLoops debe ser un entero >= 0");
  }
  const steps: FlowProfile["steps"] = {};
  for (const name of STEP_NAMES) {
    const step = profile.steps[name];
    if (!step) {
      continue;
    }
    if (!MODELS.has(step.model) || !EFFORTS.has(step.effort)) {
      throw new Error(`Modelo o esfuerzo no válido en el paso ${name}`);
    }
    steps[name] = { model: step.model, effort: step.effort, enabled: Boolean(step.enabled) };
  }
  if (profile.budgetUsd !== undefined && (!Number.isFinite(profile.budgetUsd) || profile.budgetUsd <= 0)) {
    throw new Error("El presupuesto debe ser un número mayor que 0 (o vacío para no limitar)");
  }
  if (!Object.values(steps).some((step) => step?.enabled)) {
    throw new Error("El perfil necesita al menos un paso activo");
  }
  const clean: FlowProfile = {
    name: profile.name,
    description: profile.description ?? "",
    maxLoops: profile.maxLoops,
    steps,
    ...(profile.budgetUsd !== undefined ? { budgetUsd: profile.budgetUsd } : {}),
  };
  writeFileSync(file, JSON.stringify(clean, null, 2) + "\n");
}

export function deleteProfile(name: string, configDir = CONFIG_DIR): void {
  const file = profileFile(name, configDir);
  if (!existsSync(file)) {
    throw new Error(`No existe el perfil ${name}`);
  }
  if (loadProfiles(configDir).size <= 1) {
    throw new Error("No se puede borrar el último perfil");
  }
  unlinkSync(file);
}

export type StepDefinitionUpdate = Pick<StepDefinition, "tools" | "allowedTools" | "disallowedTools" | "useMcp" | "timeoutMs">;

/** Updates the editable parts of step.json; `kind` never changes from the UI. */
export function saveStepDefinition(step: StepName, update: StepDefinitionUpdate, configDir = CONFIG_DIR): void {
  const file = join(configDir, "steps", step, "step.json");
  if (!existsSync(file)) {
    throw new Error(`No existe el paso ${step}`);
  }
  const current = readJson<Omit<StepDefinition, "name">>(file);
  const list = (values: unknown): string[] =>
    Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [];
  if (!Number.isFinite(update.timeoutMs) || update.timeoutMs < MIN_TIMEOUT_MS) {
    throw new Error(`timeoutMs debe ser >= ${MIN_TIMEOUT_MS}`);
  }
  const next = {
    kind: current.kind,
    tools: list(update.tools),
    allowedTools: list(update.allowedTools),
    disallowedTools: list(update.disallowedTools),
    useMcp: Boolean(update.useMcp),
    timeoutMs: Math.round(update.timeoutMs),
  };
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}

/** Validates that every repo exists and is a git checkout, then writes config/repos.json. */
export function saveRepos(repos: RepoConfig[], configDir = CONFIG_DIR): void {
  const names = new Set<string>();
  const clean = repos.map((repo) => {
    const name = String(repo.name ?? "").trim();
    const path = String(repo.path ?? "").trim();
    if (!/^[\w.-]+$/.test(name)) {
      throw new Error(`Nombre de repo no válido: "${name}"`);
    }
    if (names.has(name)) {
      throw new Error(`Repo duplicado: ${name}`);
    }
    names.add(name);
    if (!existsSync(join(path, ".git"))) {
      throw new Error(`${name}: "${path}" no es un repositorio git`);
    }
    if (!repo.baseBranch?.trim()) {
      throw new Error(`${name}: falta la rama base`);
    }
    const result: RepoConfig = {
      name,
      path,
      baseBranch: repo.baseBranch.trim(),
      checks: (repo.checks ?? []).map((check) => check.trim()).filter(Boolean),
    };
    if (repo.branchPrefix?.trim()) {
      result.branchPrefix = repo.branchPrefix.trim();
    }
    if (repo.nodeModules && repo.nodeModules !== "link") {
      result.nodeModules = repo.nodeModules;
    }
    return result;
  });
  const file = process.env.NEXURA_REPOS ?? join(configDir, "repos.json");
  writeFileSync(file, JSON.stringify({ repos: clean }, null, 2) + "\n");
}
