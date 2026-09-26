import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_KINDS, agentOf, CUSTOM_STEP_NAME, MEMORY_MODES, STEP_NAMES, type AgentKind, type FlowProfile, type JudgeConfig, type RepoConfig, type StepDefinition, type StepName } from "@nexura/shared";
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

/** Built-in steps first, then every other folder of config/steps (the custom ones). */
export function loadSteps(configDir = CONFIG_DIR): Map<StepName, LoadedStep> {
  const steps = new Map<StepName, LoadedStep>();
  const stepsDir = join(configDir, "steps");
  const folders = existsSync(stepsDir) ? readdirSync(stepsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const names = [...STEP_NAMES, ...folders.filter((name) => !(STEP_NAMES as readonly string[]).includes(name)).sort()];
  for (const name of names) {
    const dir = join(stepsDir, name);
    if (!existsSync(join(dir, "step.json"))) {
      continue;
    }
    const { useMcp, ...definition } = readJson<Omit<StepDefinition, "name"> & { useMcp?: boolean }>(join(dir, "step.json"));
    const promptFile = join(dir, "prompt.md");
    const schemaFile = join(dir, "schema.json");
    steps.set(name, {
      ...definition,
      // Before mcpServers, `useMcp: true` loaded every MCP server of the repo.
      mcpServers: definition.mcpServers ?? (useMcp ? ["*"] : []),
      name,
      // CRLF from a Windows checkout (core.autocrlf) is noise in a prompt.
      promptTemplate: existsSync(promptFile) ? readFileSync(promptFile, "utf8").replace(/\r\n/g, "\n") : undefined,
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
const CLAUDE_MODELS = new Set(["haiku", "sonnet", "opus"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
/** A model id goes to the CLI as an argument: no leading dash, no spaces or quotes. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/;

/** Whether a model id is acceptable for the agent (Claude: an alias or a full `claude-*` id). */
export function isValidModel(agent: AgentKind, model: unknown): model is string {
  return typeof model === "string" && MODEL_ID.test(model) && (agent !== "claude" || CLAUDE_MODELS.has(model) || model.startsWith("claude-"));
}

/** Validates the agent/model/effort of a step or judge; returns the agent (missing = claude). */
function checkAgentModel(config: { agent?: AgentKind; model: string; effort: string }, where: string): AgentKind {
  const agent = agentOf(config);
  if (!AGENT_KINDS.includes(agent)) {
    throw new Error(`Agente no válido en ${where}: ${agent}`);
  }
  if (!isValidModel(agent, config.model) || !EFFORTS.has(config.effort)) {
    throw new Error(`Modelo o esfuerzo no válido en ${where}`);
  }
  return agent;
}
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
  for (const name of loadSteps(configDir).keys()) {
    const step = profile.steps[name];
    if (!step) {
      continue;
    }
    const agent = checkAgentModel(step, `el paso ${name}`);
    steps[name] = { ...(agent !== "claude" ? { agent } : {}), model: step.model, effort: step.effort, enabled: Boolean(step.enabled) };
  }
  let judgeB: JudgeConfig | undefined;
  if (profile.judgeB) {
    const agent = checkAgentModel(profile.judgeB, "el juez B");
    judgeB = { agent, model: profile.judgeB.model, effort: profile.judgeB.effort };
  }
  if (profile.budgetUsd !== undefined && (!Number.isFinite(profile.budgetUsd) || profile.budgetUsd <= 0)) {
    throw new Error("El presupuesto debe ser un número mayor que 0 (o vacío para no limitar)");
  }
  if (profile.reviewMode !== undefined && profile.reviewMode !== "single" && profile.reviewMode !== "blind") {
    throw new Error("Modo de revisión no válido: usa single o blind");
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
    ...(profile.reviewMode === "blind" ? { reviewMode: "blind" as const } : {}),
    ...(judgeB ? { judgeB } : {}),
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

export type StepDefinitionUpdate = Pick<StepDefinition, "tools" | "allowedTools" | "disallowedTools" | "mcpServers" | "timeoutMs"> &
  Partial<Pick<StepDefinition, "memory" | "label" | "description" | "after">>;

const list = (values: unknown): string[] => (Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : []);

/** Label/description/after of a custom step, validated against the steps that exist. */
function customMetadata(name: string, update: Partial<StepDefinition>, configDir: string): Pick<StepDefinition, "custom" | "label" | "description" | "after"> {
  const after = String(update.after ?? "").trim();
  const others = [...loadSteps(configDir).keys()].filter((step) => step !== name && step !== "classify" && step !== "addressReview");
  if (!others.includes(after)) {
    throw new Error(`"Después de" tiene que ser uno de los pasos del flujo (${others.join(", ")})`);
  }
  return { custom: true, label: String(update.label ?? "").trim() || name, description: String(update.description ?? "").trim(), after };
}

/** Updates the editable parts of step.json; `kind` never changes from the UI. */
export function saveStepDefinition(step: StepName, update: StepDefinitionUpdate, configDir = CONFIG_DIR): void {
  const file = join(configDir, "steps", step, "step.json");
  if (!existsSync(file)) {
    throw new Error(`No existe el paso ${step}`);
  }
  const current = readJson<Omit<StepDefinition, "name">>(file);
  if (!Number.isFinite(update.timeoutMs) || update.timeoutMs < MIN_TIMEOUT_MS) {
    throw new Error(`timeoutMs debe ser >= ${MIN_TIMEOUT_MS}`);
  }
  const mcpServers = [...new Set(list(update.mcpServers))];
  // Names end up in `--allowedTools mcp__<name>` (comma separated) and in Codex's TOML keys.
  const invalid = mcpServers.filter((name) => name !== "*" && !/^[\w-]+$/.test(name));
  if (invalid.length) {
    throw new Error(`Nombre de servidor MCP no válido: ${invalid.join(", ")} (letras, números, _ o -)`);
  }
  const next = {
    kind: current.kind,
    ...(current.custom ? customMetadata(step, { ...current, ...update }, configDir) : {}),
    tools: list(update.tools),
    allowedTools: list(update.allowedTools),
    disallowedTools: list(update.disallowedTools),
    mcpServers,
    ...(current.kind === "claude" ? { memory: memoryMode(update.memory ?? current.memory) } : {}),
    timeoutMs: Math.round(update.timeoutMs),
  };
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}

function memoryMode(value: unknown): NonNullable<StepDefinition["memory"]> {
  if (value === undefined) {
    return "off";
  }
  if (!MEMORY_MODES.includes(value as NonNullable<StepDefinition["memory"]>)) {
    throw new Error(`Modo de memoria no válido: "${String(value)}" (${MEMORY_MODES.join(", ")})`);
  }
  return value as NonNullable<StepDefinition["memory"]>;
}

export type NewStep = { name: string; label?: string; description?: string; after: StepName };

const DEFAULT_CUSTOM_PROMPT = `Eres el paso **{{name}}** de un flujo que resuelve un ticket en los worktrees indicados.

(Describe aquí qué tiene que hacer este paso y qué debe devolver.)

## Ticket
{{ticket}}

## Repos
{{repos}}

## Libro de tareas (lo que han hecho los pasos anteriores)
{{ledger}}

## Indicaciones del usuario
{{userPrompt}}
`;

/**
 * Creates config/steps/<name>/ for a custom claude step: read-only tools by default,
 * no schema (its answer is the final text, available to later steps as {{output.<name>}}).
 */
export function createStep(step: NewStep, configDir = CONFIG_DIR): void {
  const name = String(step.name ?? "").trim();
  if (!CUSTOM_STEP_NAME.test(name)) {
    throw new Error(`Nombre de paso no válido: "${name}" (letra inicial, luego letras, números o guiones)`);
  }
  if (loadSteps(configDir).has(name) || (STEP_NAMES as readonly string[]).includes(name) || name === "setup") {
    throw new Error(`Ya existe un paso llamado ${name}`);
  }
  const definition = {
    kind: "claude",
    ...customMetadata(name, step, configDir),
    tools: ["Read", "Glob", "Grep"],
    allowedTools: [],
    disallowedTools: ["Bash(git commit*)", "Bash(git push*)", "Bash(git checkout*)", "Bash(git switch*)", "Bash(git reset*)"],
    mcpServers: [],
    memory: "off",
    timeoutMs: 600_000,
  };
  const dir = join(configDir, "steps", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "step.json"), JSON.stringify(definition, null, 2) + "\n");
  writeFileSync(join(dir, "prompt.md"), DEFAULT_CUSTOM_PROMPT.replace("{{name}}", name));
}

/** Deletes a custom step and takes it out of every profile. Built-in steps cannot be deleted. */
export function deleteStep(name: string, configDir = CONFIG_DIR): void {
  const steps = loadSteps(configDir);
  const step = steps.get(name);
  if (!step) {
    throw new Error(`No existe el paso ${name}`);
  }
  if (!step.custom) {
    throw new Error(`${name} es un paso de Nexura y no se puede borrar`);
  }
  const dependants = [...steps.values()].filter((candidate) => candidate.after === name).map((candidate) => candidate.name);
  if (dependants.length) {
    throw new Error(`Antes cambia "Después de" en: ${dependants.join(", ")}`);
  }
  for (const profile of loadProfiles(configDir).values()) {
    if (profile.steps[name]) {
      const { [name]: _removed, ...rest } = profile.steps;
      writeFileSync(join(configDir, "profiles", `${profile.name}.json`), JSON.stringify({ ...profile, steps: rest }, null, 2) + "\n");
    }
  }
  rmSync(join(configDir, "steps", name), { recursive: true, force: true });
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
