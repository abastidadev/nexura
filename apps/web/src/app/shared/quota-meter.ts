import { Component, computed, DestroyRef, ElementRef, inject, resource, signal, viewChild } from "@angular/core";
import { DecimalPipe } from "@angular/common";
import { RouterLink } from "@angular/router";
import { Api } from "../core/api";
import { relativeReset } from "../core/format";
import { NexuraStore } from "../core/nexura-store";
import { Icon } from "./icon";

type Window = { key: string; label: string; percent: number; resets: string; tone: string };
type Summary = { label: string; percent: number | null };

const WARN_AT = 70;
const DANGER_AT = 90;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

function tone(percent: number): string {
  return percent >= DANGER_AT ? "bg-err" : percent >= WARN_AT ? "bg-warn" : "bg-ok";
}

/** Account quotas in a compact header indicator. */
@Component({
  selector: "nx-quota-meter",
  imports: [DecimalPipe, RouterLink, Icon],
  templateUrl: "./quota-meter.html",
  host: { "(document:pointerdown)": "closeOnOutsidePointer($event)" },
})
export class QuotaMeter {
  private readonly store = inject(NexuraStore);
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);
  private readonly panel = viewChild<ElementRef<HTMLDetailsElement>>("panel");

  protected readonly refreshCount = signal(0);
  private readonly pollTick = signal(0);
  protected readonly accountData = resource({
    params: () => `${this.pollTick()}:${this.refreshCount()}`,
    loader: () => this.api.accountUsage(this.refreshCount() > 0),
  });
  protected readonly accountUsage = computed(() => (!this.accountData.isLoading() && this.accountData.hasValue() ? this.accountData.value() : undefined));

  protected readonly claudeWindows = computed<Window[]>(() => this.accountUsage()?.claude?.windows.map((window) => ({
    key: window.label,
    label: window.label,
    percent: window.usedPercent,
    tone: tone(window.usedPercent),
    resets: window.resetsAt ? `Se reinicia en ${relativeReset(window.resetsAt, this.store.now())}` : window.resetText ? `Se reinicia ${window.resetText}` : "",
  })) ?? []);

  protected readonly summaries = computed<Summary[]>(() => {
    const account = this.accountUsage();
    return [
      { label: "Claude", percent: this.claudeWindows().find((window) => window.label === "5 h")?.percent ?? null },
      { label: "Codex", percent: account?.codex?.windows[0]?.usedPercent ?? null },
      { label: "Copilot", percent: account?.copilot ? 100 - account.copilot.remainingPercent : null },
    ];
  });

  protected readonly paused = computed(() => {
    const limit = this.store.settings()?.quotaPausePercent;
    const fiveHour = this.store.quota()?.fiveHour;
    return limit != null && fiveHour !== undefined && fiveHour.resetsAt * MS_PER_SECOND > this.store.now() && fiveHour.utilization * 100 >= limit;
  });

  protected readonly claudeAge = computed(() => {
    const updatedAt = this.accountUsage()?.claude?.updatedAt;
    if (!updatedAt) return "";
    const minutes = Math.floor((this.store.now() - Date.parse(updatedAt)) / MS_PER_MINUTE);
    if (minutes < 1) return "";
    return minutes < 60 ? `hace ${minutes} min` : `hace ${Math.floor(minutes / 60)} h`;
  });

  protected readonly tone = tone;

  public constructor() {
    const timer = setInterval(() => this.pollTick.update((tick) => tick + 1), MS_PER_MINUTE);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected closeOnOutsidePointer(event: PointerEvent): void {
    const panel = this.panel()?.nativeElement;
    if (panel?.open && !event.composedPath().includes(panel)) panel.open = false;
  }

  protected resetIn(epochSeconds: number): string {
    return relativeReset(epochSeconds, this.store.now());
  }

  protected copilotReset(iso: string | undefined): string {
    if (!iso) return "sin fecha";
    const resetAt = Date.parse(iso);
    if (!Number.isFinite(resetAt)) return "sin fecha";
    return resetAt <= this.store.now() ? "pendiente de actualización" : `en ${this.resetIn(resetAt / MS_PER_SECOND)}`;
  }
}
