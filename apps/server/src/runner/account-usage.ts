import { spawn } from "node:child_process";
import { CopilotClient } from "@github/copilot-sdk";
import type { AgentAccountUsage } from "@nexura/shared";
import { codexAdapter } from "./codex-adapter.ts";
import { claudeEnv, resolveClaudeCommand } from "./claude-process.ts";

const TIMEOUT_MS = 10_000;
const CACHE_MS = 60_000;
const MAX_LINE_BYTES = 1_000_000;
const CLAUDE_RESET_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CLAUDE_RESET_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

/** Resolve the date and IANA timezone from Claude's English /usage reset label. */
export function parseClaudeReset(text: string, now = Date.now()): number | undefined {
  const match = text.match(/^([a-z]{3})\s+(\d{1,2})(?: at|,)\s+(\d{1,2})(?::(\d{2}))?(am|pm)\s+\(([^)]+)\)$/i);
  if (!match) return undefined;
  const month = CLAUDE_RESET_MONTHS.indexOf(match[1]!.toLowerCase());
  const day = Number(match[2]);
  const hour = Number(match[3]) % 12 + (match[5]!.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(match[4] ?? 0);
  if (month < 0 || day < 1 || day > 31 || Number(match[3]) < 1 || Number(match[3]) > 12 || minute > 59) return undefined;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: match[6], year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
    });
    const parts = (epoch: number): { year: number; month: number; day: number; hour: number; minute: number } => Object.fromEntries(
      formatter.formatToParts(new Date(epoch)).filter((part) => ["year", "month", "day", "hour", "minute"].includes(part.type)).map((part) => [part.type, Number(part.value)]),
    ) as { year: number; month: number; day: number; hour: number; minute: number };
    const localEpoch = (epoch: number): number => {
      const value = parts(epoch);
      return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
    };
    const currentYear = parts(now).year;
    for (const year of [currentYear, currentYear + 1]) {
      const target = Date.UTC(year, month, day, hour, minute);
      let candidate = target;
      for (let attempt = 0; attempt < 3; attempt++) candidate += target - localEpoch(candidate);
      if (localEpoch(candidate) === target && candidate >= now && candidate - now <= CLAUDE_RESET_WINDOW_MS) return candidate / 1000;
    }
  } catch {
    // Keep the text when the CLI returns an unknown timezone.
  }
  return undefined;
}

/** Claude's /usage report is text even with --output-format json. Ignore unknown formats. */
export function claudeWindows(report: string): AgentAccountUsage["claude"] | undefined {
  const windows: NonNullable<AgentAccountUsage["claude"]>["windows"] = [];
  const clean = report.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  for (const [label, pattern] of [
    ["5 h", /^Current session:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s*(.*))?$/im],
    ["7 d", /^Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s*(.*))?$/im],
  ] as const) {
    const match = clean.match(pattern);
    if (!match) continue;
    const usedPercent = Number(match[1]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    const resetText = match[2]?.trim();
    const resetsAt = resetText ? parseClaudeReset(resetText) : undefined;
    windows.push({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}), ...(resetText ? { resetText } : {}) });
  }
  return windows.length ? { windows, updatedAt: new Date().toISOString() } : undefined;
}

export function parseClaudeUsage(output: string): AgentAccountUsage["claude"] | undefined {
  try {
    const result = JSON.parse(output) as {
      result?: string;
      is_error?: boolean;
      num_turns?: number;
      duration_api_ms?: number;
      usage?: Record<string, unknown>;
      total_cost_usd?: number;
    };
    if (result.is_error || result.num_turns !== 0 || result.duration_api_ms !== 0 || typeof result.result !== "string") return undefined;
    const tokenFields = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
    if (!result.usage || tokenFields.some((field) => result.usage?.[field] !== 0) || (result.total_cost_usd !== undefined && result.total_cost_usd !== 0)) return undefined;
    return claudeWindows(result.result);
  } catch {
    return undefined;
  }
}

