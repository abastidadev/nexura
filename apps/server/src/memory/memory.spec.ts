import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ftsQuery, MemoryStore, projectFromRemote } from "./memory-store.ts";
import { readMemory } from "./memory.ts";

const root = mkdtempSync(join(tmpdir(), "nexura-memory-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("saves, updates by topic, searches with bm25 and soft-deletes, per project", () => {
    const store = new MemoryStore(":memory:");
    const first = store.save({ project: "shop", type: "decision", title: "Fechas del filtro en UTC", content: "Por las zonas horarias", topicKey: "decision/fechas" });
    store.save({ project: "shop", type: "bugfix", title: "N+1 en el listado de pedidos", content: "Faltaba un include" });
    store.save({ project: "other", type: "pattern", title: "Fechas con dayjs", content: "Otro repo" });

    const updated = store.save({ project: "shop", type: "decision", title: "Fechas del filtro en UTC (v2)", content: "Y en la API", topicKey: "decision/fechas" });
    expect(updated).toMatchObject({ id: first.id, revisions: 2, title: "Fechas del filtro en UTC (v2)" });

    // Accents, case, punctuation and prefixes; only this project.
    expect(store.search("shop", "¿Filtrar por FECHA (pedidos)?").map((o) => o.title).sort()).toEqual(["Fechas del filtro en UTC (v2)", "N+1 en el listado de pedidos"]);
    expect(store.search("shop", "api").map((o) => o.id)).toEqual([first.id]);
    expect(store.search("shop", "de la en")).toEqual([]);
    expect(store.recent("shop").map((o) => o.title).sort()).toEqual(["Fechas del filtro en UTC (v2)", "N+1 en el listado de pedidos"]);

    expect(store.delete(first.id)).toBe(true);
    expect(store.search("shop", "fechas")).toEqual([]);
    expect(store.get(first.id)).toBeUndefined();
    // Its topic is free again.
    expect(store.save({ project: "shop", type: "decision", title: "Fechas otra vez", content: "x", topicKey: "decision/fechas" }).revisions).toBe(1);
    expect(store.projects().map((p) => [p.project, p.observations])).toEqual(
      expect.arrayContaining([
        ["shop", 2],
        ["other", 1],
      ]),
    );
  });

  it("turns free text into a safe FTS5 query", () => {
    // FTS operators and punctuation are just words (or dropped): never a syntax error.
    expect(ftsQuery('Añadir "filtro" OR (fecha) AND NOT x*')).toBe('"anadir"* OR "filtro"* OR "fecha"* OR "not"*');
    expect(ftsQuery("a de la")).toBeUndefined();
  });

  it("names the project after the origin repo", () => {
    expect(projectFromRemote("https://dev.azure.com/Org/Proj/_git/My-Repo")).toBe("my-repo");
    expect(projectFromRemote("git@ssh.dev.azure.com:v3/Org/Proj/My-Repo\n")).toBe("my-repo");
    expect(projectFromRemote("https://github.com/abastidadev/nexura.git")).toBe("nexura");
  });

  it("injects matching memories only, deduplicated across task and step queries and bounded", () => {
    const store = new MemoryStore(":memory:");
    expect(readMemory(store, "shop", "Filtro de fechas")).toBe("");
    store.save({ project: "shop", type: "ticket", title: "Ticket #7: Filtro de fechas", content: "hecho" });
    store.save({ project: "shop", type: "pattern", title: "Usa signals", content: "convención" });
    const text = readMemory(store, "shop", "Filtro de fechas en facturas");
    expect(text).toMatch(/^### Relacionado con este ticket\n#1 \[ticket\] Ticket #7: Filtro de fechas/);
    expect(text).not.toContain("Usa signals");
    expect(text.match(/Ticket #7/g)).toHaveLength(1);
    expect(readMemory(store, "shop", ["fechas", "filtro"]).match(/Ticket #7/g)).toHaveLength(1);
    expect(readMemory(store, "shop", "inventario")).toBe("");
    expect(readMemory(store, "shop", "fechas", 40).length).toBeLessThanOrEqual(40);
    store.save({ project: "shop", type: "ticket", title: "Ticket #7: Filtro de fechas", content: "intento anterior", topicKey: "tickets/7" });
    expect(readMemory(store, "shop", "Filtro de fechas", 6000, "tickets/7")).not.toContain("intento anterior");
    store.close();
  });
});

describe("MCP server", () => {
  const server = join(import.meta.dirname, "mcp-server.ts");

  /** Runs the real server as a process, like claude does, and returns its answers by id. */
  async function call(args: string[], messages: object[]): Promise<Map<number, { result?: any; error?: any }>> {
    const child = spawn(process.execPath, ["--no-warnings", server, ...args], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stdin.end(messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message })).join("\n") + "\n");
    await new Promise((resolve) => child.on("close", resolve));
    return new Map(out.trim().split("\n").map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  }

  const init = { id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

  it("exposes only the read tools in read mode and saves under the given project, step and run", async () => {
    const db = join(root, "memory.sqlite");
    const read = await call(["--db", db, "--mode", "read", "--project", "shop"], [init, { method: "notifications/initialized" }, { id: 1, method: "tools/list" }]);
    expect(read.get(0)!.result.serverInfo.name).toBe("nexura-memory");
    expect(read.get(1)!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["mem_search", "mem_get", "mem_context"]);

    const save = { name: "mem_save", arguments: { title: "Causa del N+1", type: "bugfix", content: "**Qué**: include", topic_key: "bugs/n1" } };
    const write = await call(
      ["--db", db, "--mode", "readwrite", "--project", "shop", "--source", "implement", "--run", "r1"],
      [
        init,
        { id: 1, method: "tools/call", params: save },
        { id: 2, method: "tools/call", params: save },
        { id: 3, method: "tools/call", params: { name: "mem_search", arguments: { query: "causa" } } },
        { id: 4, method: "tools/call", params: { name: "mem_save", arguments: { title: "", type: "bugfix", content: "" } } },
        { id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
      ],
    );
    expect(write.get(1)!.result.content[0].text).toBe("Guardada #1.");
    expect(write.get(2)!.result.content[0].text).toBe("Actualizada #1 (revisión 2).");
    expect(write.get(3)!.result.content[0].text).toContain("#1 [bugfix] Causa del N+1 (topic: bugs/n1)");
    expect(write.get(4)!.result.isError).toBe(true);
    expect(write.get(5)!.error.code).toBe(-32602);

    const store = new MemoryStore(db);
    expect(store.get(1)).toMatchObject({ project: "shop", source: "implement", runId: "r1" });
    store.close();
  });

  it("hides an earlier attempt of the same ticket from every memory read tool", async () => {
    const db = join(root, "exclude.sqlite");
    const store = new MemoryStore(db);
    const old = store.save({ project: "shop", type: "ticket", title: "Ticket #7: filtro", content: "intento anterior", topicKey: "tickets/7" });
    store.save({ project: "shop", type: "pattern", title: "Filtro reusable", content: "convención útil", topicKey: "patterns/filtro" });
    store.close();
    const replies = await call(["--db", db, "--project", "shop", "--mode", "read", "--exclude-topic", "tickets/7"], [
      init,
      { id: 1, method: "tools/call", params: { name: "mem_search", arguments: { query: "filtro" } } },
      { id: 2, method: "tools/call", params: { name: "mem_get", arguments: { id: old.id } } },
      { id: 3, method: "tools/call", params: { name: "mem_context", arguments: {} } },
    ]);
    for (const id of [1, 2, 3]) {
      expect(replies.get(id)!.result.content[0].text).not.toContain("intento anterior");
    }
    expect(replies.get(1)!.result.content[0].text).toContain("Filtro reusable");
  });
});
