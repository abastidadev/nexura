import type { RunStatus, StepStatus } from "@nexura/shared";

export type Tone = "ok" | "err" | "warn" | "info" | "accent" | "muted";

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone; live: boolean }> = {
  queued: { label: "En cola", tone: "muted", live: false },
  running: { label: "Ejecutando", tone: "info", live: true },
  paused: { label: "En pausa", tone: "warn", live: false },
  "waiting-rate-limit": { label: "Esperando cuota", tone: "warn", live: true },
  failed: { label: "Falló", tone: "err", live: false },
  done: { label: "Terminado", tone: "ok", live: false },
  cancelled: { label: "Cancelado", tone: "muted", live: false },
};

export const STEP_STATUS: Record<StepStatus, { label: string; tone: Tone; icon: string }> = {
  pending: { label: "Pendiente", tone: "muted", icon: "○" },
  running: { label: "Ejecutando", tone: "info", icon: "◉" },
  succeeded: { label: "OK", tone: "ok", icon: "✓" },
  failed: { label: "Falló", tone: "err", icon: "✕" },
  skipped: { label: "Saltado", tone: "muted", icon: "⤼" },
};

export const STEP_LABELS: Record<string, string> = {
  classify: "Clasificar",
  enrich: "Investigar",
  plan: "Plan",
  implement: "Implementar",
  codeReview: "Code review",
  qaCode: "QA (checks)",
  release: "Release",
  qaNotes: "Notas QA",
  addressReview: "Responder PR",
};

/** Tailwind classes per tone: [text, soft background]. Static strings so Tailwind can see them. */
export const TONE_CLASSES: Record<Tone, { text: string; bg: string; dot: string }> = {
  ok: { text: "text-ok", bg: "bg-ok-soft", dot: "bg-ok" },
  err: { text: "text-err", bg: "bg-err-soft", dot: "bg-err" },
  warn: { text: "text-warn", bg: "bg-warn-soft", dot: "bg-warn" },
  info: { text: "text-info", bg: "bg-info-soft", dot: "bg-info" },
  accent: { text: "text-accent", bg: "bg-accent-soft", dot: "bg-accent" },
  muted: { text: "text-muted", bg: "bg-surface-3", dot: "bg-muted" },
};

export function formatCost(usd: number | undefined): string {
  if (!usd) {
    return "$0";
  }
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
}

export function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function elapsedMs(start: string | undefined, end: string | undefined, now: number): number {
  if (!start) {
    return 0;
  }
  return (end ? Date.parse(end) : now) - Date.parse(start);
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function relativeReset(epochSeconds: number, now: number): string {
  const minutes = Math.max(0, Math.round((epochSeconds * 1000 - now) / 60000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
