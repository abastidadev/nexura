#!/usr/bin/env node
/**
 * MCP server (stdio, JSON-RPC 2.0, one message per line) over Nexura's memory, with no
 * dependencies. The steps get it through `--mcp-config`; the interactive Claude Code can
 * use it too:
 *
 *   claude mcp add --scope user nexura-memory -- node <nexura>/apps/server/src/memory/mcp-server.ts --db <nexura>/data/memory.sqlite
 *
 * Flags:
 *   --db <file>        memory database (required)
 *   --mode read|readwrite   readwrite adds mem_save (default readwrite)
 *   --project <name>   memory project (default: detected from the cwd's git remote)
 *   --source <name>    stored with each save (default "claude-code"; steps pass their name)
 *   --run <id>         Nexura run that saves (stored with each save)
 *   --exclude-topic <key>   topic hidden from this run's memory reads
 */
import { createInterface } from "node:readline";
import { MemoryStore, projectOf, type MemoryObservation } from "./memory-store.ts";

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };
type Tool = { name: string; description: string; inputSchema: object; run: (args: Record<string, unknown>) => Promise<string> | string };

const TYPES = ["bugfix", "decision", "architecture", "discovery", "pattern", "config", "preference"];
const SNIPPET = 300;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function formatList(observations: MemoryObservation[], empty: string): string {
  if (observations.length === 0) {
    return empty;
  }
  return observations
    .map((o) => {
      const snippet = o.content.length > SNIPPET ? o.content.slice(0, SNIPPET) + "…" : o.content;
      return `#${o.id} [${o.type}] ${o.title}${o.topicKey ? ` (topic: ${o.topicKey})` : ""} · ${o.updatedAt.slice(0, 10)}\n${snippet}`;
    })
    .join("\n\n");
}

export function memoryTools(store: MemoryStore, project: () => Promise<string>, mode: string, meta: { source: string; runId?: string; excludeTopic?: string }): Tool[] {
  const visible = (items: MemoryObservation[], limit: number): MemoryObservation[] => items.filter((item) => !meta.excludeTopic || item.topicKey !== meta.excludeTopic).slice(0, limit);
  const tools: Tool[] = [
    {
      name: "mem_search",
      description:
        "Busca en la memoria compartida del proyecto (decisiones, causas de bugs, convenciones, tickets anteriores). Devuelve resultados cortos con su id; usa mem_get para el contenido completo.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Palabras clave" }, limit: { type: "number", description: "Máximo de resultados (10)" } },
        required: ["query"],
      },
      run: async (args) => {
        const limit = Math.min(10, Math.max(1, Number(args["limit"]) || 10));
        return formatList(visible(store.search(await project(), String(args["query"] ?? ""), limit + (meta.excludeTopic ? 10 : 0)), limit), "Sin resultados.");
      },
    },
    {
      name: "mem_get",
      description: "Contenido completo de una observación de la memoria, por id.",
      inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      run: (args) => {
        const found = store.get(Number(args["id"]));
        return found && (!meta.excludeTopic || found.topicKey !== meta.excludeTopic) ? `#${found.id} [${found.type}] ${found.title}\n${found.content}` : `No existe la observación ${String(args["id"])}.`;
      },
    },
    {
      name: "mem_context",
      description: "Lo último que se ha guardado en la memoria del proyecto.",
      inputSchema: { type: "object", properties: { limit: { type: "number", description: "Máximo (10)" } } },
      run: async (args) => {
        const limit = Math.min(10, Math.max(1, Number(args["limit"]) || 10));
        return formatList(visible(store.recent(await project(), limit + (meta.excludeTopic ? 10 : 0)), limit), "La memoria del proyecto está vacía.");
      },
    },
  ];
  if (mode === "readwrite") {
    tools.push({
      name: "mem_save",
      description:
        "Guarda en la memoria compartida algo que sirva a un ticket futuro: una decisión y su porqué, la causa raíz de un bug, una convención no escrita, una trampa. Con un topic_key existente actualiza esa observación en vez de duplicarla.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Verbo + qué, corto y buscable" },
          type: { type: "string", enum: TYPES },
          content: { type: "string", description: "**Qué** / **Por qué** / **Dónde** / **Aprendido**" },
          topic_key: { type: "string", description: "Opcional, p. ej. architecture/auth-model, para temas que evolucionan" },
        },
        required: ["title", "type", "content"],
      },
      run: async (args) => {
        const title = String(args["title"] ?? "").trim();
        const content = String(args["content"] ?? "").trim();
        if (!title || !content) {
          throw new Error("title y content son obligatorios");
        }
        const type = TYPES.includes(String(args["type"])) ? String(args["type"]) : "discovery";
        const saved = store.save({
          project: await project(),
          type,
          title,
          content,
          topicKey: args["topic_key"] ? String(args["topic_key"]) : undefined,
          source: meta.source,
          runId: meta.runId,
        });
        return saved.revisions > 1 ? `Actualizada #${saved.id} (revisión ${saved.revisions}).` : `Guardada #${saved.id}.`;
      },
    });
  }
  return tools;
}

/** Answers one JSON-RPC message; undefined for notifications. */
export async function handle(message: JsonRpcMessage, tools: Tool[]): Promise<object | undefined> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: String(message.params?.["protocolVersion"] ?? "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "nexura-memory", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((candidate) => candidate.name === message.params?.["name"]);
      if (!tool) {
        return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Herramienta desconocida: ${String(message.params?.["name"])}` } };
      }
      try {
        const text = await tool.run((message.params?.["arguments"] as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: "text", text }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Método no soportado: ${message.method}` } };
  }
}

async function main(): Promise<void> {
  const db = flag("db");
  if (!db) {
    process.stderr.write("nexura-memory: falta --db <fichero>\n");
    process.exit(2);
  }
  const store = new MemoryStore(db);
  const fixed = flag("project");
  let detected: Promise<string> | undefined;
  const project = (): Promise<string> => (fixed ? Promise.resolve(fixed) : (detected ??= projectOf(process.cwd())));
  const tools = memoryTools(store, project, flag("mode") ?? "readwrite", { source: flag("source") ?? "claude-code", runId: flag("run"), excludeTopic: flag("exclude-topic") });

  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) {
      continue;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON no válido" } }) + "\n");
      continue;
    }
    const response = await handle(message, tools);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
  store.close();
}

if (import.meta.main) {
  await main();
}
