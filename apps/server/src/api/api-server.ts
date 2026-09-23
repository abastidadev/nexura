import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  STEP_NAMES,
  type FlowProfile,
  type RepoConfig,
  type RetryOptions,
  type RunRequest,
  type ServerMessage,
  type StepName,
} from "@nexura/shared";
import {
  deleteProfile,
  loadConfig,
  saveProfile,
  saveRepos,
  saveStepDefinition,
  saveStepPrompt,
  type StepDefinitionUpdate,
} from "../config/config-loader.ts";
import { NEXURA_HOME } from "../config/paths.ts";
import { AzureError } from "../azure/azure-client.ts";
import { azureRepoOf } from "../azure/repo-remote.ts";
import { getTicket, ticketToText } from "../azure/work-items.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { RunStore } from "../store/run-store.ts";
import { TerminalServer } from "../terminal/terminal-server.ts";

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
    if (!(STEP_NAMES as readonly string[]).includes(name)) {
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
  route("POST", "/api/runs/:id/cancel", ([id]) => orchestrator.cancel(id!));
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
  route("PUT", "/api/repos", (_params, body) => {
    saveRepos((body as { repos: RepoConfig[] }).repos ?? []);
    orchestrator.setConfig(loadConfig());
  });

  /** Loads a work item (zero tokens). The organisation comes from the chosen repo's origin remote. */
  route("GET", "/api/azure/work-items/:id", async ([id], _body, url) => {
    const repos = loadConfig().repos;
    const wanted = url.searchParams.get("repo");
    const candidates = wanted ? repos.filter((repo) => repo.name === wanted) : repos;
    let organization: string | undefined;
    for (const repo of candidates) {
      organization = (await azureRepoOf(repo.path))?.organization;
      if (organization) {
        break;
      }
    }
    organization ??= process.env.NEXURA_AZURE_ORG;
    if (!organization) {
      throw new HttpError(400, "Ningún repo seleccionado tiene un remote origin de Azure DevOps (o define NEXURA_AZURE_ORG)");
    }
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

  route("GET", "/api/quota", () => orchestrator.getQuota() ?? null);
  route("GET", "/api/metrics/cost-by-step", () => store.costByStep());

  const server = createServer(async (request, response) => {
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
