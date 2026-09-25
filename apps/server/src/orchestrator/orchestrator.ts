import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AGENT_MODELS,
  agentOf,
  DEFAULT_SETTINGS,
  orderSteps,
  type AgentKind,
  type CreatedPr,
  type FlowProfile,
  type JudgeConfig,
  type NexuraEvent,
  type NexuraSettings,
  type PrDraft,
  type QuotaInfo,
  type RetryOptions,
  type ReviewReply,
  type ReviewThread,
  type Run,
  type RunRequest,
  type ServerMessage,
  type StepConfig,
  type StepName,
  type StepRun,
  type Worktree,
} from "@nexura/shared";
import { isValidModel, type LoadedStep, type NexuraConfig } from "../config/config-loader.ts";
import { Ledger } from "../ledger/ledger.ts";
import { asJsonBlock, renderTemplate } from "../prompt/render.ts";
import { AgentProcess } from "../runner/agent-process.ts";
import type { RunStore } from "../store/run-store.ts";
import { commitAll, createWorktree, removeWorktree, slugify } from "../workspace/git.ts";
import { learnRepoNotes, readRepoNotes, repoMap } from "../workspace/repo-context.ts";
import { isMemoryWrite, memoryRunOptions, memoryStore, readMemory } from "../memory/memory.ts";
import { projectOf, type NewObservation } from "../memory/memory-store.ts";
import { buildPrDraft, getActiveThreads, pushAndCreatePr, pushBranch, replyToThread, threadsToText } from "../forge/forge.ts";
import { mergeJudgments, type CodeReviewOutput, type ReviewIssue } from "./blind-review.ts";
import { runQaCode, runReleaseLocal, type QaOutput } from "./builtin-steps.ts";

/** Deciding the profile must be cheap. */
const CLASSIFY_CONFIG: StepConfig = { agent: "claude", model: "haiku", effort: "low", enabled: true };
const DEFAULT_BRANCH_PREFIX = "feat";
const RATE_LIMIT_MARGIN_MS = 60_000;
const ERROR_TEXT_MAX = 1500;
const QUOTA_KEY = "quota";
const RESUME_DEFAULT_INSTRUCTION = "Continúa donde lo dejaste y termina el paso.";

class CancelledError extends Error {}

/** Agent/model overrides come from the API and end up as CLI arguments: validate them. */
function checkOverrides(options: RetryOptions, fallbackAgent: AgentKind): void {
  if (options.agent !== undefined && !AGENT_KINDS.includes(options.agent)) {
    throw new Error(`Agente desconocido: ${String(options.agent)}`);
  }
  if (options.model !== undefined && !isValidModel(options.agent ?? fallbackAgent, options.model)) {
    throw new Error(`Modelo no válido para ${AGENT_LABELS[options.agent ?? fallbackAgent]}: ${String(options.model)}`);
  }
}

type RunContext = {
  cancelled: boolean;
  process?: AgentProcess;
  /** Delivers a user message to the running agent step; false when there is none or it takes no input. */
  send?: (text: string) => boolean;
  /** Resolves a breakpoint pause, optionally with overrides for the next step. */
  release?: (options?: RetryOptions) => void;
  /** Wakes a rate-limit wait early (cancel). */
  wake?: () => void;
};

type StepContext = {
  outputs: Map<StepName, unknown>;
  feedback?: string;
  ledger: Ledger;
  /** Step-specific template variables, e.g. `threads` for addressReview. */
  extraVars?: Record<string, string>;
};

/** Steps that never run in the profile sequence: they are launched on demand. */
const ON_DEMAND_STEPS: ReadonlySet<StepName> = new Set(["classify", "addressReview"]);
const DEFAULT_ADDRESS_REVIEW: StepConfig = { agent: "claude", model: "sonnet", effort: "medium", enabled: true };

type StepOutcome = { stepRun: StepRun; rateLimitedUntil?: number };

export type OrchestratorOptions = {
  concurrency: number;
  /** Extra wait after a window reset before retrying (default 60 s; tests use 0). */
  rateLimitMarginMs?: number;
};

const SETTINGS_KEY = "settings";
const MIN_PR_POLL_SECONDS = 30;

export class Orchestrator extends EventEmitter<{ message: [ServerMessage]; settings: [NexuraSettings] }> {
  private config: NexuraConfig;
  private readonly store: RunStore;
  private readonly options: OrchestratorOptions;
  private readonly contexts = new Map<string, RunContext>();
  private readonly waiting: (() => void)[] = [];
  private readonly eventSeq = new Map<string, number>();
  private running = 0;
  private quota?: QuotaInfo;
  private settings: NexuraSettings;

  public constructor(config: NexuraConfig, store: RunStore, options: OrchestratorOptions = { concurrency: 2 }) {
    super();
    this.config = config;
    this.store = store;
    this.options = options;
    this.quota = store.getSetting<QuotaInfo>(QUOTA_KEY);
    this.settings = { ...DEFAULT_SETTINGS, ...store.getSetting<Partial<NexuraSettings>>(SETTINGS_KEY) };
  }

  public getSettings(): NexuraSettings {
    return this.settings;
  }

  public saveSettings(update: Partial<NexuraSettings>): NexuraSettings {
    const next = { ...this.settings, ...update };
    next.memoryEnabled = Boolean(next.memoryEnabled);
    if (next.quotaPausePercent !== null && (!Number.isFinite(next.quotaPausePercent) || next.quotaPausePercent <= 0 || next.quotaPausePercent > 100)) {
      throw new Error("El umbral de cuota debe estar entre 1 y 100 (o vacío para no pausar)");
    }
    if (!Number.isInteger(next.prPollSeconds) || next.prPollSeconds < 0 || (next.prPollSeconds > 0 && next.prPollSeconds < MIN_PR_POLL_SECONDS)) {
      throw new Error(`La revisión de PRs debe ser 0 (apagada) o al menos ${MIN_PR_POLL_SECONDS} s`);
    }
    this.settings = next;
    this.store.setSetting(SETTINGS_KEY, next);
    this.emit("settings", next);
    return next;
  }

  /** For the PR watcher: runs that may still get review comments. */
  public listRuns(): Run[] {
    return this.store.listRuns(1000);
  }

  /** Small out-of-band updates (e.g. reviewWatch) on a run that is not executing. */
  public patchRun(runId: string, patch: Partial<Pick<Run, "reviewWatch">>): void {
    if (this.contexts.has(runId)) {
      return; // Executing: its own persists would overwrite the patch anyway.
    }
    const run = this.requireRun(runId);
    Object.assign(run, patch);
    this.persist(run);
  }

  public notice(message: Omit<Extract<ServerMessage, { type: "notice" }>, "type">): void {
    this.emit("message", { type: "notice", ...message });
  }

  public setConfig(config: NexuraConfig): void {
    this.config = config;
  }

