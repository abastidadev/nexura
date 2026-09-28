import { createHash } from "node:crypto";
import { agentOf, AUTO_MCP_SERVERS, type MemoryMode, type NexuraEvent, type StepDefinition, type StepRun } from "@nexura/shared";
import { resolveMcpServers } from "../workspace/claude-inventory.ts";

/**
 * Past this much context (input + cache of the last call), a new session that gets the ticket,
 * the plan and the feedback again is cheaper than dragging the old one along. A starting point
 * to calibrate with `contextMetrics.contextTokens`, not a measured optimum.
 */
export const MAX_CONTEXT_TOKENS = 400_000;

/** Steps that always start their own session: judging or summarising the work needs fresh eyes. */
const FRESH_SESSION_STEPS: ReadonlySet<string> = new Set(["classify", "codeReview", "prReview", "qaNotes"]);

/** Whether a step carries on the run's main work session (investigate, plan, implement, fix). */
export function continuesMainSession(step: string): boolean {
  return !FRESH_SESSION_STEPS.has(step);
}

/** Why a session is too big to carry on, or undefined when it is not. */
export function contextTooLarge(previous: StepRun): string | undefined {
  const tokens = previous.contextMetrics?.contextTokens ?? 0;
  return tokens >= MAX_CONTEXT_TOKENS ? `contexto de ${tokens} tokens: sesión nueva` : undefined;
}

export function correctionSession(previous: StepRun | undefined, current: StepRun): { previous?: StepRun; reason: string } {
  if (!previous?.sessionId || previous.status !== "succeeded") {
    return { reason: "sin sesión de implementación completada" };
  }
  if (agentOf(previous) !== agentOf(current) || previous.model !== current.model || previous.effort !== current.effort) {
    return { reason: "cambió el agente, modelo o esfuerzo" };
  }
  const tooLarge = contextTooLarge(previous);
  if (tooLarge) {
    return { reason: tooLarge };
  }
  return { previous, reason: "corrección sobre la sesión de implementación" };
}

/**
 * What every phase of the main session exposes to the model. Claude caches a prompt by its
 * prefix (tool schemas, then system prompt, then messages), so a phase that adds or drops a
 * tool, an MCP server or the memory protocol rewrites the whole conversation into the cache.
 * The phases share the union of their tools, servers and memory mode, and each one is
 * restricted by its permissions (`--allowedTools` with `dontAsk`) instead.
 */
export type SessionEnvelope = { tools: string[]; disallowedTools: string[]; mcpServers: string[]; memory: MemoryMode };

const MEMORY_RANK: Record<MemoryMode, number> = { off: 0, read: 1, readwrite: 2 };

export function mainSessionEnvelope(definitions: Pick<StepDefinition, "tools" | "disallowedTools" | "mcpServers" | "memory">[]): SessionEnvelope {
  const union = (lists: string[][]): string[] => [...new Set(lists.flat())];
  const memory = definitions
    .map((definition) => definition.memory ?? "off")
    .reduce<MemoryMode>((max, mode) => (MEMORY_RANK[mode] > MEMORY_RANK[max] ? mode : max), "off");
  return {
    tools: union(definitions.map((definition) => definition.tools)),
    disallowedTools: union(definitions.map((definition) => definition.disallowedTools)),
    mcpServers: union(definitions.map((definition) => definition.mcpServers ?? [])),
    memory,
  };
}

/**
 * One `--json-schema` for every phase of the main session. Claude turns the schema into the
 * input schema of its `StructuredOutput` tool, so a phase with a different schema changes the
 * tool definitions, the start of the cached prefix, and rewrites the whole conversation. Each
 * phase answers under its own key; a phase without a schema answers there with its final text.
 */
export function sessionSchema(phases: { name: string; schema?: object }[]): object {
  const properties = Object.fromEntries(phases.map(({ name, schema }) => [name, schema ?? { type: "string", description: "Respuesta final en texto." }]));
  return {
    type: "object",
    description: "Rellena solo la clave del paso en curso, que indica su prompt.",
    properties,
    additionalProperties: false,
  };
}

