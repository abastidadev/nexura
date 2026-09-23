import { Component, computed, inject } from "@angular/core";
import { relativeReset } from "../core/format";
import { NexuraStore } from "../core/nexura-store";

type Window = { key: string; label: string; percent: number; resets: string; tone: string; reset: boolean };

const WARN_AT = 70;
const DANGER_AT = 90;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

/**
 * Plan usage windows (5 h / 7 days). The data comes from the rate_limit_event of every
 * Claude call (there is no free way to ask for it), so between flows it can be old: the
 * meter says how old, counts down to the reset locally, and drops to 0 % once a window
 * has reset. It includes all Claude usage of the account, not only Nexura's.
 */
@Component({
  selector: "nx-quota-meter",
  template: `
    @if (windows().length) {
      <div class="flex items-center gap-3" [attr.title]="title()">
        @for (window of windows(); track window.key) {
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] text-muted">{{ window.label }}</span>
            <div
              class="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3"
              role="meter"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="window.percent"
              [attr.aria-label]="'Cuota ' + window.label + ': ' + window.percent + '%, ' + window.resets"
            >
              <div class="h-full rounded-full" [class]="window.tone" [style.width.%]="window.percent"></div>
            </div>
            <span class="w-8 text-right font-mono text-[11px] text-fg-soft">{{ window.percent }}%</span>
          </div>
        }
        @if (paused()) {
          <span class="rounded bg-warn-soft px-1.5 text-[10px] font-medium text-warn">⏸ pasos en espera</span>
        }
        @if (age(); as label) {
          <span class="text-[10px] text-muted">{{ label }}</span>
        }
      </div>
    } @else {
      <span class="text-[11px] text-muted" title="Aparece tras el primer paso ejecutado">Cuota: sin datos</span>
    }
  `,
})
export class QuotaMeter {
  private readonly store = inject(NexuraStore);

  protected readonly windows = computed<Window[]>(() => {
    const quota = this.store.quota();
    const now = this.store.now();
    const result: Window[] = [];
    const add = (key: string, label: string, value?: { utilization: number; resetsAt: number }): void => {
      if (!value) {
        return;
      }
      const reset = value.resetsAt * MS_PER_SECOND <= now;
      const percent = reset ? 0 : Math.round(value.utilization * 100);
      const tone = percent >= DANGER_AT ? "bg-err" : percent >= WARN_AT ? "bg-warn" : "bg-ok";
      result.push({
        key,
        label,
        percent,
        reset,
        tone,
        resets: reset ? "ventana reiniciada" : `se reinicia en ${relativeReset(value.resetsAt, now)}`,
      });
    };
    add("5h", "5 h", quota?.fiveHour);
    add("7d", "7 d", quota?.sevenDay);
    return result;
  });

  /** Claude steps are held while the 5 h window is at/above the configured threshold. */
  protected readonly paused = computed(() => {
    const limit = this.store.settings()?.quotaPausePercent;
    const fiveHour = this.windows().find((window) => window.key === "5h");
    return limit != null && fiveHour !== undefined && !fiveHour.reset && fiveHour.percent >= limit;
  });

  /** How old the data is, shown only when it is more than a minute old. */
  protected readonly age = computed(() => {
    const updatedAt = this.store.quota()?.updatedAt;
    if (!updatedAt) {
      return "";
    }
    const minutes = Math.floor((this.store.now() - Date.parse(updatedAt)) / MS_PER_MINUTE);
    if (minutes < 1) {
      return "";
    }
    return minutes < 60 ? `hace ${minutes} min` : `hace ${Math.floor(minutes / 60)} h`;
  });

  protected readonly title = computed(() => {
    const limit = this.store.settings()?.quotaPausePercent;
    return [
      ...this.windows().map((window) => `${window.label}: ${window.percent}% · ${window.resets}`),
      "Incluye todo tu uso de Claude (también el interactivo), no solo el de Nexura.",
      "Se actualiza con cada paso que ejecuta Claude; consultarla aparte gastaría cuota.",
      limit != null ? `Con el 5 h ≥ ${limit}% Nexura no lanza pasos nuevos con Claude hasta el reinicio.` : "Sin umbral de pausa.",
    ].join("\n");
  });
}
