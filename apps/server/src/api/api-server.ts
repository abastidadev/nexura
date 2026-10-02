import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  STEP_NAMES,
  TICKET_SOURCES,
  type AgentInfo,
  type ChangeRequest,
  type RunDiff,
  type OwnReviewComment,
  type ConversationChange,
  type ConversationImage,
  type ConversationUpdate,
  type FlowProfile,
  type NewConversation,
  type NexuraSettings,
  type PrReviewPublish,
  type RepoConfig,
  type RepoDetection,
  type RetryOptions,
  type RunRequest,
  type ServerMessage,
  type StepName,
  type NewTicketDraft,
  type NewAiSetupSession,
  type AiSetupUpdate,
  type OfficeAchievementEvent,
  type BetKind,
  type DashboardInbox,
  type OfficeRewardEvent,
  type ShopSlot,
  type TicketDraftUpdate,
  type TicketSource,
  type WorkItemScope,
} from "@nexura/shared";
import {
  createStep,
  deleteProfile,
  deleteStep,
  loadConfig,
  saveProfile,
  saveRepos,
  saveStepDefinition,
  saveStepPrompt,
  type NewStep,
  type StepDefinitionUpdate,
} from "../config/config-loader.ts";
import { NEXURA_HOME } from "../config/paths.ts";
import { rejectReason } from "./request-guard.ts";
import { AchievementService } from "../achievements/achievement-service.ts";
import { RewardError, RewardService } from "../rewards/reward-service.ts";
import { RewardStore } from "../rewards/reward-store.ts";
import { AzureError } from "../azure/azure-client.ts";
import { ConversationManager } from "../conversations/conversation-manager.ts";
import { ConversationStore } from "../conversations/conversation-store.ts";
import { getPullRequestDetail, listPullRequests, requireRemote } from "../forge/forge.ts";
import { loadInbox } from "../forge/inbox.ts";
import { repoRemoteOf } from "../forge/remote.ts";
import { listTickets, loadTicket, ticketOptions, ticketTarget, ticketToText, type TicketTarget } from "../forge/tickets.ts";
import { TicketAssistant, TicketDraftError } from "../tickets/ticket-assistant.ts";
import { TicketDraftStore } from "../tickets/ticket-draft-store.ts";
import { AiSetupAssistant, AiSetupError } from "../ai-setup/ai-setup-assistant.ts";
import { AiSetupStore } from "../ai-setup/ai-setup-store.ts";
import { GithubError } from "../github/github-client.ts";
import { pickFolder } from "../system/folder-picker.ts";
import { Ledger } from "../ledger/ledger.ts";
import { mcpAddCommand, memoryStore } from "../memory/memory.ts";
import { detectAgents } from "../runner/agents.ts";
import { accountUsage } from "../runner/account-usage.ts";
import { detectChecks } from "../workspace/check-detection.ts";
import { CheckTrials } from "../workspace/check-trial.ts";
import { defaultBranch } from "../workspace/git.ts";
import { claudeInventory } from "../workspace/claude-inventory.ts";
import { projectOf } from "../memory/memory-store.ts";
import type { Orchestrator, PrReviewRequest } from "../orchestrator/orchestrator.ts";
import type { RunStore } from "../store/run-store.ts";
import { TerminalServer } from "../terminal/terminal-server.ts";
import { registerOfficeRoutes } from "../office/office-api.ts";
import { openTarget } from "../office/office-open.ts";
import { officeContinue, officeDigest } from "../office/office-digest.ts";
import { readRepoNotes, saveRepoNotes } from "../workspace/repo-context.ts";
import { pullRequestDiff, RUN_DIFF_FILE, runDiff, workingTreeDiff } from "../workspace/diff.ts";

const WEB_DIST = join(NEXURA_HOME, "apps", "web", "dist", "web", "browser");
const AGENTS_TTL_MS = 60_000;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (params: string[], body: unknown, url: URL) => unknown | Promise<unknown>;
type Route = { method: string; pattern: RegExp; handler: Handler };

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value ?? null));
}

/** Serves the built Angular app (SPA fallback to index.html) when it exists. */
function serveStatic(url: URL, response: ServerResponse): boolean {
  if (!existsSync(WEB_DIST)) {
    return false;
  }
  const requested = normalize(join(WEB_DIST, decodeURIComponent(url.pathname)));
  const file =
    requested.startsWith(WEB_DIST) && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : join(WEB_DIST, "index.html");
  response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
  return true;
}