/** Runs Claude's local /usage command. A valid answer has zero model turns and zero tokens. */
export function readClaudeUsage(): Promise<AgentAccountUsage["claude"]> {
  return new Promise((resolve) => {
    let command: ReturnType<typeof resolveClaudeCommand>;
    try {
      command = resolveClaudeCommand();
    } catch {
      resolve(undefined);
      return;
    }
    const child = spawn(command.command, [
      ...command.prefixArgs, "-p", "/usage", "--output-format", "json",
      "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--tools", "",
    ], { cwd: process.cwd(), env: claudeEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    let settled = false;
    const finish = (value?: AgentAccountUsage["claude"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), 15_000);
    child.on("error", () => finish());
    child.on("exit", (code) => {
      if (code !== 0) return finish();
      finish(parseClaudeUsage(output));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_LINE_BYTES) finish();
    });
  });
}

type CodexWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
type CodexLimits = { primary?: CodexWindow | null; secondary?: CodexWindow | null };

export function codexWindows(result: unknown): AgentAccountUsage["codex"] | undefined {
  const response = result as { rateLimits?: CodexLimits | null; rateLimitsByLimitId?: Record<string, CodexLimits> } | null;
  const limits = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  if (!limits) {
    return undefined;
  }
  const windows = [limits.primary, limits.secondary].flatMap((window) => {
    if (!window || !Number.isFinite(window.usedPercent) || !Number.isFinite(window.resetsAt)) {
      return [];
    }
    const minutes = window.windowDurationMins;
    const label = minutes && minutes >= 1440 ? `${Math.round(minutes / 1440)} d` : minutes && minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes ?? "?"} min`;
    return [{ label, usedPercent: Math.max(0, Math.min(100, window.usedPercent!)), resetsAt: window.resetsAt! }];
  });
  return windows.length ? { windows, updatedAt: new Date().toISOString() } : undefined;
}

/** Reads the authenticated Codex account via the documented app-server RPC. No thread or turn is started. */
export function readCodexUsage(): Promise<AgentAccountUsage["codex"]> {
  return new Promise((resolve) => {
    let command: ReturnType<typeof codexAdapter.command>;
    try {
      command = codexAdapter.command();
    } catch {
      resolve(undefined);
      return;
    }
    const child = spawn(command.command, [...command.prefixArgs, "app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let settled = false;
    let buffer = "";
    const finish = (value?: AgentAccountUsage["codex"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), TIMEOUT_MS);
    const send = (message: unknown): void => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.on("error", () => finish());
    child.on("exit", () => finish());
    child.stdin.on("error", () => finish());
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) {
        finish();
        return;
      }
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (message.id === 0) {
            if (message.error) return finish();
            send({ method: "initialized", params: {} });
            send({ method: "account/rateLimits/read", id: 1 });
          } else if (message.id === 1) {
            finish(message.error ? undefined : codexWindows(message.result));
          }
        } catch {
          // Ignore unrelated output and notifications.
        }
      }
    });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "nexura", title: "Nexura", version: "0.1.0" } } });
  });
}

/** Reads Copilot's account allowance from the signed-in CLI credentials; no session is created. */
export async function readCopilotUsage(): Promise<AgentAccountUsage["copilot"]> {
  const client = new CopilotClient();
  try {
    await client.start();
    const { quotaSnapshots } = await client.rpc.account.getQuota({});
    const quota = quotaSnapshots.premium_interactions;
    if (!quota || quota.entitlementRequests <= 0) {
      return undefined;
    }
    return {
      used: quota.usedRequests,
      allowance: quota.entitlementRequests,
      remainingPercent: quota.remainingPercentage,
      resetsAt: quota.resetDate,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  } finally {
    try {
      await client.stop();
    } catch {
      // A failed helper must not break the metrics endpoint.
    }
  }
}

let cached: { at: number; value: AgentAccountUsage } | undefined;
let pending: Promise<AgentAccountUsage> | undefined;

/** Short-lived cache avoids starting two local CLI helper processes for every page reload. */
export function accountUsage(refresh = false): Promise<AgentAccountUsage> {
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) {
    return Promise.resolve(cached.value);
  }
  if (!pending) {
    pending = Promise.allSettled([readClaudeUsage(), readCodexUsage(), readCopilotUsage()])
      .then(([claudeResult, codexResult, copilotResult]) => {
        const claude = claudeResult.status === "fulfilled" ? claudeResult.value : undefined;
        const codex = codexResult.status === "fulfilled" ? codexResult.value : undefined;
        const copilot = copilotResult.status === "fulfilled" ? copilotResult.value : undefined;
        const value = { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}), ...(copilot ? { copilot } : {}) };
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => { pending = undefined; });
  }
  return pending;
}
