// What `npm run demo` (scripts/demo.mjs) leaves done before the demo opens, over Nexura's own REST
// API, against the fake agents (no quota): finished flows with real diffs (two of them with a PR the
// fake GitHub reads as merged, so the Hall of Fame has pictures), a failed one, PR reviews in
// Revisiones (one published) and terminal conversations, one of them handed over to another agent.
// Then, on the demo server itself, flows that stay live: one waiting for its PR's go-ahead and one
// step by step.

/** The ticket text that makes the fakes fail at plan (FAKE_FAIL_MARKER). */
export const FAIL_MARKER = "Exportar pedidos a CSV";

const POLL_MS = 300;

function client(base) {
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path}: ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : undefined;
  };
  /** Polls `read` until `done` holds for what it returns. */
  const until = async (what, read, done, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value)) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error(`Tiempo agotado esperando: ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };
  return { api, until };
}

/** Waits until Nexura answers on `base`. */
export async function waitForServer(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/settings`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Nexura no responde en ${base}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const flow = (ticketText, extra = {}) => ({ ticketText, repos: ["sandbox"], tasks: [], prompt: "", profile: "minimal", stepByStep: false, release: "local", ...extra });
const FINAL = new Set(["done", "failed", "cancelled"]);

/** The history: everything here ends before the demo opens (a paused run would not survive the restart). */
export async function seedHistory(base, log = console.log) {
  const { api, until } = client(base);
  const run = (id) => api("GET", `/api/runs/${id}`);

  /** Starts a flow and walks it to the end, approving its PR when it asks. */
  const finish = async (request) => {
    const started = await api("POST", "/api/runs", request);
    let approved = false;
    const ended = await until(`el flujo «${request.ticketText}»`, () => run(started.id), (current) => {
      if (current.status === "paused" && current.pendingStep?.step === "release" && !approved) {
        approved = true;
        void api("POST", `/api/runs/${started.id}/continue`, {});
      }
      return FINAL.has(current.status);
    });
    log(`  ${ended.status === "done" ? "✓" : "✗"} flujo «${request.ticketText}» → ${ended.status}${ended.pullRequests?.length ? ` (PR #${ended.pullRequests[0].id})` : ""}`);
    return ended;
  };

  // The PR watcher checks the flows' PRs every 30 s (the shortest it allows): the two below get merged.
  await api("PUT", "/api/settings", { prPollSeconds: 30 });

  // In this order: the fake implement makes the cart, money and coupons changes in turns.
  const withPr = [
    await finish(flow("Carrito: descuento por volumen a partir de 10 unidades", { profile: "standard", release: "pr" })),
    await finish(flow("Importes con el formato del idioma (1.234,50 €)", { release: "pr", modelConfig: { agent: "copilot", model: "claude-sonnet-5", effort: "medium" } })),
  ];
  await finish(flow("Cupones de descuento en el carrito", { profile: "full", modelConfig: { agent: "codex", model: "gpt-5.5", effort: "high" } }));
  await finish(flow(`${FAIL_MARKER} desde el historial`, { profile: "standard" }));

  // Revisiones: PR #1 reviewed and waiting for you to pick the comments; PR #2 reviewed and published.
  const review = async (prId, reviewer) => {
    const started = await api("POST", "/api/pr-reviews", { repo: "sandbox", prId, ...reviewer });
    const ended = await until(`la revisión de la PR #${prId}`, () => run(started.id), (current) => FINAL.has(current.status));
    log(`  ${ended.status === "done" ? "✓" : "✗"} revisión de la PR #${prId} → ${ended.status} (${ended.prReview?.comments.length ?? 0} comentarios)`);
    return ended;
  };
  await review(1, { agent: "claude", model: "sonnet", effort: "high" });
  const second = await review(2, { agent: "codex", model: "gpt-5.5", effort: "medium" });
  const comments = (second.prReview?.comments ?? []).map((comment) => ({ id: comment.id, post: comment.post }));
  if (comments.length) {
    await api("POST", `/api/runs/${second.id}/publish-review`, { comments, vote: "approveWithSuggestions" });
    log(`  ✓ revisión de la PR #2 publicada (${comments.length} comentarios)`);
  }

  // Terminal: a Claude conversation handed over to Codex, and one with Copilot.
  const history = (id) => api("GET", `/api/conversations/${id}/history`);
  const replies = (count) => (messages) => messages.filter((message) => message.role === "assistant").length >= count;
  const first = await api("POST", "/api/conversations", { kind: "agent", repo: "sandbox", agent: "claude", title: "Cómo se calcula el total", prompt: "¿Cómo se calcula el total del carrito?" });
  await until("la conversación con Claude", () => history(first.id), replies(1));
  await api("POST", `/api/conversations/${first.id}/stop`);
  await api("POST", `/api/conversations/${first.id}/start`, { agent: "codex", prompt: "Añade un test para un carrito vacío" });
  await until("el traspaso a Codex", () => history(first.id), replies(2));
  await api("POST", `/api/conversations/${first.id}/stop`);
  const other = await api("POST", "/api/conversations", { kind: "agent", repo: "sandbox", agent: "copilot", title: "Repaso de los últimos commits", prompt: "Resume los últimos commits del repo" });
  await until("la conversación con Copilot", () => history(other.id), replies(1));
  await api("POST", `/api/conversations/${other.id}/stop`);
  log("  ✓ terminal: Claude → Codex (traspaso) y Copilot");

  const merged = await until(
    "el merge de las PR (el vigilante mira cada 30 s)",
    () => Promise.all(withPr.map((ended) => run(ended.id))),
    (runs) => runs.every((current) => current.reviewWatch?.prStatus === "completed"),
    90_000,
  );
  log(`  ✓ ${merged.length} PR integradas: a la galería de la fama`);
}

/** Flows that stay live in the demo: one waiting for its PR's go-ahead, one step by step. */
export async function seedLive(base, log = console.log) {
  const { api } = client(base);
  await api("POST", "/api/runs", flow("Ficha de cliente: panel de contacto", {
    profile: "standard",
    release: "pr",
    ticketId: "6",
    ticketSource: "github",
    ticketProject: "nexura-fake/sandbox",
  }));
  await api("POST", "/api/runs", flow("Pedidos: columna de estado en el historial", { stepByStep: true }));
  log("  ▶ dos flujos en marcha: uno pedirá el visto bueno de su PR y otro va paso a paso");
}
