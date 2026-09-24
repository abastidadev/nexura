import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  STEP_NAMES,
  type FlowProfile,
  type NexuraSettings,
  type RepoConfig,
  type RetryOptions,
  type RunRequest,
  type ServerMessage,
  type StepName,
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
import { azureRepoOf } from "../azure/repo-remote.ts";
import { getTicket, listOpenTickets, ticketToText } from "../azure/work-items.ts";
import { pickFolder } from "../system/folder-picker.ts";
import { Ledger } from "../ledger/ledger.ts";
import { mcpAddCommand, memoryStore } from "../memory/memory.ts";
import { projectOf } from "../memory/memory-store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { RunStore } from "../store/run-store.ts";
import { TerminalServer } from "../terminal/terminal-server.ts";
import { readRepoNotes, saveRepoNotes } from "../workspace/repo-context.ts";

const WEB_DIST = join(NEXURA_HOME, "apps", "web", "dist", "web", "browser");
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

export function createApiServer(orchestrator: Orchestrator, store: RunStore): Server {
  const routes: Route[] = [];
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
  route("POST", "/api/runs/:id/cleanup", ([id], body) =>
    orchestrator.cleanup(id!, Boolean((body as { deleteBranches?: boolean }).deleteBranches)),
  );

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

  /** Organisation (and project) from the chosen repo's origin remote, or from the first Azure repo. */
  const azureTarget = async (wanted: string | null): Promise<{ organization: string; project?: string }> => {
    const repos = loadConfig().repos;
    for (const repo of wanted ? repos.filter((candidate) => candidate.name === wanted) : repos) {
      const remote = await azureRepoOf(repo.path);
      if (remote) {
        return remote;
      }
    }
    if (process.env.NEXURA_AZURE_ORG) {
      return { organization: process.env.NEXURA_AZURE_ORG, project: process.env.NEXURA_AZURE_PROJECT };
    }
    throw new HttpError(400, "Ningún repo seleccionado tiene un remote origin de Azure DevOps (o define NEXURA_AZURE_ORG)");
  };

  /** Open tickets (backlog + in progress) to pick from when creating a flow. Zero tokens. */
  route("GET", "/api/azure/work-items", async (_params, _body, url) => {
    const scope: WorkItemScope = url.searchParams.get("scope") === "project" ? "project" : "mine";
    const { organization, project } = await azureTarget(url.searchParams.get("repo"));
    try {
      return await listOpenTickets(organization, scope, project);
    } catch (error) {
      throw new HttpError(502, String((error as Error).message));
    }
  });

  /** Loads a work item (zero tokens). The organisation comes from the chosen repo's origin remote. */
  route("GET", "/api/azure/work-items/:id", async ([id], _body, url) => {
    const { organization } = await azureTarget(url.searchParams.get("repo"));
    const workItemId = Number(id);
    if (!Number.isInteger(workItemId) || workItemId <= 0) {
      throw new HttpError(400, `ID de work item no válido: ${id}`);
    }
    try {
      const ticket = await getTicket(organization, workItemId);
      return { ticket, text: ticketToText(ticket) };
    } catch (error) {
      throw new HttpError(error instanceof AzureError && error.status === 404 ? 404 : 502, String((error as Error).message));
    }
  });

  /** Native folder dialog on the machine running Nexura (it is a local app). */
  route("POST", "/api/system/pick-folder", async (_params, body) => ({
    path: await pickFolder(String((body as { initial?: string }).initial ?? "")),
  }));
  route("GET", "/api/quota", () => orchestrator.getQuota() ?? null);
  route("GET", "/api/settings", () => orchestrator.getSettings());
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
  const terminals = new TerminalServer(store);
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
  orchestrator.on("message", (message) => {
    const data = JSON.stringify(message);
    for (const client of clients) {
      client.send(data);
    }
  });

  return server;
}
