import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function saveProfile(profile: FlowProfile, configDir = CONFIG_DIR): void {
  if (!/^[a-z0-9-]+$/.test(profile.name)) {
    throw new Error(`Invalid profile name "${profile.name}" (use a-z, 0-9 and -)`);
  }
  writeFileSync(join(configDir, "profiles", `${profile.name}.json`), JSON.stringify(profile, null, 2) + "\n");
}