  public getQuota(): QuotaInfo | undefined {
    return this.quota;
  }

  // ---------------------------------------------------------------- public API

  public start(request: RunRequest): Run {
    if (request.profile !== "auto" && !this.config.profiles.has(request.profile)) {
      throw new Error(`Perfil desconocido: ${request.profile}`);
    }
    if (request.repos.length === 0) {
      throw new Error("Selecciona al menos un repositorio");
    }
    for (const name of request.repos) {
      if (!this.config.repos.some((repo) => repo.name === name)) {
        throw new Error(`Repositorio no configurado en repos.json: ${name}`);
      }
    }
    const run: Run = {
      id: randomUUID().slice(0, 8),
      request,
      status: "queued",
      resolvedProfile: request.profile === "auto" ? undefined : request.profile,
      createdAt: new Date().toISOString(),
      steps: [],
      worktrees: [],
      totalCostUsd: 0,
    };
    this.persist(run);
    this.contexts.set(run.id, { cancelled: false });
    void this.schedule(run.id, () => this.execute(run));
    return run;
  }

  /** Re-runs the flow from its last failed/cancelled step, with optional overrides. */
  public retry(runId: string, options: RetryOptions = {}): Run {
    const run = this.requireRun(runId);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error(`El run ${runId} no está fallido ni cancelado (${run.status})`);
    }
    const last = run.steps.at(-1);
    checkOverrides(options, agentOf(last));
    run.status = "queued";
    run.error = undefined;
    this.persist(run);
    this.contexts.set(runId, { cancelled: false });
    void this.schedule(runId, () =>
      last?.step === "addressReview"
        ? this.executeAddressReview(run, options)
        : this.execute(run, last ? { step: last.step, options } : undefined),
    );
    return run;
  }

  /** Active comment threads of the run's PRs. Plain REST, no tokens. */
  public async reviewThreads(runId: string): Promise<ReviewThread[]> {
    const run = this.requireRun(runId);
    const threads: ReviewThread[] = [];
    for (const pr of run.pullRequests ?? []) {
      const worktree = run.worktrees.find((candidate) => candidate.repo === pr.repo);
      if (worktree) {
        threads.push(...(await getActiveThreads(worktree, pr)));
      }
    }
    return threads;
  }

  /** Records whether classify chose the right profile (feeds the metrics to tune its heuristics). */
  public rateClassify(runId: string, correct: boolean, expected?: string): Run {
    const run = this.requireRun(runId);
    if (!run.classifyReason) {
      throw new Error("Este flujo no pasó por classify");
    }
    if (expected !== undefined && !this.config.profiles.has(expected)) {
      throw new Error(`Perfil desconocido: ${expected}`);
    }
    run.classifyFeedback = { correct, expected: correct ? undefined : expected, ratedAt: new Date().toISOString() };
    this.persist(run);
    return run;
  }

  /** Launches addressReview on a finished run with PRs: fix, commit, then approval to push and reply. */
  public addressReview(runId: string): Run {
    const run = this.requireRun(runId);
    if (this.contexts.has(runId)) {
      throw new Error("El flujo está activo");
    }
    if (!run.pullRequests?.length) {
      throw new Error("Este flujo no tiene PR creada");
    }
    if (run.worktrees.length === 0) {
      throw new Error("Los worktrees de este flujo se borraron; no se puede atender la revisión");
    }
    run.status = "queued";
    run.error = undefined;
    this.persist(run);
    this.contexts.set(runId, { cancelled: false });
    void this.schedule(runId, () => this.executeAddressReview(run));
    return run;
  }

  /** Releases a breakpoint; the options (e.g. an edited prompt) apply to the step about to run. */
  public continue(runId: string, options?: RetryOptions): void {
    const context = this.contexts.get(runId);
    if (!context?.release) {
      throw new Error(`El run ${runId} no está pausado`);
    }
    if (options) {
      const run = this.requireRun(runId);
      const profile = run.resolvedProfile ? this.config.profiles.get(run.resolvedProfile) : undefined;
      checkOverrides(options, agentOf(run.pendingStep ? profile?.steps[run.pendingStep.step] : undefined));
    }
    context.release(options);
  }

  /** A message typed by the user while a claude step runs: it joins the current turn. */
  public sendMessage(runId: string, text: string): void {
    const message = text.trim();
    if (!message) {
      throw new Error("El mensaje está vacío");
    }
    const context = this.contexts.get(runId);
    if (!context?.send?.(message)) {
      throw new Error(
        context?.process && !context.process.interactive
          ? "Este paso lo ejecuta un agente que no admite mensajes a mitad de paso (solo Claude los admite)"
          : "Ahora mismo no hay ningún paso con Claude trabajando en este flujo",
      );
    }
  }

  public cancel(runId: string): void {
    const context = this.contexts.get(runId);
    if (!context) {
      throw new Error(`El run ${runId} no está activo`);
    }
    context.cancelled = true;
    context.process?.kill();
    context.release?.();
    context.wake?.();
  }

  public async cleanup(runId: string, deleteBranches = false): Promise<void> {
    const run = this.requireRun(runId);
    if (this.contexts.has(runId)) {
      throw new Error("No se puede limpiar un run activo");
    }
    for (const worktree of run.worktrees) {
      await removeWorktree(worktree, deleteBranches);
    }
    run.worktrees = [];
    this.persist(run);
  }

  /**
   * Forgets a finished run: history, events and logs, plus its worktrees. The branches
   * stay (they may hold commits or back a PR); `deleteBranches` removes them too.
   */
  public async deleteRun(runId: string, deleteBranches = false): Promise<void> {
    const run = this.requireRun(runId);
    if (this.contexts.has(runId)) {
      throw new Error("El flujo está activo: cancélalo antes de borrarlo");
    }
    for (const worktree of run.worktrees) {
      try {
        await removeWorktree(worktree, deleteBranches);
      } catch {
        // Already removed by hand: nothing left to clean.
      }
    }
    for (const step of run.steps) {
      this.eventSeq.delete(step.id);
    }
    this.store.deleteRun(runId);
    this.emit("message", { type: "runDeleted", runId });
  }

  // ---------------------------------------------------------------- scheduling

  private async schedule(runId: string, job: () => Promise<void>): Promise<void> {
    const context = this.contexts.get(runId);
    if (this.running >= this.options.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      await job();
    } catch (error) {
      const run = this.store.getRun(runId);
      if (run) {
        this.fail(run, `Error interno: ${String(error)}`);
      }
    } finally {
      this.running--;
      this.releaseContext(runId, context);
      this.waiting.shift()?.();
    }
  }

  private async execute(initial: Run, startAt?: { step: StepName; options: RetryOptions }): Promise<void> {
    const run = this.store.getRun(initial.id) ?? initial;
    const context = this.contexts.get(run.id)!;
    if (context.cancelled) {
      run.status = "cancelled";
      this.releaseContext(run.id, context);
      this.persist(run);
      return;
    }
    run.status = "running";
    this.persist(run);
    const ledger = new Ledger(run.id);

    try {
      if (run.worktrees.length === 0) {
        await this.setupWorktrees(run, ledger);
      }

      // Outputs of earlier successful steps, so a retry does not redo them.
      const stepContext: StepContext = { outputs: new Map(), ledger, extraVars: await this.repoContextVars(run) };
      for (const stepRun of run.steps) {
        if (stepRun.status === "succeeded") {
          stepContext.outputs.set(stepRun.step, stepRun.structuredOutput);
        }
      }
      let pending = startAt?.options;

      if (!run.resolvedProfile) {
        const classified = await this.runWithRateLimit(run, context, "classify", CLASSIFY_CONFIG, stepContext, pending);
        pending = undefined;
        if (!classified) {
          return;
        }
        const output = classified.structuredOutput as { profile: string; reason: string };
        if (!this.config.profiles.has(output.profile)) {
          this.fail(run, `classify eligió un perfil inexistente: ${output.profile}`);
          return;
        }
        run.resolvedProfile = output.profile;
        run.classifyReason = output.reason;
        ledger.append("classify", `Perfil **${output.profile}**: ${output.reason}`);
        this.persist(run);
      }

      const profile = this.config.profiles.get(run.resolvedProfile)!;
      const sequence = orderSteps(this.config.steps.values())
        .map((step) => step.name)
        .filter((name) => !ON_DEMAND_STEPS.has(name) && profile.steps[name]?.enabled);
      let index = startAt && startAt.step !== "classify" ? Math.max(0, sequence.indexOf(startAt.step)) : 0;
      let loops = Math.max(0, run.steps.filter((s) => s.step === "implement" && s.status === "succeeded").length - 1);

      if (pending?.skip) {
        this.recordSkipped(run, sequence[index]!, profile);
        pending = undefined;
        index++;
      }

      while (index < sequence.length) {
        const stepName = sequence[index]!;
        const stepConfig = profile.steps[stepName]!;

        if (run.request.stepByStep) {
          pending = (await this.breakpoint(run, context, stepName, stepContext, pending)) ?? pending;
          if (pending?.skip) {
            this.recordSkipped(run, stepName, profile);
            pending = undefined;
            index++;
            continue;
          }
        }

        const blind = stepName === "codeReview" && profile.reviewMode === "blind";
        const stepRun = blind
          ? await this.runBlindReview(run, context, stepConfig, profile.judgeB, stepContext, pending, ledger)
          : await this.runWithRateLimit(run, context, stepName, stepConfig, stepContext, pending);
        pending = undefined;
        if (!stepRun) {
          return;
        }
        stepContext.outputs.set(stepName, stepRun.structuredOutput);

        if (stepName === "implement") {
          await this.afterImplement(run, stepRun, ledger);
          stepContext.feedback = undefined;
        }
        if (stepName === "enrich") {
          await this.learnFromEnrich(run, stepRun);
        }
        if (this.config.steps.get(stepName)?.custom) {
          await this.afterCustomStep(run, stepRun, ledger);
        }

        const rework = this.reworkNeeded(stepName, stepRun.structuredOutput);
        if (rework) {
          const implementIndex = sequence.indexOf("implement");
          if (implementIndex < 0) {
            this.fail(run, `${stepName} pide cambios pero el perfil no tiene paso implement`);
            return;
          }
          if (loops >= profile.maxLoops) {
            const escalated = blind ? " (escalado: los dos jueces siguen confirmando problemas)" : "";
            this.fail(run, `${stepName} sigue pidiendo cambios tras ${loops} vuelta(s) (maxLoops=${profile.maxLoops})${escalated}`);
            return;
          }
          loops++;
          stepContext.feedback = rework;
          ledger.append(stepName, `Devuelve el trabajo a implement (vuelta ${loops}):\n${rework}`);
          index = implementIndex;
          continue;
        }
        index++;
      }

      await this.rememberRun(run, stepContext);
      run.status = "done";
      run.pendingStep = undefined;
      this.releaseContext(run.id, context);
      this.persist(run);
    } catch (error) {
      if (error instanceof CancelledError || context.cancelled) {
        run.status = "cancelled";
        run.pendingStep = undefined;
        run.resumesAt = undefined;
        this.releaseContext(run.id, context);
        this.persist(run);
      } else {
        this.fail(run, String(error instanceof Error ? error.message : error));
      }
    }
  }

  // ---------------------------------------------------------------- steps

  /** Runs a step; when the usage limit hits, waits for the window to reset and tries again. */
  private async runWithRateLimit(
    run: Run,
    context: RunContext,
    stepName: StepName,
    stepConfig: StepConfig,
    stepContext: StepContext,
    options?: RetryOptions,
    judge?: StepRun["judge"],
  ): Promise<StepRun | undefined> {
    const usesClaude = this.config.steps.get(stepName)?.kind !== "builtin" && (options?.agent ?? agentOf(stepConfig)) === "claude";
    for (;;) {
      // Don't start a Claude step while the plan window is above the user's threshold (it only measures Claude's plan).
      const guardedUntil = usesClaude ? this.quotaGuardUntil() : undefined;
      if (guardedUntil !== undefined) {
        await this.waitForWindow(run, context, guardedUntil);
        continue;
      }
      const { stepRun, rateLimitedUntil } = await this.runStep(run, context, stepName, stepConfig, stepContext, options, judge);
      if (context.cancelled) {
        throw new CancelledError();
      }
      if (stepRun.status === "succeeded") {
        return stepRun;
      }
      if (rateLimitedUntil === undefined) {
        this.fail(run, `Falló el paso ${stepName}: ${stepRun.error ?? "error desconocido"}`);
        return undefined;
      }
      await this.waitForWindow(run, context, rateLimitedUntil);
    }
  }

  /**
   * Blind double review: two judges get the very same prompt in fresh sessions (they never see
   * each other's answer, and it is rendered once, before judge A). Only the blocking issues both
   * confirm go back to implement. Judge B may run on another agent/model (`judgeB` of the
   * profile), so two different models have to agree. Returns judge B's step run carrying
   * the merged output, or undefined when a judge failed (the run is already failed then).
   */
  private async runBlindReview(
    run: Run,
    context: RunContext,
    stepConfig: StepConfig,
    judgeBConfig: JudgeConfig | undefined,
    stepContext: StepContext,
    pending: RetryOptions | undefined,
    ledger: Ledger,
  ): Promise<StepRun | undefined> {
    const prompt = pending?.prompt ?? this.renderPrompt(run, "codeReview", stepContext);
    const options: RetryOptions = { ...pending, prompt, resumeSession: false };
    const judgeA = await this.runWithRateLimit(run, context, "codeReview", stepConfig, stepContext, options, "A");
    if (!judgeA) {
      return undefined;
    }
    const configB: StepConfig = judgeBConfig ? { ...stepConfig, ...judgeBConfig, agent: agentOf(judgeBConfig) } : stepConfig;
    const judgeB = await this.runWithRateLimit(run, context, "codeReview", configB, stepContext, options, "B");
    if (!judgeB) {
      return undefined;
    }

    const merged = mergeJudgments(judgeA.structuredOutput as CodeReviewOutput, judgeB.structuredOutput as CodeReviewOutput);
    const describe = (issue: ReviewIssue): string => `- [${issue.severity}] ${issue.file}: ${issue.problem}`;
    const discarded = merged.unconfirmed.length ? `\nDescartadas (solo un juez): ${merged.unconfirmed.map(describe).join(" ")}` : "";
    this.recordEvent(run, judgeB, {
      kind: "text",
      text: `Doble revisión ciega: ${merged.summary}.${merged.issues.length ? `\nConfirmadas:\n${merged.issues.map(describe).join("\n")}` : ""}${discarded}`,
    });
    ledger.append(
      "codeReview (doble ciega)",
      [
        `Juez A: ${merged.judges.A}. Juez B: ${merged.judges.B}. Confirmadas: ${merged.issues.length}.`,
        merged.unconfirmed.length ? `Descartadas (solo las marca un juez):\n${merged.unconfirmed.map(describe).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return { ...judgeB, structuredOutput: merged };
  }

  /** Epoch seconds of the 5 h window reset when its usage is at/above the configured %, else undefined. */
  private quotaGuardUntil(): number | undefined {
    const limit = this.settings.quotaPausePercent;
    const window = this.quota?.fiveHour;
    if (limit === null || !window || window.resetsAt * 1000 <= Date.now()) {
      return undefined;
    }
    return window.utilization * 100 >= limit ? window.resetsAt : undefined;
  }

  private async waitForWindow(run: Run, context: RunContext, resetsAt: number): Promise<void> {
    run.status = "waiting-rate-limit";
    run.resumesAt = resetsAt;
    this.persist(run);
    await this.sleepUntil(context, resetsAt * 1000 + (this.options.rateLimitMarginMs ?? RATE_LIMIT_MARGIN_MS));
    if (context.cancelled) {
      throw new CancelledError();
    }
    run.status = "running";
    run.resumesAt = undefined;
    this.persist(run);
  }

  private async runStep(
    run: Run,
    context: RunContext,
    stepName: StepName,
    stepConfig: StepConfig,
    stepContext: StepContext,
    options?: RetryOptions,
    judge?: StepRun["judge"],
  ): Promise<StepOutcome> {
    const definition = this.config.steps.get(stepName);
    const kind = definition?.kind ?? "claude";
    const agent: AgentKind = options?.agent ?? agentOf(stepConfig);
    // Switching agent on a retry without naming a model: that agent's default model.
    const model = options?.model ?? (agent === agentOf(stepConfig) ? stepConfig.model : AGENT_MODELS[agent][0]!);
    const stepRun: StepRun = {
      id: randomUUID(),
      runId: run.id,
      step: stepName,
      ...(judge ? { judge } : {}),
      attempt: run.steps.filter((s) => s.step === stepName && s.judge === judge).length + 1,
      seq: run.steps.length,
      status: "running",
      kind,
      ...(kind === "claude" ? { agent } : {}),
      model,
      effort: options?.effort ?? stepConfig.effort,
      startedAt: new Date().toISOString(),
      costUsd: 0,
      numTurns: 0,
    };
    run.steps.push(stepRun);
    this.store.saveStepRun(stepRun);
    this.persist(run);

    let rateLimitedUntil: number | undefined;
    try {
      if (!definition) {
        throw new Error(`No hay definición para el paso ${stepName} en config/steps`);
      }
      if (definition.kind === "builtin") {
        stepRun.structuredOutput = await this.runBuiltin(run, stepRun, stepContext, definition);
        stepRun.status = "succeeded";
      } else {
        rateLimitedUntil = await this.runAgent(run, context, stepRun, stepContext, definition, options);
      }
    } catch (error) {
      stepRun.status = "failed";
      stepRun.error = error instanceof Error ? error.message : String(error);
    }
    if (context.cancelled && stepRun.status === "running") {
      stepRun.status = "failed";
      stepRun.error = "Cancelado";
    }
    stepRun.finishedAt = new Date().toISOString();
    this.store.saveStepRun(stepRun);
    run.totalCostUsd = run.steps.reduce((sum, s) => sum + s.costUsd, 0);
    this.persist(run);
    return { stepRun, rateLimitedUntil };
  }

  /**
   * Runs a step on its agent (claude, codex or copilot). Returns the reset time (epoch s)
   * when a Claude step failed because of the plan's usage limit.
   */
  private async runAgent(
    run: Run,
    context: RunContext,
    stepRun: StepRun,
    stepContext: StepContext,
    definition: LoadedStep,
    options?: RetryOptions,
  ): Promise<number | undefined> {
    const agent = agentOf(stepRun);
    let prompt: string;
    let resume: string | undefined;
    // A session is only resumed by the agent that created it.
    const previous = options?.resumeSession
      ? run.steps.findLast((s) => s.step === stepRun.step && s.id !== stepRun.id && s.sessionId && agentOf(s) === agent)
      : undefined;
    if (previous?.sessionId) {
      resume = previous.sessionId;
      prompt = options?.instruction?.trim() || RESUME_DEFAULT_INSTRUCTION;
    } else {
      prompt = options?.prompt ?? this.renderPrompt(run, stepRun.step, stepContext);
    }

    // Profile budget: what is left for the whole run caps this step (--max-budget-usd).
    // Only Claude reports a cost; Codex and Copilot run on their plans without one.
    const budget = run.resolvedProfile && agent === "claude" ? this.config.profiles.get(run.resolvedProfile)?.budgetUsd : undefined;
    let maxBudgetUsd: number | undefined;
    if (budget !== undefined) {
      const remaining = budget - run.totalCostUsd;
      if (remaining <= 0) {
        throw new Error(
          `Presupuesto del perfil agotado: $${run.totalCostUsd.toFixed(3)} de $${budget.toFixed(2)}. Súbelo en el perfil o reintenta con otro.`,
        );
      }
      maxBudgetUsd = Math.round(remaining * 10_000) / 10_000;
    }

    const [primary, ...others] = run.worktrees;
    // Judge B only reads: both judges would save the same observations.
    const memoryMode = stepRun.judge === "B" && definition.memory === "readwrite" ? "read" : definition.memory;
    const memory =
      this.settings.memoryEnabled && memoryMode && memoryMode !== "off"
        ? memoryRunOptions(memoryMode, {
            project: await projectOf(primary!.repoPath),
            step: stepRun.step,
            runId: run.id,
            allowedTools: definition.allowedTools,
          })
        : undefined;
    const process = new AgentProcess({
      agent,
      maxBudgetUsd,
      cwd: primary!.path,
      prompt,
      model: stepRun.model,
      effort: stepRun.effort,
      tools: definition.tools,
      allowedTools: definition.allowedTools,
      disallowedTools: definition.disallowedTools,
      useMcp: definition.useMcp,
      addDirs: others.map((worktree) => worktree.path),
      jsonSchema: stepRun.step === "classify" ? this.classifySchema(definition.schema) : definition.schema,
      timeoutMs: definition.timeoutMs,
      resume,
      forkSession: Boolean(resume),
      ...memory,
    });
    stepRun.prompt = prompt;
    stepRun.args = process.args;
    this.store.saveStepRun(stepRun);
    this.persist(run);

    let rejectedUntil: number | undefined;
    let memoriesSaved = 0;
    process.on("raw", (line) => this.store.appendRaw(run.id, stepRun, line));
    process.on("event", (event) => {
      this.recordEvent(run, stepRun, event);
      if (event.kind === "toolUse" && isMemoryWrite(event.name)) {
        memoriesSaved++;
      }
      if (event.kind === "init") {
        stepRun.sessionId = event.sessionId;
        this.store.saveStepRun(stepRun);
      }
      if (event.kind === "rateLimit") {
        this.updateQuota(event);
        if (event.status === "rejected") {
          rejectedUntil = event.resetsAt;
        }
      }
    });

    context.process = process;
    context.send = (text) => {
      if (!process.send(text)) {
        return false;
      }
      this.recordEvent(run, stepRun, { kind: "userMessage", text });
      return true;
    };
    const outcome = await process.run();
    context.process = undefined;
    context.send = undefined;
    if (memoriesSaved > 0) {
      this.recordEvent(run, stepRun, { kind: "text", text: `Guardada(s) ${memoriesSaved} observación(es) en la memoria compartida.` });
    }

    const result = outcome.result;
    stepRun.sessionId = outcome.sessionId ?? stepRun.sessionId;
    if (result) {
      stepRun.costUsd = result.costUsd;
      stepRun.numTurns = result.numTurns;
      stepRun.usage = result.usage;
      // Steps without a schema (custom ones) hand their final text to the next steps.
      stepRun.structuredOutput = definition.schema ? result.structuredOutput : result.text;
    }

    let error: string | undefined;
    if (context.cancelled) {
      error = "Cancelado";
    } else if (outcome.timedOut) {
      error = `Timeout tras ${Math.round(definition.timeoutMs / 1000)} s`;
    } else if (!result) {
      error = `${agent} terminó (exit ${outcome.exitCode}) sin evento result. ${outcome.stderr.slice(-ERROR_TEXT_MAX)}`;
    } else if (!result.success) {
      const status = result.apiErrorStatus ? ` (HTTP ${result.apiErrorStatus})` : "";
      error = `${result.subtype}${status}: ${result.text.slice(0, ERROR_TEXT_MAX)}`;
    } else if (definition.schema && result.structuredOutput === undefined) {
      error = "El paso no devolvió la salida estructurada que exige su schema";
    }

    if (error) {
      stepRun.status = "failed";
      const limited = rejectedUntil !== undefined || result?.apiErrorStatus === 429;
      if (agent !== "claude") {
        // Their plans' windows are unknown to Nexura: no automatic wait, the user retries.
        stepRun.error = limited ? `Límite de uso de ${AGENT_LABELS[agent]}: reintenta más tarde o cambia de agente. ${error}` : error;
        return undefined;
      }
      stepRun.error = error;
      return limited ? (rejectedUntil ?? this.quota?.fiveHour?.resetsAt ?? Date.now() / 1000 + 300) : undefined;
    }
    stepRun.status = "succeeded";
    return undefined;
  }

  /** classify may pick any saved profile, including the ones created in the UI. */
  private classifySchema(schema: object | undefined): object | undefined {
    const properties = (schema as { properties?: Record<string, object> } | undefined)?.properties;
    if (!schema || !properties?.["profile"]) {
      return schema;
    }
    const profile = { ...properties["profile"], enum: [...this.config.profiles.keys()] };
    return { ...schema, properties: { ...properties, profile } };
  }

  private async runBuiltin(
    run: Run,
    stepRun: StepRun,
    stepContext: StepContext,
    definition: LoadedStep,
  ): Promise<unknown> {
    const emit = (event: NexuraEvent): void => this.recordEvent(run, stepRun, event);
    switch (stepRun.step) {
      case "qaCode": {
        const output = await runQaCode(
          run.worktrees,
          this.config.repos,
          stepContext.outputs.get("plan"),
          definition.timeoutMs,
          emit,
        );
        stepContext.ledger.append(
          "qaCode",
          output.passed
            ? `${output.commands} comando(s) OK`
            : `Fallan: ${output.failures.map((f) => `\`${f.command}\` (${f.repo})`).join(", ")}`,
        );
        return output;
      }
      case "release": {
        const output = await runReleaseLocal(run.worktrees, emit);
        stepContext.ledger.append(
          "release",
          output.branches.map((b) => `${b.repo}: rama \`${b.branch}\` @ ${b.sha.slice(0, 8)}`).join("\n"),
        );
        if (run.request.release !== "pr") {
          return output;
        }
        const withCommits = run.worktrees.filter((worktree) =>
          output.branches.some((branch) => branch.repo === worktree.repo && branch.commits.length > 0),
        );
        const pullRequests = await this.releasePullRequests(run, withCommits, stepContext, emit);
        return { ...output, pushed: pullRequests.length > 0, pullRequests };
      }
      default:
        throw new Error(`El paso ${stepRun.step} no tiene implementación builtin`);
    }
  }

  // ---------------------------------------------------------------- repo knowledge

  /** `{{repoMap}}` (from git, cached per commit) and `{{repoNotes}}` (learned in earlier tickets). */
  private async repoContextVars(run: Run): Promise<Record<string, string>> {
    const maps = await Promise.all(run.worktrees.map((worktree) => repoMap(worktree).catch(() => "")));
    const notes = run.worktrees
      .map((worktree) => {
        const text = readRepoNotes(worktree.repo).trim();
        return text ? `**${worktree.repo}**\n${text}` : "";
      })
      .filter(Boolean);
    return { repoMap: maps.filter(Boolean).join("\n\n"), repoNotes: notes.join("\n\n"), memory: await this.memoryVar(run) };
  }

  /** `{{memory}}`: what the shared memory has about the ticket and each repo. */
  private async memoryVar(run: Run): Promise<string> {
    if (!this.settings.memoryEnabled) {
      return "";
    }
    const title = run.request.ticketText.split(/\r?\n/)[0] ?? "";
    const parts = await Promise.all(
      run.worktrees.map(async (worktree) => {
        const text = readMemory(memoryStore(), await projectOf(worktree.repoPath), title);
        return text && run.worktrees.length > 1 ? `**${worktree.repo}**\n${text}` : text;
      }),
    );
    return parts.filter(Boolean).join("\n\n");
  }

  /** Saves to the shared memory; a failure there never fails the run. */
  private async remember(worktree: Worktree, entry: Omit<NewObservation, "project">): Promise<boolean> {
    if (!this.settings.memoryEnabled) {
      return false;
    }
    try {
      memoryStore().save({ ...entry, project: await projectOf(worktree.repoPath) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Keeps enrich's conventions for the primary repo, so the next ticket starts from them:
   * in the repo notes and in the shared memory as `pattern` observations (one topic per
   * convention, so learning it again updates it instead of duplicating it).
   */
  private async learnFromEnrich(run: Run, stepRun: StepRun): Promise<void> {
    const conventions = (stepRun.structuredOutput as { conventions?: string[] } | undefined)?.conventions ?? [];
    const primary = run.worktrees[0];
    if (!primary || conventions.length === 0) {
      return;
    }
    const learned = learnRepoNotes(primary.repo, conventions);
    if (learned > 0) {
      this.recordEvent(run, stepRun, {
        kind: "text",
        text: `Aprendidas ${learned} convención(es) nueva(s) de ${primary.repo}: se darán a los próximos tickets.`,
      });
    }
    for (const convention of conventions) {
      await this.remember(primary, {
        type: "pattern",
        title: convention.length > 80 ? convention.slice(0, 77) + "…" : convention,
        content: `**Qué**: ${convention}\n**Dónde**: ${primary.repo}\n**Aprendido**: convención detectada por enrich al resolver un ticket.`,
        topicKey: `conventions/${slugify(convention, 60)}`,
        source: "enrich",
        runId: run.id,
      });
    }
  }

  /**
   * Leaves a summary of the finished ticket in the shared memory (topic `tickets/<id>`, so a
   * re-run of the same ticket updates it): later tickets on the same code, addressReview and
   * the user's own sessions find what was done, where and why. No tokens: built from the outputs.
   */
  private async rememberRun(run: Run, stepContext: StepContext): Promise<void> {
    const primary = run.worktrees[0];
    if (!primary) {
      return;
    }
    const plan = stepContext.outputs.get("plan") as { approach?: string } | undefined;
    const implement = stepContext.outputs.get("implement") as { summary?: string; filesChanged?: string[]; notes?: string } | undefined;
    const review = stepContext.outputs.get("codeReview") as { verdict?: string; summary?: string } | undefined;
    const title = run.request.ticketText.split(/\r?\n/)[0]?.trim() || run.id;
    const loops = run.steps.filter((step) => step.step === "implement" && step.status === "succeeded").length - 1;
    const content = [
      `## Objetivo\n${run.request.ticketId ? `#${run.request.ticketId} ` : ""}${title}`,
      plan?.approach ? `## Enfoque\n${plan.approach}` : "",
      implement?.summary ? `## Hecho\n${implement.summary}` : "",
      implement?.notes ? `## Descubrimientos\n${implement.notes}` : "",
      review?.summary ? `## Revisión\n${review.verdict ?? ""}: ${review.summary}${loops > 0 ? ` (${loops} vuelta(s) a implement)` : ""}` : "",
      implement?.filesChanged?.length ? `## Ficheros\n${implement.filesChanged.map((file) => `- ${file}`).join("\n")}` : "",
      `## Ramas\n${run.worktrees.map((worktree) => `- ${worktree.repo}: ${worktree.branch}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const topicKey = `tickets/${run.request.ticketId ?? run.id}`;
    const saved = await this.remember(primary, {
      type: "ticket",
      title: (run.request.ticketId ? `Ticket #${run.request.ticketId}: ${title}` : `Ticket: ${title}`).slice(0, 120),
      content,
      topicKey,
      source: "nexura",
      runId: run.id,
    });
    if (saved) {
      stepContext.ledger.append("memoria", `Resumen del ticket guardado en la memoria compartida (\`${topicKey}\`).`);
    }
  }

  // ---------------------------------------------------------------- review feedback

  private async executeAddressReview(initial: Run, options?: RetryOptions): Promise<void> {
    const run = this.store.getRun(initial.id) ?? initial;
    const context = this.contexts.get(run.id)!;
    const ledger = new Ledger(run.id);
    run.status = "running";
    this.persist(run);
    try {
      const threads = await this.reviewThreads(run.id);
      if (threads.length === 0) {
        ledger.append("addressReview", "Sin hilos activos en la PR: nada que atender.");
        this.finishRun(run, context);
        return;
      }

      const profile = run.resolvedProfile ? this.config.profiles.get(run.resolvedProfile) : undefined;
      const stepConfig = profile?.steps.addressReview ?? DEFAULT_ADDRESS_REVIEW;
      const stepContext: StepContext = { outputs: new Map(), ledger, extraVars: { threads: threadsToText(threads), memory: await this.memoryVar(run) } };
      const stepRun = await this.runWithRateLimit(run, context, "addressReview", stepConfig, stepContext, options);
      if (!stepRun) {
        return;
      }
      const output = stepRun.structuredOutput as { summary: string; commitMessage: string; replies: ReviewReply[] };

      const commits: string[] = [];
      if (output.commitMessage.trim()) {
        for (const worktree of run.worktrees) {
          const sha = await commitAll(worktree, output.commitMessage);
          if (sha) {
            commits.push(`${worktree.repo}@${sha.slice(0, 8)}`);
            this.recordEvent(run, stepRun, { kind: "text", text: `Commit \`${sha.slice(0, 8)}\` en ${worktree.repo}` });
          }
        }
      }
      // Only answer threads that exist; the model cannot invent targets.
      const known = new Set(threads.map((thread) => `${thread.repo}:${thread.threadId}`));
      const replies = output.replies.filter((reply) => known.has(`${reply.repo}:${reply.threadId}`));
      ledger.append(
        "addressReview",
        [output.summary, `Commits: ${commits.join(", ") || "sin cambios de código"}`, `Respuestas: ${replies.length} de ${threads.length} hilos`].join("\n"),
      );

      const approved = await this.awaitReplyApproval(run, replies, commits);
      if (!approved) {
        ledger.append("addressReview", "Push y respuestas descartados por el usuario; los commits quedan en local.");
        this.finishRun(run, context);
        return;
      }
      for (const worktree of run.worktrees) {
        if (commits.some((commit) => commit.startsWith(`${worktree.repo}@`))) {
          await pushBranch(worktree);
        }
      }
      for (const reply of approved) {
        const pr = run.pullRequests?.find((candidate) => candidate.repo === reply.repo);
        const worktree = run.worktrees.find((candidate) => candidate.repo === reply.repo);
        if (pr && worktree) {
          await replyToThread(worktree, pr.id, reply);
          this.recordEvent(run, stepRun, { kind: "text", text: `Respondido el hilo ${reply.threadId} (${reply.action}): ${reply.reply}` });
        }
      }
      ledger.append("addressReview", `Push hecho y ${approved.length} hilo(s) respondido(s).`);
      this.finishRun(run, context);
    } catch (error) {
      if (error instanceof CancelledError || context.cancelled) {
        run.status = "cancelled";
        run.pendingStep = undefined;
        this.releaseContext(run.id, context);
        this.persist(run);
      } else {
        this.fail(run, `addressReview: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Pauses on the drafted replies (editable, removable) and the local commits. */
  private async awaitReplyApproval(run: Run, replies: ReviewReply[], commits: string[]): Promise<ReviewReply[] | undefined> {
    const context = this.contexts.get(run.id)!;
    run.status = "paused";
    run.pendingStep = { step: "addressReview", replies, commits };
    this.persist(run);
    const options = await new Promise<RetryOptions | undefined>((resolve) => (context.release = resolve));
    context.release = undefined;
    if (context.cancelled) {
      throw new CancelledError();
    }
    run.status = "running";
    run.pendingStep = undefined;
    this.persist(run);
    if (options?.skip) {
      return undefined;
    }
    if (!options?.replies) {
      return replies;
    }
    // Edited text/action only for threads that were drafted; dropped ones are not answered.
    return options.replies
      .map((edited) => {
        const original = replies.find((reply) => reply.repo === edited.repo && reply.threadId === edited.threadId);
        return original ? { ...original, reply: edited.reply.trim() || original.reply, action: edited.action } : undefined;
      })
      .filter((reply): reply is ReviewReply => reply !== undefined);
  }

  private finishRun(run: Run, context: RunContext): void {
    run.status = "done";
    run.pendingStep = undefined;
    this.releaseContext(run.id, context);
    this.persist(run);
  }

  // ---------------------------------------------------------------- pull requests

  /**
   * Builds the PR drafts, pauses for the go-ahead (nothing is pushed before it, as the
   * create-pr skill requires), then pushes and opens each PR. Returns the created PRs.
   */
  private async releasePullRequests(
    run: Run,
    worktrees: Run["worktrees"],
    stepContext: StepContext,
    emit: (event: NexuraEvent) => void,
  ): Promise<CreatedPr[]> {
    const implementOutputs = run.steps
      .filter((step) => step.step === "implement" && step.status === "succeeded")
      .map((step) => step.structuredOutput as { summary: string; filesChanged: string[] });
    const drafts = await Promise.all(
      worktrees.map((worktree) => {
        const target = this.config.repos.find((repo) => repo.name === worktree.repo)?.baseBranch ?? worktree.baseRef;
        return buildPrDraft(worktree, target, implementOutputs, run.request);
      }),
    );

    emit({ kind: "text", text: `Esperando tu aprobación para hacer push y abrir ${drafts.length} PR(s).` });
    const approved = await this.awaitPrApproval(run, drafts);
    if (!approved) {
      emit({ kind: "text", text: "PR descartada: las ramas se quedan en local." });
      stepContext.ledger.append("release", "PR no creada por decisión del usuario; ramas en local.");
      return [];
    }

    const created: CreatedPr[] = [];
    for (const draft of approved) {
      const worktree = worktrees.find((candidate) => candidate.repo === draft.repo)!;
      const toolId = `pr-${draft.repo}`;
      emit({
        kind: "toolUse",
        id: toolId,
        name: draft.provider === "github" ? "GitHub" : "AzureDevOps",
        input: { push: draft.branch, target: draft.target, title: draft.title, workItem: draft.workItemId },
        parentToolUseId: null,
      });
      const pr = await pushAndCreatePr(worktree, draft);
      emit({ kind: "toolResult", toolUseId: toolId, content: `PR #${pr.id} creada: ${pr.url}`, isError: false, parentToolUseId: null });
      created.push(pr);
      run.pullRequests = [...(run.pullRequests ?? []), pr];
      this.persist(run);
    }
    stepContext.ledger.append("release", created.map((pr) => `${pr.repo}: PR #${pr.id} ${pr.url}`).join("\n"));
    return created;
  }

  /** Pauses on the drafts. Only title, description, target and the draft flag can be edited. */
  private async awaitPrApproval(run: Run, drafts: PrDraft[]): Promise<PrDraft[] | undefined> {
    const context = this.contexts.get(run.id)!;
    run.status = "paused";
    run.pendingStep = { step: "release", prDrafts: drafts };
    this.persist(run);
    const options = await new Promise<RetryOptions | undefined>((resolve) => (context.release = resolve));
    context.release = undefined;
    if (context.cancelled) {
      throw new CancelledError();
    }
    run.status = "running";
    run.pendingStep = undefined;
    this.persist(run);
    if (options?.skip) {
      return undefined;
    }
    return drafts.map((draft) => {
      const edited = options?.prDrafts?.find((candidate) => candidate.repo === draft.repo);
      if (!edited) {
        return draft;
      }
      return {
        ...draft,
        title: edited.title.trim() || draft.title,
        description: edited.description,
        target: edited.target.trim() || draft.target,
        isDraft: Boolean(edited.isDraft),
      };
    });
  }

  // ---------------------------------------------------------------- helpers

  private async setupWorktrees(run: Run, ledger: Ledger): Promise<void> {
    const firstLine = run.request.ticketText.split(/\r?\n/)[0] ?? "";
    for (const name of run.request.repos) {
      const repo = this.config.repos.find((candidate) => candidate.name === name)!;
      const branch = `${repo.branchPrefix ?? DEFAULT_BRANCH_PREFIX}/${run.request.ticketId ?? run.id}-${slugify(firstLine)}`;
      run.worktrees.push(await createWorktree(repo, run.id, branch));
      this.persist(run);
    }
    ledger.append(
      "setup",
      run.worktrees.map((w) => `${w.repo}: worktree \`${w.path}\`, rama \`${w.branch}\` desde \`${w.baseRef}\``).join("\n"),
    );
  }

  private async afterImplement(run: Run, stepRun: StepRun, ledger: Ledger): Promise<void> {
    const output = stepRun.structuredOutput as {
      summary: string;
      commitMessage: string;
      tasksDone: string[];
      filesChanged: string[];
      notes: string;
    };
    const shas: string[] = [];
    for (const worktree of run.worktrees) {
      const sha = await commitAll(worktree, output.commitMessage);
      if (sha) {
        shas.push(`${worktree.repo}@${sha.slice(0, 8)}`);
        this.recordEvent(run, stepRun, { kind: "text", text: `Commit \`${sha.slice(0, 8)}\` en ${worktree.repo}` });
      }
    }
    for (const task of run.request.tasks) {
      if (output.tasksDone.includes(task.id)) {
        task.done = true;
      }
    }
    ledger.append(
      `implement (intento ${stepRun.attempt})`,
      [
        output.summary,
        `Ficheros: ${output.filesChanged.join(", ") || "ninguno"}`,
        `Commits: ${shas.join(", ") || "sin cambios"}`,
        output.notes ? `Notas: ${output.notes}` : "",
      ].join("\n"),
    );
    this.persist(run);
  }

  /** A custom step's answer goes to the ledger; whatever it changed in the worktrees is committed. */
  private async afterCustomStep(run: Run, stepRun: StepRun, ledger: Ledger): Promise<void> {
    const label = this.config.steps.get(stepRun.step)?.label ?? stepRun.step;
    const shas: string[] = [];
    for (const worktree of run.worktrees) {
      const sha = await commitAll(worktree, `chore: ${label} (nexura)`);
      if (sha) {
        shas.push(`${worktree.repo}@${sha.slice(0, 8)}`);
        this.recordEvent(run, stepRun, { kind: "text", text: `Commit \`${sha.slice(0, 8)}\` en ${worktree.repo}` });
      }
    }
    const output = stepRun.structuredOutput;
    const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
    ledger.append(`${label} (intento ${stepRun.attempt})`, [text.slice(0, 2000), shas.length ? `Commits: ${shas.join(", ")}` : ""].filter(Boolean).join("\n"));
  }

  private reworkNeeded(stepName: StepName, output: unknown): string | undefined {
    if (stepName === "codeReview") {
      const review = output as { verdict: string; issues: { severity: string; file: string; problem: string; fix: string }[] };
      if (review.verdict !== "changes") {
        return undefined;
      }
      return review.issues
        .filter((issue) => issue.severity !== "minor")
        .map((issue) => `- [${issue.severity}] ${issue.file}: ${issue.problem} → ${issue.fix}`)
        .join("\n");
    }
    if (stepName === "qaCode") {
      const qa = output as QaOutput;
      if (qa.passed) {
        return undefined;
      }
      return qa.failures
        .map((f) => `- \`${f.command}\` en ${f.repo} (exit ${f.exitCode}):\n\`\`\`\n${f.outputTail.slice(-1500)}\n\`\`\``)
        .join("\n");
    }
    return undefined;
  }

  private renderPrompt(run: Run, stepName: StepName, stepContext: StepContext): string {
    const definition = this.config.steps.get(stepName);
    const template = definition?.promptTemplate ?? "";
    const request = run.request;
    const vars: Record<string, string | undefined> = {
      ticket: (request.ticketId ? `#${request.ticketId}\n\n` : "") + request.ticketText,
      tasks: request.tasks
        .filter((task) => task.selected)
        .map((task) => `- [${task.done ? "x" : " "}] (${task.id}) ${task.title}`)
        .join("\n"),
      repos: run.worktrees
        .map((w) => `- **${w.repo}**: \`${w.path}\` (rama \`${w.branch}\`, baseRef \`${w.baseRef}\`)`)
        .join("\n"),
      userPrompt: request.prompt,
      profiles: [...this.config.profiles.values()].map((profile) => `- **${profile.name}**: ${profile.description}`).join("\n"),
      ledger: stepContext.ledger.read(),
      feedback: stepContext.feedback,
      ...stepContext.extraVars,
    };
    // Memory "off" means off: no memory in the prompt either.
    if (!definition?.memory || definition.memory === "off") {
      vars["memory"] = undefined;
    }
    for (const [name, output] of stepContext.outputs) {
      vars[`output.${name}`] = asJsonBlock(output);
    }
    return renderTemplate(template, vars);
  }

  private async breakpoint(
    run: Run,
    context: RunContext,
    stepName: StepName,
    stepContext: StepContext,
    pending?: RetryOptions,
  ): Promise<RetryOptions | undefined> {
    const kind = this.config.steps.get(stepName)?.kind;
    run.status = "paused";
    run.pendingStep = {
      step: stepName,
      prompt: kind === "claude" ? (pending?.prompt ?? this.renderPrompt(run, stepName, stepContext)) : undefined,
    };
    this.persist(run);
    const options = await new Promise<RetryOptions | undefined>((resolve) => (context.release = resolve));
    context.release = undefined;
    if (context.cancelled) {
      throw new CancelledError();
    }
    run.status = "running";
    run.pendingStep = undefined;
    this.persist(run);
    return options;
  }

  private recordSkipped(run: Run, stepName: StepName, profile: FlowProfile): void {
    const config = profile.steps[stepName];
    const stepRun: StepRun = {
      id: randomUUID(),
      runId: run.id,
      step: stepName,
      attempt: run.steps.filter((s) => s.step === stepName).length + 1,
      seq: run.steps.length,
      status: "skipped",
      kind: this.config.steps.get(stepName)?.kind ?? "claude",
      ...(this.config.steps.get(stepName)?.kind === "builtin" ? {} : { agent: agentOf(config) }),
      model: config?.model ?? "haiku",
      effort: config?.effort ?? "low",
      costUsd: 0,
      numTurns: 0,
    };
    run.steps.push(stepRun);
    this.store.saveStepRun(stepRun);
    this.persist(run);
  }

  private sleepUntil(context: RunContext, epochMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, epochMs - Date.now()));
      context.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private recordEvent(run: Run, stepRun: StepRun, event: NexuraEvent): void {
    const seq = this.eventSeq.get(stepRun.id) ?? 0;
    this.eventSeq.set(stepRun.id, seq + 1);
    const ts = new Date().toISOString();
    this.store.addEvent(run.id, stepRun, seq, event, ts);
    this.emit("message", { type: "event", runId: run.id, stepRunId: stepRun.id, seq, ts, event });
  }

  private updateQuota(event: Extract<NexuraEvent, { kind: "rateLimit" }>): void {
    this.quota = {
      status: event.status,
      fiveHour: event.fiveHour,
      sevenDay: event.sevenDay,
      updatedAt: new Date().toISOString(),
    };
    this.store.setSetting(QUOTA_KEY, this.quota);
    this.emit("message", { type: "quota", quota: this.quota });
  }

  private fail(run: Run, error: string): void {
    run.status = "failed";
    run.error = error;
    run.pendingStep = undefined;
    run.resumesAt = undefined;
    this.releaseContext(run.id, this.contexts.get(run.id));
    this.persist(run);
  }

  /** Forgets the run context, unless a retry already replaced it with a new one. */
  private releaseContext(runId: string, context: RunContext | undefined): void {
    if (context && this.contexts.get(runId) === context) {
      this.contexts.delete(runId);
    }
  }

  private persist(run: Run): void {
    this.store.saveRun(run);
    this.emit("message", { type: "run", run: structuredClone(run) });
  }

  private requireRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run no encontrado: ${runId}`);
    }
    return run;
  }
}