export function createApiServer(
  orchestrator: Orchestrator,
  store: RunStore,
  conversations = new ConversationManager(new ConversationStore()),
  tickets = new TicketAssistant(new TicketDraftStore(), {
    settings: () => orchestrator.getSettings(),
    quotaUntil: (agent) => orchestrator.quotaPauseFor(agent),
  }),
  achievements = new AchievementService(),
  aiSetup = new AiSetupAssistant(new AiSetupStore(), {
    settings: () => orchestrator.getSettings(),
    quotaUntil: (agent) => orchestrator.quotaPauseFor(agent),
  }),
  rewards = new RewardService(new RewardStore(), { runs: () => store.listRuns(200), repos: () => loadConfig().repos }),
): Server {
  const routes: Route[] = [];
  const terminals = new TerminalServer(store);
  const checkTrials = new CheckTrials(loadConfig().steps.get("qaCode")?.timeoutMs ?? 20 * 60 * 1000);
  const route = (method: string, path: string, handler: Handler): void => {
    const pattern = new RegExp("^" + path.replace(/:\w+/g, "([^/]+)") + "$");
    routes.push({ method, pattern, handler });
  };
  const requireRun = (id: string) => {
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, `Run no encontrado: ${id}`);
    }
    return run;
  };

  const requireConversation = (id: string): string => {
    if (!conversations.find(id)) {
      throw new HttpError(404, `No existe la conversación ${id}`);
    }
    return id;
  };

  const requireStep = (name: string): void => {
    if (!loadConfig().steps.has(name)) {
      throw new HttpError(404, `Paso desconocido: ${name}`);
    }
  };

  route("GET", "/api/runs", () => store.listRuns());
  route("GET", "/api/runs/:id", ([id]) => requireRun(id!));
  route("GET", "/api/runs/:id/steps/:stepRunId/events", ([, stepRunId], _body, url) =>
    store.getEvents(stepRunId!, Number(url.searchParams.get("after") ?? -1)),
  );
  /** What the run's branches change against their base (read-only git, zero tokens). */
  route("GET", "/api/runs/:id/diff", ([id], _body, url) =>
    runDiff(requireRun(id!), store.runFile(id!, RUN_DIFF_FILE), { ignoreWhitespace: url.searchParams.get("ignoreWhitespace") === "true" }),
  );
  route("GET", "/api/runs/:id/ledger", ([id]) => ({ markdown: new Ledger(requireRun(id!).id).read() }));
  route("GET", "/api/runs/:id/steps/:stepRunId/raw", ([id, stepRunId]) => {
    const stepRun = requireRun(id!).steps.find((step) => step.id === stepRunId);
    if (!stepRun) {
      throw new HttpError(404, "Paso no encontrado");
    }
    const file = store.rawLogFile(id!, stepRun);
    return { jsonl: existsSync(file) ? readFileSync(file, "utf8") : "" };
  });
  route("POST", "/api/runs", (_params, body) => orchestrator.start(body as RunRequest));
  route("DELETE", "/api/runs/:id", async ([id], _body, url) => {
    requireRun(id!);
    if (!orchestrator.isActive(id!)) {
      await terminals.closeRun(id!);
    }
    await orchestrator.deleteRun(id!, url.searchParams.get("deleteBranches") === "true");
  });
  route("POST", "/api/runs/:id/cancel", ([id]) => orchestrator.cancel(id!));
  route("POST", "/api/runs/:id/message", ([id], body) => orchestrator.sendMessage(id!, String((body as { text?: string }).text ?? "")));
  route("POST", "/api/runs/:id/continue", ([id], body) => orchestrator.continue(id!, body as RetryOptions));
  route("POST", "/api/runs/:id/retry", ([id], body) => orchestrator.retry(id!, body as RetryOptions));
  route("GET", "/api/runs/:id/review-threads", async ([id]) => {
    try {
      return await orchestrator.reviewThreads(id!);
    } catch (error) {
      throw new HttpError(502, String((error as Error).message));
    }
  });
  /** The user's comments on the diff go back to implement (at a pause, or relaunching a stopped flow). */
  route("POST", "/api/runs/:id/request-changes", ([id], body) => orchestrator.requestChanges(requireRun(id!).id, body as ChangeRequest));
  /** A comment of the user added to a finished PR review, on lines of the PR's diff. */
  route("POST", "/api/runs/:id/review-comments", ([id], body) => orchestrator.addOwnReviewComment(requireRun(id!).id, body as OwnReviewComment));
  route("POST", "/api/runs/:id/address-review", ([id]) => orchestrator.addressReview(id!));
  route("POST", "/api/runs/:id/cleanup", async ([id], body) => {
    requireRun(id!);
    if (!orchestrator.isActive(id!)) {
      await terminals.closeRun(id!);
    }
    await orchestrator.cleanup(id!, Boolean((body as { deleteBranches?: boolean }).deleteBranches));
  });

  // Interactive terminal conversations (claude, codex, copilot or a shell) on a project.
  route("GET", "/api/conversations", () => conversations.list());
  route("POST", "/api/conversations", (_params, body) => conversations.create(body as NewConversation));
  route("PUT", "/api/conversations/:id", ([id], body) => conversations.update(requireConversation(id!), body as ConversationUpdate));
  route("DELETE", "/api/conversations/:id", ([id]) => conversations.delete(requireConversation(id!)));
  route("POST", "/api/conversations/:id/start", ([id], body) => conversations.start(requireConversation(id!), body as ConversationChange));
  route("POST", "/api/conversations/:id/stop", ([id]) => conversations.stop(requireConversation(id!)));
  route("POST", "/api/conversations/:id/images", ([id], body) => conversations.saveImage(requireConversation(id!), body as ConversationImage));
  /** What is not committed in the conversation's repo (Terminal > Cambios). Read-only git, zero tokens. */
  route("GET", "/api/conversations/:id/diff", async ([id], _body, url) => {
    const conversation = conversations.find(requireConversation(id!))!;
    return { repos: [await workingTreeDiff(conversation.cwd, conversation.repo, { ignoreWhitespace: url.searchParams.get("ignoreWhitespace") === "true" })] } satisfies RunDiff;
  });
  route("GET", "/api/conversations/:id/history", ([id]) => conversations.history(requireConversation(id!)));

  route("GET", "/api/config", () => {
    const config = loadConfig();
    orchestrator.setConfig(config);
    return {
      profiles: [...config.profiles.values()],
      repos: config.repos,
      steps: [...config.steps.values()],
    };
  });
  route("PUT", "/api/profiles/:name", ([name], body) => {
    const profile = body as FlowProfile;
    if (profile.name !== name) {
      throw new HttpError(400, "El nombre del perfil no coincide con la URL");
    }
    saveProfile(profile);
    orchestrator.setConfig(loadConfig());
    return profile;
  });
  route("DELETE", "/api/profiles/:name", ([name]) => {
    deleteProfile(name!);
    orchestrator.setConfig(loadConfig());
  });
  route("POST", "/api/steps", (_params, body) => {
    createStep(body as NewStep);
    orchestrator.setConfig(loadConfig());
  });
  route("DELETE", "/api/steps/:name", ([name]) => {
    requireStep(name!);
    deleteStep(name!);
    orchestrator.setConfig(loadConfig());
  });
  route("PUT", "/api/steps/:name/prompt", ([name], body) => {
    requireStep(name!);
    saveStepPrompt(name as StepName, (body as { template: string }).template);
    orchestrator.setConfig(loadConfig());
  });
  route("PUT", "/api/steps/:name/definition", ([name], body) => {
    requireStep(name!);
    saveStepDefinition(name as StepName, body as StepDefinitionUpdate);
    orchestrator.setConfig(loadConfig());
  });
  route("GET", "/api/repos/:name/notes", ([name]) => ({ markdown: readRepoNotes(name!) }));
  route("PUT", "/api/repos/:name/notes", ([name], body) => {
    saveRepoNotes(name!, String((body as { markdown?: string }).markdown ?? ""));
  });
  route("PUT", "/api/repos", (_params, body) => {
    saveRepos((body as { repos: RepoConfig[] }).repos ?? []);
    orchestrator.setConfig(loadConfig());
  });
  /** Base branch and QA checks of a repo folder (saved or not yet), read from git and its files. */
  route("POST", "/api/repos/detect", async (_params, body): Promise<RepoDetection> => {
    const path = String((body as { path?: string }).path ?? "");
    const checks = detectChecks(path);
    const baseBranch = await defaultBranch(path);
    return { ...(baseBranch ? { baseBranch } : {}), checks };
  });
  /** Runs checks on a clean worktree of the base branch; poll the returned trial. */
  route("POST", "/api/repos/check-trials", (_params, body) => {
    const { checks, ...repo } = body as Pick<RepoConfig, "path" | "baseBranch" | "nodeModules"> & { checks?: string[] };
    return checkTrials.start(repo, checks ?? []);
  });
  route("GET", "/api/repos/check-trials/:id", ([id]) => {
    const trial = checkTrials.get(id!);
    if (!trial) {
      throw new HttpError(404, `No existe la prueba de checks ${id}`);
    }
    return trial;
  });

  /** Azure DevOps work items or GitHub issues (`source`); the org/repo comes from the chosen repo's origin remote. */
  const requestedTarget = (url: URL): Promise<TicketTarget> => {
    const source = url.searchParams.get("source") ?? "azure";
    if (!TICKET_SOURCES.includes(source as TicketSource)) {
      throw new HttpError(400, `Origen de tickets desconocido: ${source}`);
    }
    return ticketTarget(source as TicketSource, loadConfig().repos, url.searchParams.get("repo"));
  };
  /** Upstream 404/400 (missing ticket, a PR number instead of an issue) as such; anything else is a bad gateway. */
  const upstreamError = (error: unknown): HttpError => {
    const status = error instanceof AzureError || error instanceof GithubError ? error.status : undefined;
    return new HttpError(status === 404 || status === 400 ? status : 502, String((error as Error).message));
  };

  /** Which provider a repo's origin remote is on: the default ticket source for it. */
  route("GET", "/api/repos/:name/remote", async ([name]) => {
    const repo = loadConfig().repos.find((candidate) => candidate.name === name);
    if (!repo) {
      throw new HttpError(404, `Repo desconocido: ${name}`);
    }
    return { provider: (await repoRemoteOf(repo.path))?.provider ?? null };
  });

  /** Open PRs of a repo, on whichever provider its origin lives (Revisiones). Zero tokens. */
  route("GET", "/api/repos/:name/pull-requests", async ([name]) => {
    const repo = loadConfig().repos.find((candidate) => candidate.name === name);
    if (!repo) {
      throw new HttpError(404, `Repo desconocido: ${name}`);
    }
    try {
      return await listPullRequests({ repo: repo.name, repoPath: repo.path });
    } catch (error) {
      throw upstreamError(error);
    }
  });
  /** Files, reviewers, labels and linked tickets of one PR (Revisiones' detail panel). Zero tokens. */
  route("GET", "/api/repos/:name/pull-requests/:id", async ([name, id]) => {
    const repo = loadConfig().repos.find((candidate) => candidate.name === name);
    if (!repo) {
      throw new HttpError(404, `Repo desconocido: ${name}`);
    }
    const prId = Number(id);
    if (!Number.isInteger(prId) || prId <= 0) {
      throw new HttpError(400, `Número de PR no válido: ${id}`);
    }
    try {
      return await getPullRequestDetail({ repo: repo.name, repoPath: repo.path }, prId);
    } catch (error) {
      throw upstreamError(error);
    }
  });
  /** The diff of an open PR, fetched into the repo without a checkout (Revisiones, before reviewing). Zero tokens. */
  route("GET", "/api/repos/:name/pull-requests/:id/diff", async ([name, id], _body, url) => {
    const repo = loadConfig().repos.find((candidate) => candidate.name === name);
    if (!repo) {
      throw new HttpError(404, `Repo desconocido: ${name}`);
    }
    const prId = Number(id);
    if (!Number.isInteger(prId) || prId <= 0) {
      throw new HttpError(400, `Número de PR no válido: ${id}`);
    }
    try {
      const location = { repo: repo.name, repoPath: repo.path };
      const pr = (await listPullRequests(location)).find((candidate) => candidate.id === prId);
      if (!pr) {
        throw new HttpError(404, `La PR #${prId} no está abierta en ${repo.name}`);
      }
      const { provider } = await requireRemote(location);
      const diff = await pullRequestDiff({ name: repo.name, path: repo.path }, { id: pr.id, provider, sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch, headSha: pr.headSha }, {
        ignoreWhitespace: url.searchParams.get("ignoreWhitespace") === "true",
      });
      return { repos: [diff] } satisfies RunDiff;
    } catch (error) {
      throw error instanceof HttpError ? error : upstreamError(error);
    }
  });
  /** Queues the review of one PR; nothing is posted until publish-review. */
  route("POST", "/api/pr-reviews", async (_params, body) => {
    try {
      return await orchestrator.startPrReview(body as PrReviewRequest);
    } catch (error) {
      throw error instanceof AzureError || error instanceof GithubError ? upstreamError(error) : error;
    }
  });
  /** Posts the comments the user picked (edited text) and the vote. */
  route("POST", "/api/runs/:id/publish-review", async ([id], body) => {
    requireRun(id!);
    try {
      return await orchestrator.publishPrReview(id!, body as PrReviewPublish);
    } catch (error) {
      throw error instanceof AzureError || error instanceof GithubError ? upstreamError(error) : error;
    }
  });

  /** Saves the conventions a review found to the repo notes (the user's call: they come from reading a PR). */
  route("POST", "/api/runs/:id/learn-conventions", ([id]) => {
    requireRun(id!);
    return orchestrator.learnPrReviewConventions(id!);
  });

  /** Skills, subagents and MCP servers that `claude` finds in a repo (read from files, no tokens). */
  route("GET", "/api/repos/:name/claude-config", ([name]) => {
    const repo = loadConfig().repos.find((candidate) => candidate.name === name);
    if (!repo) {
      throw new HttpError(404, `Repo desconocido: ${name}`);
    }
    return claudeInventory(repo.path);
  });

  /** Open tickets (backlog + in progress) to pick from when creating a flow. Zero tokens. */
  route("GET", "/api/tickets", async (_params, _body, url) => {
    const scope: WorkItemScope = url.searchParams.get("scope") === "project" ? "project" : "mine";
    const target = await requestedTarget(url);
    try {
      return await listTickets(target, scope);
    } catch (error) {
      throw upstreamError(error);
    }
  });

  /** Loads a work item or an issue (zero tokens). */
  route("GET", "/api/tickets/:id", async ([id], _body, url) => {
    const target = await requestedTarget(url);
    const ticketId = Number(id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      throw new HttpError(400, `ID de ticket no válido: ${id}`);
    }
    try {
      const ticket = await loadTicket(target, ticketId);
      return { ticket, text: ticketToText(ticket) };
    } catch (error) {
      throw upstreamError(error);
    }
  });

  // ---- Tickets: write a work item or issue with the assistant, create it on the board.
  /** Draft errors keep their status; the provider's, as upstream errors. */
  const ticketCall = async <T>(call: () => T | Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof TicketDraftError) {
        throw new HttpError(error.status, error.message);
      }
      throw error instanceof AzureError || error instanceof GithubError ? upstreamError(error) : error;
    }
  };
  /** Sprints, people, types and labels of a repo's board (zero tokens). */
  route("GET", "/api/ticket-options", async (_params, _body, url) => {
    const repo = loadConfig().repos.find((candidate) => candidate.name === url.searchParams.get("repo"));
    if (!repo) {
      throw new HttpError(404, `Repo desconocido: ${url.searchParams.get("repo")}`);
    }
    const requested = url.searchParams.get("source");
    if (requested && !TICKET_SOURCES.includes(requested as TicketSource)) {
      throw new HttpError(400, `Origen de tickets desconocido: ${requested}`);
    }
    const source = (await repoRemoteOf(repo.path))?.provider ?? (requested as TicketSource | null) ?? "azure";
    return ticketCall(async () => ticketOptions(await ticketTarget(source, loadConfig().repos, repo.name), url.searchParams.get("team") || undefined));
  });
  route("GET", "/api/ticket-drafts", () => tickets.list());
  route("GET", "/api/ticket-drafts/:id", ([id]) => ticketCall(() => tickets.get(id!)));
  route("POST", "/api/ticket-drafts", (_params, body) => ticketCall(() => tickets.start(body as NewTicketDraft)));
  route("PUT", "/api/ticket-drafts/:id", ([id], body) => ticketCall(() => tickets.update(id!, body as TicketDraftUpdate)));
  // `items` (optional) = the person's latest edits, applied before the turn or the creation.
  const edits = (body: unknown): TicketDraftUpdate | undefined => {
    const items = (body as { items?: unknown } | undefined)?.items;
    return Array.isArray(items) ? { items } : undefined;
  };
  route("POST", "/api/ticket-drafts/:id/message", ([id], body) =>
    ticketCall(() => tickets.reply(id!, String((body as { text?: string }).text ?? ""), edits(body))),
  );
  route("POST", "/api/ticket-drafts/:id/split", ([id], body) => ticketCall(() => tickets.split(id!, edits(body))));
  route("POST", "/api/ticket-drafts/:id/cancel", ([id]) => ticketCall(() => tickets.cancel(id!)));
  /** The only call that writes to Azure DevOps or GitHub: the person pressed «Crear». */
  route("POST", "/api/ticket-drafts/:id/create", ([id], body) => ticketCall(() => tickets.create(id!, edits(body))));
  route("DELETE", "/api/ticket-drafts/:id", ([id]) => ticketCall(() => tickets.delete(id!)));

  // ---- Setup IA: assess a repo's agent setup, or write a skill, agent, hook… with the assistant.
  const setupCall = async <T>(call: () => T | Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw error instanceof AiSetupError ? new HttpError(error.status, error.message) : error;
    }
  };
  // `files` (optional) = the person's latest edits, applied before the turn or the write.
  const setupEdits = (body: unknown): AiSetupUpdate | undefined => {
    const files = (body as { files?: unknown } | undefined)?.files;
    return Array.isArray(files) ? { files } : undefined;
  };
  route("GET", "/api/ai-setup/repos", () => aiSetup.repoKinds());
  route("GET", "/api/ai-setup", () => aiSetup.list());
  route("GET", "/api/ai-setup/:id", ([id]) => setupCall(() => aiSetup.get(id!)));
  route("POST", "/api/ai-setup", (_params, body) => setupCall(() => aiSetup.start(body as NewAiSetupSession)));
  route("PUT", "/api/ai-setup/:id", ([id], body) => setupCall(() => aiSetup.update(id!, setupEdits(body) ?? { files: [] })));
  route("POST", "/api/ai-setup/:id/message", ([id], body) =>
    setupCall(() => aiSetup.reply(id!, String((body as { text?: string }).text ?? ""), setupEdits(body))),
  );
  route("POST", "/api/ai-setup/:id/cancel", ([id]) => setupCall(() => aiSetup.cancel(id!)));
  route("DELETE", "/api/ai-setup/:id/files/:key", ([id, key]) => setupCall(() => aiSetup.removeFile(id!, key!)));
  /** The only call that writes into the repo: the person pressed «Escribir en el repo». */
  route("POST", "/api/ai-setup/:id/apply", ([id], body) => setupCall(() => aiSetup.apply(id!, setupEdits(body))));
  route("DELETE", "/api/ai-setup/:id", ([id]) => setupCall(() => aiSetup.delete(id!)));

  /** Native folder dialog on the machine running Nexura (it is a local app). */
  route("POST", "/api/system/pick-folder", async (_params, body) => ({
    path: await pickFolder(String((body as { initial?: string }).initial ?? "")),
  }));
  route("GET", "/api/quota", () => orchestrator.getQuota() ?? null);
  route("GET", "/api/settings", () => orchestrator.getSettings());
  // Where the browser opens the 3D office (docs/office-3d.md); whether this server shows its runs there.
  route("GET", "/api/office", () => ({ url: process.env.NEXURA_OFFICE_WEB_URL?.trim() || "http://localhost:4600", bridge: Boolean(process.env.NEXURA_OFFICE_URL && process.env.NEXURA_OFFICE_TOKEN) }));
  registerOfficeRoutes(route, () => loadConfig().repos);
  /** How many Nexura windows are open: the office in its own window opens things there instead of in a new tab. */
  route("GET", "/api/ui/windows", () => ({ windows: clients.size }));
  /** The office asks the Nexura window the user last used to show a run or New flow, without taking the focus. */
  route("POST", "/api/ui/open", (_params, body) => {
    const message = openTarget(body, loadConfig().repos);
    if (!message) {
      throw new HttpError(400, "Petición de apertura no válida");
    }
    if (clients.size === 0) {
      throw new HttpError(409, "No hay ninguna ventana de Nexura abierta");
    }
    broadcast(message);
    return { windows: clients.size };
  });
  // Which agent CLIs are installed (`--version`, free). Cached: it spawns three processes.
  let agents: { at: number; list: Promise<AgentInfo[]> } | undefined;
  route("GET", "/api/agents", (_params, _body, url) => {
    if (!agents || url.searchParams.has("refresh") || Date.now() - agents.at > AGENTS_TTL_MS) {
      agents = { at: Date.now(), list: detectAgents() };
    }
    return agents.list;
  });
  route("PUT", "/api/settings", (_params, body) => orchestrator.saveSettings(body as Partial<NexuraSettings>));
  /** Shared memory of a repo: a full-text search, or the latest when `q` is empty. Zero tokens. */
  route("GET", "/api/memory", async (_params, _body, url) => {
    const repo = loadConfig().repos.find((candidate) => candidate.name === url.searchParams.get("repo"));
    if (!repo) {
      throw new HttpError(404, `Repo desconocido: ${url.searchParams.get("repo")}`);
    }
    const project = await projectOf(repo.path);
    const query = url.searchParams.get("q")?.trim() ?? "";
    return { project, observations: query ? memoryStore().search(project, query, 50) : memoryStore().recent(project, 50) };
  });
  route("GET", "/api/memory/projects", () => memoryStore().projects());
  /** How to give the interactive Claude Code the same memory. */
  route("GET", "/api/memory/mcp", () => ({ command: mcpAddCommand() }));
  route("DELETE", "/api/memory/:id", ([id]) => {
    if (!memoryStore().delete(Number(id))) {
      throw new HttpError(404, `No existe la observación ${id}`);
    }
  });
  /** Panel: open PRs to review and the user's tickets across the configured repos (REST, zero tokens). */
  route("GET", "/api/dashboard/inbox", () => loadInbox(loadConfig().repos, store.listRuns(500)));
  /** Trophies: progress of every achievement (secret ones masked until won). Zero tokens. */
  route("GET", "/api/achievements", () => achievements.summary());
  route("POST", "/api/achievements/seen", () => achievements.markSeen());
  /** What the 3D office reports (through its server): something used, a duck found, a secret. */
  route("POST", "/api/achievements/office", (_params, body) => {
    try {
      return { unlocked: achievements.office(body as OfficeAchievementEvent) };
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  });
  /** What the 3D office shows of Nexura in one go (control room, Hall of Fame, today, reviews, quota). */
  let inboxCache: { at: number; inbox: Promise<DashboardInbox | undefined> } | undefined;
  route("GET", "/api/office/digest", async () => {
    if (!inboxCache || Date.now() - inboxCache.at > 60_000) {
      inboxCache = { at: Date.now(), inbox: loadInbox(loadConfig().repos, store.listRuns(500)).catch(() => undefined) };
    }
    const today = new Date().toDateString();
    return officeDigest({
      runs: store.listRuns(300),
      inbox: await inboxCache.inbox,
      quota: orchestrator.getQuota(),
      trophiesToday: achievements.unlocked().filter((unlock) => new Date(unlock.at).toDateString() === today).map((unlock) => unlock.title),
      coinsToday: rewards.summary().earnedToday,
    });
  });
  /** The office continues a paused flow as proposed, or skips the step (editing stays in Nexura). */
  route("POST", "/api/office/runs/:id/continue", ([id], body) => {
    const run = requireRun(id!);
    orchestrator.continue(run.id, officeContinue(run, Boolean((body as { skip?: unknown } | undefined)?.skip)));
    return { ok: true };
  });
  /** Coins, today's shop, what you own and wear, and your bets. Zero tokens. */
  route("GET", "/api/rewards", () => rewards.summary());
  route("POST", "/api/rewards/buy", (_params, body) => rewards.buy(String((body as { itemId?: unknown })?.itemId ?? "")));
  route("POST", "/api/rewards/equip", (_params, body) => {
    const { slot, itemId } = (body ?? {}) as { slot?: unknown; itemId?: unknown };
    return rewards.equip(String(slot) as ShopSlot, typeof itemId === "string" ? itemId : null);
  });
  route("POST", "/api/rewards/bets", (_params, body) => {
    const { kind, runId, stake } = (body ?? {}) as { kind?: unknown; runId?: unknown; stake?: unknown };
    return rewards.bet({ kind: String(kind) as BetKind, runId: String(runId), stake: Number(stake) });
  });
  /** What the 3D office reports for coins: a daily visit, a duck of this week's season, a game. */
  route("POST", "/api/rewards/office", (_params, body) => {
    const paid = rewards.office((body ?? {}) as OfficeRewardEvent);
    return { ...paid, coins: rewards.summary().coins };
  });
  route("GET", "/api/rewards/trivia", () => rewards.triviaQuestion());
  route("POST", "/api/rewards/trivia", (_params, body) => {
    const { id, option } = (body ?? {}) as { id?: unknown; option?: unknown };
    return rewards.triviaAnswer(String(id), String(option));
  });
  route("GET", "/api/metrics/cost-by-step", () => store.costByStep());
  route("GET", "/api/metrics", (_params, _body, url) => store.metrics(Number(url.searchParams.get("days")) || undefined));
  route("GET", "/api/metrics/account-usage", (_params, _body, url) => accountUsage(url.searchParams.has("refresh")));
  route("POST", "/api/runs/:id/classify-feedback", ([id], body) => {
    const { correct, expected } = body as { correct: boolean; expected?: string };
    return orchestrator.rateClassify(id!, Boolean(correct), expected);
  });

  const server = createServer(async (request, response) => {
    const rejected = rejectReason(request);
    if (rejected) {
      sendJson(response, 403, { error: rejected });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = routes
      .filter((candidate) => candidate.method === request.method)
      .map((candidate) => ({ candidate, params: candidate.pattern.exec(url.pathname) }))
      .find((entry) => entry.params);
    if (!match) {
      if (request.method === "GET" && !url.pathname.startsWith("/api/") && serveStatic(url, response)) {
        return;
      }
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    try {
      const body = request.method === "GET" ? undefined : await readBody(request);
      const params = match.params!.slice(1).map(decodeURIComponent);
      sendJson(response, 200, await match.candidate.handler(params, body, url));
    } catch (error) {
      const status = error instanceof HttpError || error instanceof RewardError ? error.status : 400;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Several WebSocket servers on one HTTP server must route the upgrade themselves.
  const sockets = new WebSocketServer({ noServer: true });
  const conversationSockets = new WebSocketServer({ noServer: true });
  conversationSockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    conversations.attach(socket, params.get("id") ?? "", Number(params.get("cols")), Number(params.get("rows")));
  });
  server.on("upgrade", (request, socket, head) => {
    if (rejectReason(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/ws") {
      sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
    } else if (pathname === "/pty") {
      terminals.handleUpgrade(request, socket, head);
    } else if (pathname === "/cpty") {
      conversationSockets.handleUpgrade(request, socket, head, (ws) => conversationSockets.emit("connection", ws, request));
    } else {
      socket.destroy();
    }
  });
  const clients = new Set<WebSocket>();
  sockets.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    const quota = orchestrator.getQuota();
    if (quota) {
      socket.send(JSON.stringify({ type: "quota", quota } satisfies ServerMessage));
    }
  });
  const broadcast = (message: ServerMessage): void => {
    const data = JSON.stringify(message);
    for (const client of clients) {
      client.send(data);
    }
  };
  orchestrator.on("message", broadcast);
  conversations.on("message", broadcast);
  tickets.on("message", broadcast);
  aiSetup.on("message", broadcast);
  // Achievements watch the same messages the UI gets; theirs (a trophy won) go out too.
  achievements.sync(store.listRuns(1000), tickets.list());
  achievements.on("message", broadcast);
  // Coins pay for what the trophies record: the history quietly the first time, then announced.
  rewards.settle(achievements, false);
  rewards.on("message", broadcast);
  achievements.on("message", () => rewards.settle(achievements, true));
  orchestrator.on("message", (message) => {
    if (message.type === "run") {
      achievements.observeRun(message.run);
      rewards.settle(achievements, true);
      rewards.observeRun(message.run);
    } else if (message.type === "runDeleted") {
      achievements.forgetRun(message.runId);
    }
  });
  tickets.on("message", (message) => {
    if (message.type === "ticketDraft") {
      achievements.observeDraft(message.draft);
      rewards.settle(achievements, true);
    }
  });
  server.on("close", () => {
    conversations.dispose();
    tickets.dispose();
    aiSetup.dispose();
    achievements.close();
    rewards.close();
  });

  return server;
}