/** A phase's own answer inside the session schema's output, or undefined when it did not fill its key. */
export function phaseOutput(output: unknown, phase: string): unknown {
  return output && typeof output === "object" ? (output as Record<string, unknown>)[phase] : undefined;
}

/** Select only known, enabled servers; custom names remain explicit step configuration. */
export function automaticMcpNames(enabled: string[], step: string, taskContext: string): string[] {
  if (!["enrich", "plan", "implement", "codeReview", "addressReview", "prReview"].includes(step)) {
    return [];
  }
  const selected = new Set(["context7"]);
  if (/angular|\.component\.(ts|html)|\bngrx\b|\btransloco\b/i.test(taskContext)) {
    selected.add("angular-cli");
  }
  if (["implement", "addressReview"].includes(step) && /\b(ui|ux|e2e|playwright|storybook|navegador|browser|visual|pantalla)\b/i.test(taskContext)) {
    selected.add("playwright");
  }
  return enabled.filter((name) => selected.has(name) && AUTO_MCP_SERVERS.includes(name));
}

/** Retain enabled server specs: resolving their names again could select a disabled override. */
export function resolveStepMcp(repoPath: string, names: string[], step: string | string[], taskContext: string, exclude: string[]) {
  const explicit = resolveMcpServers(repoPath, names.filter((name) => name !== "@auto"), exclude);
  if (names.includes("@auto")) {
    const available = resolveMcpServers(repoPath, ["*"], exclude);
    // A shared session resolves `@auto` for all its phases at once, so every phase gets the same servers.
    for (const phase of Array.isArray(step) ? step : [step]) {
      for (const name of automaticMcpNames(Object.keys(available.servers), phase, taskContext)) {
        explicit.servers[name] ??= available.servers[name]!;
      }
    }
  }
  return explicit;
}

/** Short, stable digest of what a phase sent that decides whether Claude can reuse its cache. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 12);
}

/** Below this share of the previous context read back from the cache, a continuation lost it. */
const CACHE_REUSE_RATIO = 0.5;

/**
 * Whether a continued phase reused the cached conversation and, when it did not, what changed
 * between both phases (model, effort, tools, schema…). Undefined when there is nothing to judge.
 */
export function cacheContinuity(previous: StepRun, current: StepRun): { reused: boolean; changed: string[] } | undefined {
  const before = previous.contextMetrics;
  const now = current.contextMetrics;
  if (!before?.contextTokens || now?.firstCallCacheRead === undefined) {
    return undefined;
  }
  const reused = now.firstCallCacheRead >= before.contextTokens * CACHE_REUSE_RATIO;
  const changed = [
    previous.model !== current.model ? "modelo" : "",
    previous.effort !== current.effort ? "esfuerzo" : "",
    before.toolsFingerprint !== now.toolsFingerprint ? "herramientas" : "",
    before.schemaFingerprint !== now.schemaFingerprint ? "schema de salida" : "",
    before.systemFingerprint !== now.systemFingerprint ? "system prompt" : "",
  ].filter(Boolean);
  return { reused, changed };
}

/** Repeated explicit Read calls within a step; not a claim that the repeat was unnecessary. */
export function observeContext(metrics: NonNullable<StepRun["contextMetrics"]>, reads: Set<string>, event: NexuraEvent): void {
  if (event.kind === "init") {
    metrics.toolsFingerprint = fingerprint(event.tools);
  } else if (event.kind === "toolUse") {
    metrics.toolCalls++;
    if (event.name === "Read") {
      const input = event.input as { file_path?: unknown; path?: unknown; offset?: unknown; limit?: unknown } | null;
      const path = input?.file_path ?? input?.path;
      if (typeof path === "string") {
        metrics.readCalls++;
        const key = JSON.stringify([path.replace(/\\/g, "/"), input?.offset ?? 0, input?.limit ?? null]);
        if (reads.has(key)) {
          metrics.repeatedReadCalls++;
        }
        reads.add(key);
      }
    }
  } else if (event.kind === "toolResult") {
    metrics.toolResultChars += event.content.length;
  }
}
