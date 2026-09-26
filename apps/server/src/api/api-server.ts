import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  STEP_NAMES,
  TICKET_SOURCES,
  type AgentInfo,
  type ConversationChange,
  type ConversationImage,
  type ConversationUpdate,
  type FlowProfile,
  type NewConversation,
  type NexuraSettings,
  type RepoConfig,
  type RetryOptions,
  type RunRequest,
  type ServerMessage,
  type StepName,
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
import { AzureError } from "../azure/azure-client.ts";
import { ConversationManager } from "../conversations/conversation-manager.ts";
import { ConversationStore } from "../conversations/conversation-store.ts";
import { repoRemoteOf } from "../forge/remote.ts";
import { listTickets, loadTicket, ticketTarget, ticketToText, type TicketTarget } from "../forge/tickets.ts";
import { GithubError } from "../github/github-client.ts";
import { pickFolder } from "../system/folder-picker.ts";
import { Ledger } from "../ledger/ledger.ts";
import { mcpAddCommand, memoryStore } from "../memory/memory.ts";
import { detectAgents } from "../runner/agents.ts";
import { accountUsage } from "../runner/account-usage.ts";
import { claudeInventory } from "../workspace/claude-inventory.ts";
import { projectOf } from "../memory/memory-store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { RunStore } from "../store/run-store.ts";
import { TerminalServer } from "../terminal/terminal-server.ts";
import { readRepoNotes, saveRepoNotes } from "../workspace/repo-context.ts";

const WEB_DIST = join(NEXURA_HOME, "apps", "web", "dist", "web", "browser");
const AGENTS_TTL_MS = 60_000;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
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
): Server {
  const routes: Route[] = [];
  const terminals = new TerminalServer(store);
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

  /** Native folder dialog on the machine running Nexura (it is a local app). */
  route("POST", "/api/system/pick-folder", async (_params, body) => ({
    path: await pickFolder(String((body as { initial?: string }).initial ?? "")),
  }));
  route("GET", "/api/quota", () => orchestrator.getQuota() ?? null);
  route("GET", "/api/settings", () => orchestrator.getSettings());
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
      const status = error instanceof HttpError ? error.status : 400;
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
  server.on("close", () => conversations.dispose());

  return server;
}
