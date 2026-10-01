import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AGENT_MODELS,
  agentOf,
  PR_VOTES,
  DEFAULT_SETTINGS,
  orderSteps,
  quotaPauseUntil,
  type AgentAccountUsage,
  type AgentKind,
  type CreatedPr,
  type FlowProfile,
  type JudgeConfig,
  type NexuraEvent,
  type NexuraSettings,
  type PrDraft,
  type PrReviewPublish,
  type PrReviewTarget,
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
import { asJsonBlock, continuationTemplate, renderTemplate } from "../prompt/render.ts";
import { AgentProcess } from "../runner/agent-process.ts";
import { maxUsage, parseLine, StreamUsage, usageBeyond } from "../runner/stream-parser.ts";
import type { RunStore } from "../store/run-store.ts";
import { commitAll, createPrWorktree, createWorktree, git, gitRaw, removeWorktree, slugify } from "../workspace/git.ts";
import { learnRepoNotes, readRepoNotes, repoMap } from "../workspace/repo-context.ts";
import { isMemoryWrite, MEMORY_SERVER, memoryRunOptions, memoryStore, readMemory } from "../memory/memory.ts";
import { projectOf, type NewObservation } from "../memory/memory-store.ts";
import {
  buildPrDraft,
  getActiveThreads,
  listPullRequests,
  publishReview,
  pushAndCreatePr,
  pushBranch,
  replyToThread,
  requireRemote,
  threadsToText,
} from "../forge/forge.ts";
import { normalizePrReview, normalizeReviewPath, parseDiffHunks, reviewPosts, type PrReviewOutput } from "./pr-review.ts";
import { mergeJudgments, type CodeReviewOutput, type ReviewIssue } from "./blind-review.ts";
import { runQaCode, runReleaseLocal, type QaOutput } from "./builtin-steps.ts";
import {
  cacheContinuity,
  contextTooLarge,
  continuesMainSession,
  correctionSession,
  fingerprint,
  mainSessionEnvelope,
  phaseOutput,
  sessionSchema,
  observeContext,
  resolveStepMcp,
  type SessionEnvelope,
} from "./context-policy.ts";

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

/** Where the prReview step finds the PR's diff and commits (inside its worktree, removed with it). */
const PR_REVIEW_DIR = ".nexura-review";

/** `{{pr}}` of the prReview step. */
function prReviewText(target: PrReviewTarget, headSha: string, neutralized: string[]): string {
  return [
    `- **PR #${target.id}**: ${target.title}${target.isDraft ? " (borrador)" : ""}`,
    `- Autor: ${target.author || "desconocido"}`,
    `- Ramas: \`${target.sourceBranch}\` → \`${target.targetBranch}\``,
    `- Commit revisado: \`${headSha}\``,
    `- ${target.provider === "github" ? "GitHub" : "Azure DevOps"}: ${target.url}`,
    `- Diff completo: \`${PR_REVIEW_DIR}/pr.diff\`; commits: \`${PR_REVIEW_DIR}/commits.txt\``,
    ...(neutralized.length
      ? [
          `- La PR cambia configuración de agentes (${neutralized.join(", ")}): en tu checkout está la versión de \`${target.targetBranch}\`; sus cambios se ven en el diff y se revisan como el resto.`,
        ]
      : []),
  ].join("\n");
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
  /** Takes the run out of the concurrency queue (a cancel before it got a slot). */
  dequeue?: () => void;
};

type StepContext = {
  outputs: Map<StepName, unknown>;
  feedback?: string;
  ledger: Ledger;
  /** Step-specific template variables, e.g. `threads` for addressReview. */
  extraVars?: Record<string, string>;
};

/** Steps that never run in the profile sequence: they are launched on demand. */
const ON_DEMAND_STEPS: ReadonlySet<StepName> = new Set(["classify", "addressReview", "prReview"]);
const DEFAULT_ADDRESS_REVIEW: StepConfig = { agent: "claude", model: "sonnet", effort: "medium", enabled: true };
/** Reviewing someone else's PR reads a lot of code: a strong model by default, overridable per review. */
export const DEFAULT_PR_REVIEW: StepConfig = { agent: "claude", model: "sonnet", effort: "high", enabled: true };
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh"];
/** Template variables a continued session already has from its first phase: they are not sent again. */
const SESSION_CONTEXT_VARS: readonly string[] = ["ticket", "tasks", "repos", "repoMap", "repoNotes", "memory", "userPrompt", "profiles"];

/** What Revisiones sends to review one PR. */
export type PrReviewRequest = { repo: string; prId: number; agent?: AgentKind; model?: string; effort?: StepConfig["effort"] };

type StepOutcome = { stepRun: StepRun; rateLimitedUntil?: number };

export type OrchestratorOptions = {
  concurrency: number;
  /** Extra wait after a window reset before retrying (default 60 s; tests use 0). */
  rateLimitMarginMs?: number;
  /** Codex/Copilot plan usage for the quota pause (the server passes the real reader; without it only Claude pauses). */
  accountUsage?: () => Promise<AgentAccountUsage>;
};

const SETTINGS_KEY = "settings";
const MIN_PR_POLL_SECONDS = 30;

/**
 * The files a step works on, as far as the earlier outputs tell (enrich's relevant files,
 * plan's changes, implement's changed files): `{{memory}}` brings what was learned about them.
 */
function memoryFiles(stepContext: StepContext | undefined): { repo?: string; path: string }[] {
  if (!stepContext) {
    return [];
  }
  const enrich = stepContext.outputs.get("enrich") as { relevantFiles?: { repo?: string; path?: string }[] } | undefined;
  const plan = stepContext.outputs.get("plan") as { changes?: { repo?: string; path?: string }[] } | undefined;
  const implement = stepContext.outputs.get("implement") as { filesChanged?: string[] } | undefined;
  const files: { repo?: string; path?: string }[] = [
    ...(implement?.filesChanged ?? []).map((path) => ({ path })),
    ...(plan?.changes ?? []),
    ...(enrich?.relevantFiles ?? []),
  ];
  return files.flatMap((file) => (typeof file.path === "string" && file.path ? [{ ...(file.repo ? { repo: file.repo } : {}), path: file.path }] : []));
}

