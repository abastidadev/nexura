import { Component, computed, inject, resource, signal } from "@angular/core";
import { DecimalPipe } from "@angular/common";
import { RouterLink } from "@angular/router";
import { AGENT_LABELS, type Metrics } from "@nexura/shared";
import { Api } from "../../core/api";
import { formatTokens, relativeReset, stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

const RANGES = [7, 14, 30] as const;
const PERCENT = 100;

type Bar = { percent: number };

/** Share of the largest value, for inline bars (at least a sliver when the value is not zero). */
function bars<T>(rows: T[], value: (row: T) => number): (T & Bar)[] {
  const max = Math.max(0, ...rows.map(value));
  return rows.map((row) => {
    const v = value(row);
    return { ...row, percent: max > 0 && v > 0 ? Math.max(2, (v / max) * PERCENT) : 0 };
  });
}

function percent(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * PERCENT)} %` : "—";
}

@Component({
  selector: "nx-metrics",
  imports: [RouterLink, DecimalPipe],
  templateUrl: "./metrics.html",
  host: { class: "block h-full overflow-y-auto" },
})
export class MetricsPage {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly ranges = RANGES;
  protected readonly days = signal<number>(14);
  protected readonly accountRefresh = signal(0);
  protected readonly stepLabel = stepLabel;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly formatTokens = formatTokens;
  protected readonly percent = percent;

  /** Reloads when the range changes or a run changes state. */
  protected readonly data = resource({
    params: () => ({ days: this.days(), version: this.store.runs().map((run) => `${run.id}:${run.status}:${run.steps.length}`).join() }),
    loader: ({ params }) => this.api.metrics(params.days),
  });

  protected readonly metrics = computed<Metrics | undefined>(() => (this.data.hasValue() ? this.data.value() : undefined));
  protected readonly accountData = resource({
    params: () => ({ refresh: this.accountRefresh() }),
    loader: ({ params }) => this.api.accountUsage(params.refresh > 0),
  });
  protected readonly accountUsage = computed(() => (!this.accountData.isLoading() && this.accountData.hasValue() ? this.accountData.value() : undefined));
  protected readonly resetIn = (epochSeconds: number): string => relativeReset(epochSeconds, this.store.now());

  protected copilotReset(iso: string | undefined): string {
    if (!iso) return "sin fecha";
    const resetAt = Date.parse(iso);
    if (!Number.isFinite(resetAt)) return "sin fecha";
    return resetAt <= this.store.now() ? "pendiente de actualización" : `en ${this.resetIn(resetAt / 1000)}`;
  }

  protected readonly tiles = computed(() => {
    const m = this.metrics();
    if (!m) {
      return [];
    }
    const finished = m.totals.done + m.totals.failed + m.totals.cancelled;
    return [
      { label: "Flujos", value: String(m.totals.runs), hint: `${m.totals.active} activos ahora` },
      { label: "Terminan bien", value: percent(m.totals.done, finished), hint: `${m.totals.done} de ${finished} finalizados` },
      { label: "Tokens", value: formatTokens(m.totals.tokens), hint: "uso registrado por Nexura" },
      { label: "Tokens por flujo", value: formatTokens(m.totals.runs ? m.totals.tokens / m.totals.runs : 0), hint: "media de todos los flujos" },
      {
        label: "Vueltas",
        value: m.loops.avgImplementPerRun ? m.loops.avgImplementPerRun.toFixed(1) : "—",
        hint: `implement por flujo · ${m.loops.runsWithLoops} con vuelta de review/QA`,
      },
    ];
  });

  protected readonly steps = computed(() => bars(this.metrics()?.byStep ?? [], (row) => row.tokens));
  protected readonly agents = computed(() => bars(this.metrics()?.byAgent ?? [], (row) => row.tokens));
  protected readonly profiles = computed(() => bars(this.metrics()?.byProfile ?? [], (row) => row.tokens));
  protected readonly daysSeries = computed(() => bars(this.metrics()?.byDay ?? [], (row) => row.tokens));
  protected readonly classify = computed(() => this.metrics()?.classify);

  protected dayLabel(day: string): string {
    return new Date(`${day}T12:00:00`).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  }
}
