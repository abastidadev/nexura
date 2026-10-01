import type { AgentKind, Effort } from "./flow.ts";

/**
 * The Setup IA section: an assistant, read-only on the repo, that either assesses how a
 * project is set up for coding agents (`assess`) or writes the skill, agent, hook, MCP
 * server or instructions the person asks for (`create`), following the ai-toolkit's way of
 * writing them. Nothing reaches the repo until the person presses «Escribir en el repo».
 */
export type AiSetupMode = "assess" | "create";

export const AI_SETUP_MODES: readonly AiSetupMode[] = ["assess", "create"];

export const AI_SETUP_MODE_LABELS: Record<AiSetupMode, string> = { assess: "Valoración", create: "Crear" };

/** What a recommendation or a file is. */
export type AiSetupKind = "skill" | "agent" | "hook" | "mcp" | "plugin" | "instructions" | "settings" | "command";

export const AI_SETUP_KINDS: readonly AiSetupKind[] = ["skill", "agent", "hook", "mcp", "plugin", "instructions", "settings", "command"];

export const AI_SETUP_KIND_LABELS: Record<AiSetupKind, string> = {
  skill: "Skill",
  agent: "Agente",
  hook: "Hook",
  mcp: "Servidor MCP",
  plugin: "Plugin",
  instructions: "Instrucciones",
  settings: "Ajustes",
  command: "Comando",
};

/**
 * Where a piece belongs: this repo (`project`), the department's shared toolkit (`toolkit`:
 * it would hold in any repo of the stack) or the person's own machine (`user`).
 */
export type AiSetupScope = "project" | "toolkit" | "user";

export const AI_SETUP_SCOPES: readonly AiSetupScope[] = ["project", "toolkit", "user"];

export const AI_SETUP_SCOPE_LABELS: Record<AiSetupScope, string> = { project: "Este repo", toolkit: "ai-toolkit", user: "Tu máquina" };

export type AiSetupPriority = "high" | "medium" | "low";

export const AI_SETUP_PRIORITIES: readonly AiSetupPriority[] = ["high", "medium", "low"];

/** One thing worth adding (or removing) to the project's agent setup. */
export type AiSetupRecommendation = {
  key: string;
  kind: AiSetupKind;
  scope: AiSetupScope;
  priority: AiSetupPriority;
  title: string;
  /** Why, tied to what the assistant saw in the repo. */
  why: string;
  /** A command to run by hand (`claude plugin install ...`), when installing is the whole job. */
  command: string;
  /** What to ask the create mode for, when the piece has to be written. */
  createPrompt: string;
};

/** The assessment: what the project is and has, and the few things worth doing next. */
export type AiSetupAssessment = {
  /** Stack, size and tooling as the assistant saw them. */
  profile: string;
  /** What is already set up and works. */
  strengths: string[];
  /** Problems in what exists (a skill that never fires, a duplicated MCP server, a reviewer that can write). */
  issues: string[];
  recommendations: AiSetupRecommendation[];
};

/** A file the assistant proposes. `baseHash` pins the version it read, so a write never clobbers a newer one. */
export type AiSetupFile = {
  key: string;
  /** Relative to the repo root, with forward slashes. */
  path: string;
  kind: AiSetupKind;
  /** What it is for, one line. */
  purpose: string;
  content: string;
  /** sha256 of the file when the assistant proposed it; "" = it did not exist. */
  baseHash: string;
  /** Set once it is on disk. */
  written?: boolean;
};

/** Create mode: where the assistant thinks the piece belongs (the toolkit when it would hold in any repo of the stack). */
export type AiSetupPlacement = { scope: AiSetupScope; plugin: string; reason: string };

export type AiSetupQuestion = { text: string; options: string[] };

export type AiSetupMessage = { role: "user" | "assistant"; text: string; questions?: AiSetupQuestion[]; at: string };

export type AiSetupAgent = { agent: AgentKind; model: string; effort: Effort };

export const DEFAULT_AI_SETUP_AGENT: AiSetupAgent = { agent: "claude", model: "sonnet", effort: "medium" };

/** `applied` = every file is written; `error` = the last turn or write failed (the session is kept). */
export type AiSetupStatus = "thinking" | "idle" | "error" | "applied";

export type AiSetupSession = {
  id: string;
  repo: string;
  mode: AiSetupMode;
  /** What the person asked for, in their words ("" for a plain assessment). */
  idea: string;
  agent: AiSetupAgent;
  sessionId?: string;
  messages: AiSetupMessage[];
  /** Assess mode. */
  assessment?: AiSetupAssessment;
  /** Create mode. */
  placement?: AiSetupPlacement;
  /** Create mode: the files to write, as the person left them. */
  files: AiSetupFile[];
  /** What the assistant still needs, in plain Spanish. */
  missing: string[];
  ready: boolean;
  status: AiSetupStatus;
  /** What the assistant is doing right now (not persisted). */
  activity?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/** A configured repo as the section needs it: `toolkit` = it is a plugin marketplace like the ai-toolkit. */
export type AiSetupRepo = { name: string; toolkit: boolean };

export type NewAiSetupSession = { repo: string; mode: AiSetupMode; idea: string; agent?: AiSetupAgent };

/** What the person can edit by hand: the files' paths and contents (never add or resurrect one). */
export type AiSetupUpdate = { files: Pick<AiSetupFile, "key" | "path" | "content">[] };