export class Orchestrator extends EventEmitter<{ message: [ServerMessage]; settings: [NexuraSettings] }> {
  private config: NexuraConfig;
  private readonly store: RunStore;
  private readonly options: OrchestratorOptions;
  private readonly contexts = new Map<string, RunContext>();
  private readonly waiting: (() => void)[] = [];
  private readonly eventSeq = new Map<string, number>();
  /** PR reviews whose comments are being posted (a double click must not post them twice). */
  private readonly publishing = new Set<string>();
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

  /** A configured repo by name (the review follow-up needs its folder). */
  public repo(name: string): NexuraConfig["repos"][number] | undefined {
    return this.config.repos.find((repo) => repo.name === name);
  }

  /** Small out-of-band updates (e.g. reviewWatch, a review's follow-up) on a run that is not executing. */
  public patchRun(runId: string, patch: Partial<Pick<Run, "reviewWatch" | "prReview">>): void {
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
    if (request.modelConfig) {
      if (request.profile === "auto") {
        throw new Error("Elige un plan concreto para usar un único modelo");
      }
      checkOverrides(request.modelConfig, "claude");
      if (!EFFORTS.includes(request.modelConfig.effort)) {
        throw new Error(`Esfuerzo desconocido: ${String(request.modelConfig.effort)}`);
      }
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
    void this.schedule(runId, () => {
      if (run.request.kind === "prReview") {
        return this.executePrReview(run, options);
      }
      return last?.step === "addressReview"
        ? this.executeAddressReview(run, options)
        : this.execute(run, last ? { step: last.step, options } : undefined);
    });
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

  /**
   * Queues the review of an open PR of a configured repo (Revisiones). It runs like any flow
   * (same concurrency, events, cancel and retry) with the single prReview step; nothing is
   * posted to the PR until the user publishes the comments they pick.
   */
  public async startPrReview(input: PrReviewRequest): Promise<Run> {
    const repo = this.config.repos.find((candidate) => candidate.name === input.repo);
    if (!repo) {
      throw new Error(`Repositorio no configurado en repos.json: ${String(input.repo)}`);
    }
    const prId = Number(input.prId);
    if (!Number.isInteger(prId) || prId <= 0) {
      throw new Error(`Número de PR no válido: ${String(input.prId)}`);
    }
    checkOverrides({ agent: input.agent, model: input.model }, agentOf(DEFAULT_PR_REVIEW));
    if (input.effort !== undefined && !EFFORTS.includes(input.effort)) {
      throw new Error(`Esfuerzo desconocido: ${String(input.effort)}`);
    }
    const agent = input.agent ?? agentOf(DEFAULT_PR_REVIEW);
    const reviewConfig: StepConfig = {
      agent,
      model: input.model ?? (agent === agentOf(DEFAULT_PR_REVIEW) ? DEFAULT_PR_REVIEW.model : AGENT_MODELS[agent][0]!),
      effort: input.effort ?? DEFAULT_PR_REVIEW.effort,
      enabled: true,
    };
    const reviewing = [...this.contexts.keys()].some((id) => {
      const active = this.store.getRun(id)?.request;
      return active?.kind === "prReview" && active.repos[0] === repo.name && active.prReview?.id === prId;
    });
    if (reviewing) {
      throw new Error(`Ya hay una revisión en curso de la PR #${prId}`);
    }

    const location = { repo: repo.name, repoPath: repo.path };
    const remote = await requireRemote(location);
    const pr = (await listPullRequests(location)).find((candidate) => candidate.id === prId);
    if (!pr) {
      throw new Error(`La PR #${prId} no está abierta en ${repo.name}`);
    }
    const target: PrReviewTarget = {
      id: pr.id,
      title: pr.title,
      author: pr.author,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      isDraft: pr.isDraft,
      url: pr.url,
      headSha: pr.headSha,
      provider: remote.provider,
    };
    const run: Run = {
      id: randomUUID().slice(0, 8),
      request: {
        kind: "prReview",
        ticketText: [pr.title, pr.description.trim()].filter(Boolean).join("\n\n"),
        repos: [repo.name],
        tasks: [],
        prompt: "",
        profile: "prReview",
        stepByStep: false,
        prReview: target,
        reviewConfig,
      },
      status: "queued",
      createdAt: new Date().toISOString(),
      steps: [],
      worktrees: [],
      totalCostUsd: 0,
    };
    this.persist(run);
    this.contexts.set(run.id, { cancelled: false });
    void this.schedule(run.id, () => this.executePrReview(run));
    return run;
  }

  /**
   * Posts the comments the user picked (with their edited text) and the vote, once. Only
   * comments of the review can be posted, anchored where the review put them. The PR is
   * checked again first: no vote on commits nobody reviewed, and on Azure DevOps (whose
   * threads anchor to the latest iteration) no anchoring on lines that may have moved.
   */
  public async publishPrReview(runId: string, publish: PrReviewPublish): Promise<Run> {
    const run = this.requireRun(runId);
    const target = run.request.prReview;
    const review = run.prReview;
    if (run.request.kind !== "prReview" || !target || !review) {
      throw new Error("Este flujo no es una revisión de PR terminada");
    }
    if (this.contexts.has(runId) || this.publishing.has(runId)) {
      throw new Error("La revisión está en marcha o publicándose");
    }
    if (review.published) {
      throw new Error("Esta revisión ya se publicó en la PR");
    }
    if (publish.vote !== undefined && !PR_VOTES.includes(publish.vote)) {
      throw new Error(`Voto desconocido: ${String(publish.vote)}`);
    }
    const repo = this.config.repos.find((candidate) => candidate.name === run.request.repos[0]);
    if (!repo) {
      throw new Error(`Repositorio no configurado en repos.json: ${run.request.repos[0]}`);
    }
    const location = { repo: repo.name, repoPath: repo.path };
    // Comments a failed publish already left on the PR are not posted again.
    const already = new Set(review.postedIds ?? []);
    const selection = (Array.isArray(publish.comments) ? publish.comments : []).filter((item) => !already.has(item.id));

    this.publishing.add(runId);
    try {
      const current = (await listPullRequests(location)).find((candidate) => candidate.id === target.id);
      if (!current) {
        throw new Error(`La PR #${target.id} ya no está abierta`);
      }
      const moved = Boolean(current.headSha) && current.headSha !== review.headSha;
      if (moved && publish.vote) {
        throw new Error(
          `La PR #${target.id} tiene commits nuevos desde la revisión: no se vota sobre código sin revisar. Vuelve a revisarla o publica los comentarios sin voto.`,
        );
      }
      const provider = (await requireRemote(location)).provider;
      // Checked before posting anything: Azure DevOps rejects the vote only after the comments are up.
      if (publish.vote && provider === "azure" && current.isDraft) {
        throw new Error(`La PR #${target.id} es un borrador y Azure DevOps no admite votos en borradores. Publica los comentarios sin voto, o márcala como lista para revisión y vuelve a publicar.`);
      }
      // GitHub pins the review to the reviewed commit; Azure DevOps would anchor on the new one.
      const posts = reviewPosts(review, selection, !(moved && provider === "azure"));
      // A publish that failed after posting every comment (e.g. at the vote) only needs closing off.
      const alreadyAll = Array.isArray(publish.comments) && publish.comments.length > 0 && publish.comments.every((item) => already.has(item.id));
      if (posts.length === 0 && !publish.vote && !alreadyAll) {
        throw new Error("Elige al menos un comentario o un voto");
      }
      if (posts.length > 0 || publish.vote) {
        await publishReview(location, { id: target.id, headSha: review.headSha }, posts, publish.vote, (post) => {
          if (post.commentId !== undefined) {
            review.postedIds = [...(review.postedIds ?? []), post.commentId];
            this.persist(run);
          }
        });
      }
    } finally {
      this.publishing.delete(runId);
    }
    const posted = new Set(review.postedIds ?? []);
    review.published = {
      commentIds: review.comments.filter((comment) => posted.has(comment.id)).map((comment) => comment.id),
      vote: publish.vote,
      at: new Date().toISOString(),
    };
    this.persist(run);
    return run;
  }

  /**
   * Adds the conventions a review found to the repo notes, which later steps (with write
   * access) read. Only on the user's word: they come from reading a PR anyone may open.
   */
  public learnPrReviewConventions(runId: string): Run {
    const run = this.requireRun(runId);
    const review = run.prReview;
    if (run.request.kind !== "prReview" || !review) {
      throw new Error("Este flujo no es una revisión de PR terminada");
    }
    if (review.conventions.length && !review.conventionsSaved) {
      learnRepoNotes(run.request.repos[0]!, review.conventions);
    }
    review.conventionsSaved = true;
    this.persist(run);
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
    context.dequeue?.();
    context.process?.kill();
    context.release?.();
    context.wake?.();
  }

  /** Whether the run is executing a step or waiting for the user (it cannot be cleaned or deleted). */
  public isActive(runId: string): boolean {
    return this.contexts.has(runId);
  }

  public async cleanup(runId: string, deleteBranches = false): Promise<void> {
    const run = this.requireRun(runId);
    if (this.contexts.has(runId)) {
      throw new Error("No se puede limpiar un run activo");
    }
    await this.removeWorktrees(run, deleteBranches);
  }

  /**
   * Forgets a finished run: history, events and logs, plus its worktrees. Branches with
   * commits stay (they may back a PR); `deleteBranches` removes them too. When a worktree
   * cannot be removed the run stays, so that it can be retried instead of orphaning it.
   */
  public async deleteRun(runId: string, deleteBranches = false): Promise<void> {
    const run = this.requireRun(runId);
    if (this.contexts.has(runId)) {
      throw new Error("El flujo está activo: cancélalo antes de borrarlo");
    }
    await this.removeWorktrees(run, deleteBranches);
    for (const step of run.steps) {
      this.eventSeq.delete(step.id);
    }
    this.store.deleteRun(runId);
    this.emit("message", { type: "runDeleted", runId });
  }

  /** Removes the run's worktrees one by one, persisting the ones that are gone even if a later one fails. */
  private async removeWorktrees(run: Run, deleteBranches: boolean): Promise<void> {
    try {
      for (const worktree of [...run.worktrees]) {
        await removeWorktree(worktree, deleteBranches);
        run.worktrees = run.worktrees.filter((candidate) => candidate !== worktree);
      }
    } finally {
      this.persist(run);
    }
  }

  // ---------------------------------------------------------------- scheduling

  private async schedule(runId: string, job: () => Promise<void>): Promise<void> {
    const context = this.contexts.get(runId);
    if (this.running >= this.options.concurrency) {
      const slot = await new Promise<boolean>((resolve) => {
        const take = (): void => resolve(true);
        this.waiting.push(take);
        if (context) {
          context.dequeue = () => {
            const index = this.waiting.indexOf(take);
            if (index >= 0) {
              this.waiting.splice(index, 1);
              resolve(false);
            }
          };
        }
      });
      if (context) {
        context.dequeue = undefined;
      }
      // Cancelled while queued: it ends right away, without taking (or handing on) a slot.
      if (!slot) {
        const run = this.store.getRun(runId);
        this.releaseContext(runId, context);
        if (run) {
          run.status = "cancelled";
          run.resumesAt = undefined;
          this.persist(run);
        }
        return;
      }
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
      const lastCorrection = run.steps.findLast((step) => step.status === "succeeded" && Boolean(this.reworkNeeded(step.step, step.structuredOutput)));
      if (lastCorrection && !run.steps.some((step) => step.step === "implement" && step.status === "succeeded" && step.seq > lastCorrection.seq)) {
        stepContext.feedback = this.reworkNeeded(lastCorrection.step, lastCorrection.structuredOutput);
      }
      let pending = startAt?.options;

      if (!run.resolvedProfile) {
        const classified = await this.runWithRateLimit(run, context, "classify", CLASSIFY_CONFIG, stepContext, pending);
        pending = undefined;
        if (!classified) {
          return;
        }
        const output = classified.structuredOutput as { profile: string; reason: string };
        if (!this.config.profiles.has(output.profile) || this.config.profiles.get(output.profile)?.autoSelect === false) {
          this.fail(run, `classify eligió un perfil inexistente o de selección manual: ${output.profile}`);
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
      /** Where a one-off qaCode was inserted after a late custom writer; it leaves the sequence once it ran or was skipped. */
      let lateQa: number | undefined;
      const dropLateQa = (): boolean => {
        if (index !== lateQa) {
          return false;
        }
        sequence.splice(index, 1);
        lateQa = undefined;
        return true;
      };

      while (index < sequence.length) {
        const stepName = sequence[index]!;
        const stepConfig = run.request.modelConfig && this.config.steps.get(stepName)?.kind !== "builtin"
          ? { ...profile.steps[stepName]!, ...run.request.modelConfig }
          : profile.steps[stepName]!;

        const memoryMode = this.config.steps.get(stepName)?.memory;
        stepContext.extraVars = {
          ...stepContext.extraVars,
          memory: memoryMode && memoryMode !== "off" ? await this.memoryVar(run, stepName, stepContext) : "",
        };

        if (run.request.stepByStep) {
          pending = (await this.breakpoint(run, context, stepName, stepContext, pending)) ?? pending;
          if (pending?.skip) {
            this.recordSkipped(run, stepName, profile);
            pending = undefined;
            if (!dropLateQa()) {
              index++;
            }
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
        if (stepName === "enrich" || stepName === "plan") {
          await this.learnConventions(run, stepRun);
        }
        if (this.config.steps.get(stepName)?.custom) {
          const changed = await this.afterCustomStep(run, stepRun, ledger);
          const qaIndex = sequence.indexOf("qaCode");
          if (changed && qaIndex >= 0 && index > qaIndex && sequence[index + 1] !== "qaCode") {
            // A late custom writer invalidates earlier QA; verify it before going on.
            sequence.splice(index + 1, 0, "qaCode");
            lateQa = index + 1;
          }
        }

        const ranLateQa = dropLateQa();
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
        if (!ranLateQa) {
          index++;
        }
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
    const agent = this.config.steps.get(stepName)?.kind === "builtin" ? undefined : (options?.agent ?? agentOf(stepConfig));
    for (;;) {
      // A cancel while the run got ready (checkout, diff, PR threads) had no process to kill.
      if (context.cancelled) {
        throw new CancelledError();
      }
      // Don't start an LLM step while its agent's quota is above the user's threshold.
      const guardedUntil = agent ? await this.quotaGuardUntil(agent) : undefined;
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

  /** The same quota pause, for agent work outside the flows (the Tickets assistant). */
  public quotaPauseFor(agent: AgentKind): Promise<number | undefined> {
    return this.quotaGuardUntil(agent);
  }

  /** Epoch seconds of the agent's quota reset when its usage is at/above the configured %, else undefined. */
  private async quotaGuardUntil(agent: AgentKind): Promise<number | undefined> {
    const limit = this.settings.quotaPausePercent;
    if (limit === null) {
      return undefined;
    }
    // Claude's window comes with every stream; Codex and Copilot only report theirs through the account helpers.
    const account = agent === "claude" || !this.options.accountUsage ? undefined : await this.options.accountUsage().catch(() => undefined);
    return quotaPauseUntil(agent, limit, this.quota, account);
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
    let previous = options?.resumeSession
      ? run.steps.findLast((s) => s.step === stepRun.step && s.id !== stepRun.id && s.sessionId && agentOf(s) === agent)
      : undefined;
    let sessionDecision = previous ? "reanudación solicitada" : "sesión nueva";
    let automaticResume = false;
    let continuedStep = false;
    if (!options?.resumeSession && options?.resumeSession !== false && !options?.prompt && stepRun.step === "implement" && stepContext.feedback) {
      const decision = correctionSession(run.steps.findLast((s) => s.step === "implement" && s.id !== stepRun.id), stepRun);
      previous = decision.previous;
      sessionDecision = decision.reason;
      automaticResume = Boolean(previous);
    }
    // The main work keeps its context across phases and model changes within one provider.
    // A reviewer starts fresh; after review, the main work continues from its own session.
    if (!previous && options?.resumeSession === undefined && !options?.prompt && !stepContext.feedback
      && run.request.kind !== "prReview" && continuesMainSession(stepRun.step)) {
      const main = run.steps.findLast((s) => s.id !== stepRun.id && s.kind === "claude" && s.status === "succeeded"
        && s.sessionId && continuesMainSession(s.step));
      const tooLarge = main ? contextTooLarge(main) : undefined;
      if (main && agentOf(main) === agent && !tooLarge) {
        previous = main;
        continuedStep = true;
        sessionDecision = main.model === stepRun.model ? "continuación del trabajo" : "continuación con otro modelo";
      } else if (tooLarge) {
        sessionDecision = tooLarge;
      }
    }
    if (previous?.sessionId) {
      resume = previous.sessionId;
      prompt = continuedStep ? this.renderPrompt(run, stepRun.step, stepContext, this.knownInSession(run, previous.sessionId)) : automaticResume
        ? [
            "Eres el paso **implement**. Continúa tu implementación en los mismos worktrees; Nexura ya ha hecho commit de tus cambios anteriores.",
            "Corrige únicamente los problemas indicados y sus efectos necesarios. No hagas commit, no delegues ni crees worktrees. Ejecuta los checks pertinentes.",
            "Devuelve el mismo JSON de implement: summary, commitMessage, tasksDone (ids), filesChanged, notes y prDescriptions por repo en el idioma de sus convenciones.",
            "## Correcciones actuales",
            stepContext.feedback,
          ].join("\n\n")
        : options?.instruction?.trim() || RESUME_DEFAULT_INSTRUCTION;
    } else {
      prompt = options?.prompt ?? this.renderPrompt(run, stepRun.step, stepContext);
    }

    // A resumed Claude session reports its whole cost so far, earlier invocations included.
    const priorSessionCost = resume && agent === "claude" ? previous!.sessionCostUsd ?? previous!.costUsd : 0;

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
      // The CLI checks the limit against the session total, not this invocation.
      maxBudgetUsd = Math.round((remaining + priorSessionCost) * 10_000) / 10_000;
    }

    const [primary, ...others] = run.worktrees;
    // Every Claude phase of the main session exposes the same tools, servers and memory, so the
    // next phase reads the conversation from the cache instead of rewriting it (see mainSessionEnvelope).
    const envelope = agent === "claude" && run.request.kind !== "prReview" && continuesMainSession(stepRun.step)
      ? this.mainSessionEnvelope(run, stepRun.step)
      : undefined;
    // MCP servers of the repo's own Claude config (project, local, user, plugins), pre-approved
    // as whole servers (`dontAsk` refuses anything else). The memory server is Nexura's.
    // Only what every phase knows from the start: a step's own output would change `@auto` midway.
    const taskContext = [run.request.ticketText, run.request.prompt, stepContext.extraVars?.repoMap].join("\n");
    const mcp = envelope
      ? resolveStepMcp(primary!.repoPath, envelope.shared.mcpServers, envelope.steps, taskContext, [MEMORY_SERVER])
      : resolveStepMcp(primary!.repoPath, definition.mcpServers ?? [], stepRun.step, taskContext, [MEMORY_SERVER]);
    if (mcp.missing.length) {
      // Expected with the defaults (e.g. angular-cli in a repo that is not Angular): a note, not a warning.
      this.recordEvent(run, stepRun, { kind: "text", text: `MCP del paso que ${primary!.repo} no tiene (se omiten): ${mcp.missing.join(", ")}` });
    }
    const allowedTools = [...definition.allowedTools, ...Object.keys(mcp.servers).map((name) => `mcp__${name}`)];
    // Judge B only reads: both judges would save the same observations.
    const memoryMode = stepRun.judge === "B" && definition.memory === "readwrite" ? "read" : definition.memory;
    // The session's memory server and protocol, but only this phase's memory rights.
    const serverMemoryMode = envelope ? envelope.shared.memory : memoryMode;
    const memory =
      this.settings.memoryEnabled && serverMemoryMode && serverMemoryMode !== "off"
        ? memoryRunOptions(serverMemoryMode, {
            project: await projectOf(primary!.repoPath),
            step: stepRun.step,
            runId: run.id,
            allowedTools,
            excludeTopic: run.request.ticketId ? `tickets/${run.request.ticketId}` : undefined,
            permitMode: memoryMode ?? "off",
          })
        : undefined;
    const jsonSchema = envelope
      ? sessionSchema(envelope.steps.map((name) => ({ name, schema: this.config.steps.get(name)?.schema })))
      : stepRun.step === "classify" ? this.classifySchema(definition.schema) : definition.schema;
    if (envelope) {
      prompt += `\n\nEntrega tu salida estructurada en la clave \`${stepRun.step}\` de StructuredOutput; deja vacías las de los otros pasos.`;
    }
    const process = new AgentProcess({
      agent,
      maxBudgetUsd,
      cwd: primary!.path,
      prompt,
      model: stepRun.model,
      effort: stepRun.effort,
      tools: envelope?.shared.tools ?? definition.tools,
      allowedTools: memory?.allowedTools ?? allowedTools,
      disallowedTools: envelope?.shared.disallowedTools ?? definition.disallowedTools,
      mcpServers: mcp.servers,
      addDirs: others.map((worktree) => worktree.path),
      jsonSchema,
      timeoutMs: definition.timeoutMs,
      resume,
      forkSession: Boolean(resume) && !continuedStep && !automaticResume,
      ...(memory ? { mcpConfig: memory.mcpConfig, appendSystemPrompt: memory.appendSystemPrompt } : {}),
    });
    stepRun.prompt = prompt;
    stepRun.args = process.args;
    const memoryText = stepContext.extraVars?.memory ?? "";
    const ledgerText = stepContext.ledger.readForPrompt();
    stepRun.contextMetrics = {
      promptChars: prompt.length,
      memoryChars: memoryText && prompt.includes(memoryText) ? memoryText.length : 0,
      ledgerChars: ledgerText && prompt.includes(ledgerText) ? ledgerText.length : 0,
      mcpServers: [...Object.keys(mcp.servers), ...(memory ? [MEMORY_SERVER] : [])],
      ...(previous ? { resumedFrom: previous.id } : {}),
      resumeDepth: previous ? (previous.contextMetrics?.resumeDepth ?? 0) + 1 : 0,
      sessionTurnsBefore: previous ? (previous.contextMetrics?.sessionTurnsBefore ?? 0) + previous.numTurns : 0,
      correctionDepth: continuedStep ? 0 : previous ? (previous.contextMetrics?.correctionDepth ?? previous.contextMetrics?.resumeDepth ?? 0) + 1 : 0,
      correctionTurnsBefore: continuedStep ? 0 : previous ? (previous.contextMetrics?.correctionTurnsBefore ?? previous.contextMetrics?.sessionTurnsBefore ?? 0) + previous.numTurns : 0,
      sessionDecision,
      toolCalls: 0,
      readCalls: 0,
      repeatedReadCalls: 0,
      toolResultChars: 0,
      schemaFingerprint: fingerprint(jsonSchema),
      systemFingerprint: fingerprint(memory?.appendSystemPrompt ?? ""),
    };
    const reads = new Set<string>();
    this.recordEvent(run, stepRun, { kind: "text", text: `Contexto: ${prompt.length} caracteres de prompt; ${stepRun.contextMetrics.mcpServers.length} MCP; ${sessionDecision}.` });
    this.store.saveStepRun(stepRun);
    this.persist(run);

    let rejectedUntil: number | undefined;
    let memoriesSaved = 0;
    const streamUsage = new StreamUsage();
    process.on("raw", (line) => {
      this.store.appendRaw(run.id, stepRun, line);
      streamUsage.push(parseLine(line));
    });
    process.on("event", (event) => {
      observeContext(stepRun.contextMetrics!, reads, event);
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

    // Cancelled while the prompt was being built: the agent never starts.
    if (context.cancelled) {
      throw new CancelledError("Cancelado");
    }
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
    this.recordEvent(run, stepRun, { kind: "text", text: `Herramientas: ${stepRun.contextMetrics.toolCalls} llamadas; ${stepRun.contextMetrics.readCalls} lecturas explícitas (${stepRun.contextMetrics.repeatedReadCalls} repetidas); ${stepRun.contextMetrics.toolResultChars} caracteres de resultados.` });
    if (memoriesSaved > 0) {
      this.recordEvent(run, stepRun, { kind: "text", text: `Guardada(s) ${memoriesSaved} observación(es) en la memoria compartida.` });
    }

    const result = outcome.result;
    stepRun.sessionId = outcome.sessionId ?? stepRun.sessionId;
    if (result) {
      // A lower total means the CLI started the count afresh (e.g. a forked session).
      stepRun.costUsd = result.costUsd >= priorSessionCost ? result.costUsd - priorSessionCost : result.costUsd;
      if (agent === "claude") {
        stepRun.sessionCostUsd = result.costUsd;
      }
      stepRun.numTurns = result.numTurns;
      stepRun.usage = result.usage;
      // Steps without a schema (custom ones) hand their final text to the next steps.
      stepRun.structuredOutput = envelope
        ? phaseOutput(result.structuredOutput, stepRun.step) ?? (definition.schema ? undefined : result.text)
        : definition.schema ? result.structuredOutput : result.text;
    }
    this.observeCache(run, stepRun, streamUsage, previous);
    const observed = streamUsage.total();
    const unreported = usageBeyond(observed, result?.usage);
    if (unreported) {
      stepRun.unreportedUsage = unreported;
      stepRun.usage = result ? maxUsage(result.usage, observed) : observed;
      this.recordEvent(run, stepRun, {
        kind: "text",
        text: `Tokens vistos en el stream que el agente no incluyó en su informe (sin coste en USD): ${unreported.cacheReadTokens} de lectura de caché, ${unreported.cacheCreationTokens} de escritura, ${unreported.outputTokens} de salida y ${unreported.inputTokens} de entrada.`,
      });
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
    } else if (definition.schema && stepRun.structuredOutput === undefined) {
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

  /** Manual-only experimental profiles must not be selected by classify. */
  private classifySchema(schema: object | undefined): object | undefined {
    const properties = (schema as { properties?: Record<string, object> } | undefined)?.properties;
    if (!schema || !properties?.["profile"]) {
      return schema;
    }
    const names = [...this.config.profiles.values()].filter((profile) => profile.autoSelect !== false).map((profile) => profile.name);
    if (!names.length) {
      throw new Error("No hay perfiles disponibles para clasificación automática. Selecciona un perfil explícitamente.");
    }
    const profile = { ...properties["profile"], enum: names };
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
        if (output.passed && output.autoFixes?.length) {
          for (const worktree of run.worktrees.filter((item) => output.autoFixes!.some((fix) => fix.repo === item.repo))) {
            const sha = await commitAll(worktree, "style: apply automatic QA fixes");
            if (sha) {
              emit({ kind: "text", text: `Autofix guardado en ${worktree.repo}: ${sha.slice(0, 8)}` });
            }
          }
        }
        const skipped = output.configErrors.length
          ? `\nOmitidos por configuración del plan (no cuentan como fallo del código): ${output.configErrors.map((e) => `\`${e.command}\` (${e.repo})`).join(", ")}`
          : "";
        const fixed = output.autoFixes?.length
          ? `\nAutofix: ${output.autoFixes.map((item) => `${item.repo}: ${item.tools.join(" + ")} (${item.files.length} fichero(s))`).join(", ")}`
          : "";
        stepContext.ledger.append(
          "qaCode",
          (output.passed
            ? `${output.commands} comando(s) OK`
            : `Fallan: ${output.failures.map((f) => `\`${f.command}\` (${f.repo})`).join(", ")}`) + fixed + skipped,
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
    return { repoMap: maps.filter(Boolean).join("\n\n"), repoNotes: notes.join("\n\n"), memory: "" };
  }

  /** `{{memory}}`: what the shared memory has about the ticket and each repo. */
  private async memoryVar(run: Run, stepName?: StepName, stepContext?: StepContext): Promise<string> {
    if (!this.settings.memoryEnabled) {
      return "";
    }
    const title = run.request.ticketText.split(/\r?\n/)[0] ?? "";
    // Separate searches preserve the ticket signal even when feedback contains many words.
    const focus = stepName === "implement" ? stepContext?.feedback : stepName === "codeReview"
      ? (stepContext?.outputs.get("implement") as { filesChanged?: string[] } | undefined)?.filesChanged?.join(" ")
      : run.request.tasks.filter((task) => task.selected).map((task) => task.title).join(" ");
    const budget = Math.max(2, Math.floor(4000 / Math.max(1, run.worktrees.length)) - 100);
    const files = memoryFiles(stepContext);
    const parts = await Promise.all(
      run.worktrees.map(async (worktree) => {
        const project = await projectOf(worktree.repoPath);
        const ownFiles = files.filter((file) => !file.repo || file.repo === worktree.repo).map((file) => file.path);
        const text = readMemory(memoryStore(), project, [focus ?? "", title], budget,
          run.request.ticketId ? `tickets/${run.request.ticketId}` : undefined, ownFiles);
        return text && run.worktrees.length > 1 ? `**${worktree.repo}**\n${text}` : text;
      }),
    );
    return parts.filter(Boolean).join("\n\n").slice(0, 4000);
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
  /** The new conventions the investigating phase (enrich or plan) found: for the next tickets, in the repo notes and the memory. */
  private async learnConventions(run: Run, stepRun: StepRun): Promise<void> {
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
        content: `**Qué**: ${convention}\n**Dónde**: ${primary.repo}\n**Aprendido**: convención detectada por ${stepRun.step} al resolver un ticket.`,
        topicKey: `conventions/${slugify(convention, 60)}`,
        source: stepRun.step,
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
      files: implement?.filesChanged ?? [],
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
      const stepConfig = { ...(profile?.steps.addressReview ?? DEFAULT_ADDRESS_REVIEW), ...run.request.modelConfig };
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

  // ---------------------------------------------------------------- PR review

  /**
   * Checks out the PR's head, gives the reviewer the diff's scope, the threads already open
   * (so it does not repeat a human) and what Nexura knows of the repo, then checks its answer
   * against the diff. The worktree is always removed at the end: a retry checks the PR out again.
   */
  private async executePrReview(initial: Run, options?: RetryOptions): Promise<void> {
    const run = this.store.getRun(initial.id) ?? initial;
    const context = this.contexts.get(run.id)!;
    const target = run.request.prReview!;
    if (context.cancelled) {
      run.status = "cancelled";
      this.releaseContext(run.id, context);
      this.persist(run);
      return;
    }
    run.status = "running";
    run.error = undefined;
    this.persist(run);
    const ledger = new Ledger(run.id);
    // What ends the run once the worktree is gone; unset = a step failed and already failed the run.
    let finish: (() => void) | undefined;
    try {
      const repo = this.config.repos.find((candidate) => candidate.name === run.request.repos[0]);
      if (!repo) {
        throw new Error(`Repositorio no configurado en repos.json: ${run.request.repos[0]}`);
      }
      let neutralized: string[] = [];
      if (run.worktrees.length === 0) {
        const checkout = await createPrWorktree(repo, run.id, target);
        run.worktrees.push(checkout.worktree);
        neutralized = checkout.neutralized;
        this.persist(run);
      }
      const worktree = run.worktrees[0]!;
      const headSha = await git(worktree.path, ["rev-parse", "HEAD"]);
      const range = `${worktree.baseRef}...HEAD`;
      // The PR's .gitattributes must not pick a diff driver or textconv program of the user's.
      const diffArgs = ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-textconv", "-M"];
      const nameStatus = await git(worktree.path, [...diffArgs, "--name-status", range]);
      const changedFiles = new Set(
        nameStatus
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => line.split("\t").slice(1)),
      );
      const diff = await gitRaw(worktree.path, [...diffArgs, "--no-color", range]);
      const hunks = parseDiffHunks(diff);
      // The reviewer has no shell (git's options can write files or run programs): it reads the diff here.
      const reviewDir = join(worktree.path, PR_REVIEW_DIR);
      // Whatever the PR put there goes first (a symlink would send the writes outside the checkout).
      rmSync(reviewDir, { recursive: true, force: true });
      mkdirSync(reviewDir);
      writeFileSync(join(reviewDir, "pr.diff"), diff);
      writeFileSync(join(reviewDir, "commits.txt"), await gitRaw(worktree.path, ["log", "--no-color", "--format=%h %an: %s", `${worktree.baseRef}..HEAD`]));
      ledger.append(
        "prReview",
        [
          `PR #${target.id} (${target.sourceBranch} → ${target.targetBranch}) @ ${headSha.slice(0, 8)}: ${changedFiles.size} fichero(s).`,
          neutralized.length ? `Configuración de agentes que trae la PR, sustituida por la de ${target.targetBranch}: ${neutralized.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );

      let threads = "";
      try {
        threads = threadsToText(await getActiveThreads(worktree, { id: target.id }));
      } catch (error) {
        ledger.append("prReview", `No se pudieron leer los hilos abiertos: ${error instanceof Error ? error.message : String(error)}`);
      }
      const stepContext: StepContext = {
        outputs: new Map(),
        ledger,
        extraVars: {
          ...(await this.repoContextVars(run)),
          memory: await this.memoryVar(run, "prReview"),
          pr: prReviewText(target, headSha, neutralized),
          changedFiles: nameStatus,
          threads: threads || "Ninguno.",
          baseRef: worktree.baseRef,
        },
      };
      const stepRun = await this.runWithRateLimit(run, context, "prReview", run.request.reviewConfig ?? DEFAULT_PR_REVIEW, stepContext, options);
      if (!stepRun) {
        return;
      }

      const output = stepRun.structuredOutput as PrReviewOutput;
      const files = new Map<string, string[] | undefined>();
      for (const comment of output.comments ?? []) {
        const file = comment.file ? normalizeReviewPath(comment.file) : "";
        if (file && !files.has(file)) {
          // From git, never from disk: a path the model made up cannot leave the repo.
          files.set(file, await gitRaw(worktree.path, ["show", `HEAD:${file}`]).then((text) => text.replace(/\r?\n$/, "").split(/\r?\n/), () => undefined));
        }
      }
      const result = normalizePrReview(output, { headSha, changedFiles, hunks, readFile: (path) => files.get(path) });
      run.prReview = result;
      const bySeverity = ["blocker", "major", "minor", "nit"]
        .map((severity) => [severity, result.comments.filter((comment) => comment.severity === severity).length] as const)
        .filter(([, count]) => count > 0)
        .map(([severity, count]) => `${count} ${severity}`)
        .join(", ");
      const dropped = (output.comments?.length ?? 0) - result.comments.length;
      this.recordEvent(run, stepRun, {
        kind: "text",
        text: [
          `Revisión lista: ${result.comments.length} comentario(s)${bySeverity ? ` (${bySeverity})` : ""}, veredicto ${result.verdict}.`,
          dropped > 0 ? `Descartados ${dropped} comentario(s) vacíos o sobre ficheros que no existen en la PR.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      ledger.append("prReview", `${result.verdict}: ${result.summary}\n${result.comments.length} comentario(s) propuestos.`);
      finish = () => this.finishRun(run, context);
    } catch (error) {
      finish =
        error instanceof CancelledError || context.cancelled
          ? () => {
              run.status = "cancelled";
              run.resumesAt = undefined;
              this.releaseContext(run.id, context);
              this.persist(run);
            }
          : () => this.fail(run, `prReview: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Before announcing the end: whoever waits for it may retry (a fresh checkout) or delete the run.
      await this.removeWorktrees(run, false).catch(() => undefined);
      finish?.();
    }
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
      .map((step) => step.structuredOutput as { summary: string; filesChanged: string[]; prDescriptions?: { repo: string; description: string }[] });
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
  private async afterCustomStep(run: Run, stepRun: StepRun, ledger: Ledger): Promise<boolean> {
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
    return shas.length > 0;
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
      const failures = qa.failures
        .map((f) => `- \`${f.command}\` en ${f.repo} (exit ${f.exitCode}):\n\`\`\`\n${f.outputTail.slice(-1500)}\n\`\`\``)
        .join("\n");
      return qa.autoFixes?.length ? `Nexura ya intentó autofix en los ficheros cambiados; revisa los cambios que dejó en los worktrees.\n${failures}` : failures;
    }
    return undefined;
  }

  /**
   * The Claude phases that may share the run's main session (the profile's work steps plus
   * addressReview) and what they expose together. Every phase gets the same tools, servers and
   * memory, so moving to the next one does not rewrite the conversation into the prompt cache.
   */
  private mainSessionEnvelope(run: Run, current: StepName): { steps: StepName[]; shared: SessionEnvelope } {
    const profile = run.resolvedProfile ? this.config.profiles.get(run.resolvedProfile) : undefined;
    const configOf = (name: StepName): StepConfig | undefined => {
      const own = profile?.steps[name] ?? (name === "addressReview" ? DEFAULT_ADDRESS_REVIEW : undefined);
      return own && run.request.modelConfig ? { ...own, ...run.request.modelConfig } : own;
    };
    const sequence = orderSteps(this.config.steps.values())
      .map((step) => step.name)
      .filter((name) => !ON_DEMAND_STEPS.has(name) && profile?.steps[name]?.enabled);
    const phases = [...sequence, "addressReview"].filter((name) => {
      const definition = this.config.steps.get(name);
      const config = configOf(name);
      return definition && definition.kind !== "builtin" && continuesMainSession(name) && config && agentOf(config) === "claude";
    });
    const steps = [...new Set([...phases, current])];
    const shared = mainSessionEnvelope(steps.flatMap((name) => this.config.steps.get(name) ?? []));
    return { steps, shared };
  }

  /** Template variables a session already holds: the run's context and the outputs of the phases it ran. */
  private knownInSession(run: Run, sessionId: string): Set<string> {
    const known = new Set(SESSION_CONTEXT_VARS);
    for (const step of run.steps) {
      if (step.sessionId === sessionId && step.status === "succeeded") {
        known.add(`output.${step.step}`);
      }
    }
    return known;
  }

  /**
   * Real context size and cache use of a step, from its stream. When it continued a session and
   * still wrote the conversation into the cache instead of reading it, says what changed.
   */
  private observeCache(run: Run, stepRun: StepRun, usage: StreamUsage, previous: StepRun | undefined): void {
    const metrics = stepRun.contextMetrics;
    if (!metrics) {
      return;
    }
    metrics.contextTokens = usage.contextTokens();
    const first = usage.firstCall();
    if (first) {
      metrics.firstCallCacheRead = first.cacheReadTokens;
      metrics.firstCallCacheWrite = first.cacheCreationTokens;
    }
    const continuity = previous ? cacheContinuity(previous, stepRun) : undefined;
    if (!continuity) {
      return;
    }
    metrics.cacheReused = continuity.reused;
    if (!continuity.reused) {
      const why = continuity.changed.length
        ? `Cambió: ${continuity.changed.join(", ")}.`
        : "No cambió nada de lo que controla Nexura: puede que la caché hubiera caducado.";
      this.recordEvent(run, stepRun, {
        kind: "text",
        text: `La sesión continuó sin aprovechar la caché: escribió ${metrics.firstCallCacheWrite ?? 0} tokens en vez de leer los ${previous!.contextMetrics!.contextTokens} de la conversación. ${why}`,
      });
    }
  }

  private renderPrompt(run: Run, stepName: StepName, stepContext: StepContext, known?: ReadonlySet<string>): string {
    const definition = this.config.steps.get(stepName);
    const template = known ? continuationTemplate(definition?.promptTemplate ?? "", known) : (definition?.promptTemplate ?? "");
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
      profiles: [...this.config.profiles.values()].filter((profile) => profile.autoSelect !== false).map((profile) => `- **${profile.name}**: ${profile.description}`).join("\n"),
      ledger: stepContext.ledger.readForPrompt(),
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
    const builtin = this.config.steps.get(stepName)?.kind === "builtin";
    const config = run.request.modelConfig && !builtin
      ? { ...profile.steps[stepName], ...run.request.modelConfig }
      : profile.steps[stepName];
    const stepRun: StepRun = {
      id: randomUUID(),
      runId: run.id,
      step: stepName,
      attempt: run.steps.filter((s) => s.step === stepName).length + 1,
      seq: run.steps.length,
      status: "skipped",
      kind: this.config.steps.get(stepName)?.kind ?? "claude",
      ...(builtin ? {} : { agent: agentOf(config) }),
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
