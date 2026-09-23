import { Component, computed, inject } from "@angular/core";
import { relativeReset } from "../core/format";
import { NexuraStore } from "../core/nexura-store";

type Window = { key: string; label: string; percent: number; resets: string; tone: string };

const WARN_AT = 70;
const DANGER_AT = 90;

/** Live usage of the Claude plan windows (5 h / 7 days), from the stream's rate_limit_event. */
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
              [attr.aria-label]="'Cuota ' + window.label + ': ' + window.percent + '%, se reinicia en ' + window.resets"
            >
              <div class="h-full rounded-full" [class]="window.tone" [style.width.%]="window.percent"></div>
            </div>
            <span class="w-8 text-right font-mono text-[11px] text-fg-soft">{{ window.percent }}%</span>
          </div>
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
      const percent = Math.round(value.utilization * 100);
      const tone = percent >= DANGER_AT ? "bg-err" : percent >= WARN_AT ? "bg-warn" : "bg-ok";
      result.push({ key, label, percent, resets: relativeReset(value.resetsAt, now), tone });
    };
    add("5h", "5 h", quota?.fiveHour);
    add("7d", "7 d", quota?.sevenDay);
    return result;
  });

  protected readonly title = computed(() =>
    this.windows()
      .map((window) => `${window.label}: ${window.percent}% · se reinicia en ${window.resets}`)
      .join("\n"),
  );
}
