import { Component, inject, linkedSignal, signal } from "@angular/core";
import { DEFAULT_SETTINGS, type NexuraSettings } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";

@Component({
  selector: "nx-general-settings",
  template: `
    <section class="flex max-w-3xl flex-col gap-5 rounded-lg border border-border bg-surface p-4">
      <div>
        <h2 class="font-semibold">Cuota del plan</h2>
        <p class="mt-1 text-[12px] text-muted">
          El uso de las ventanas de 5 h y 7 días llega en cada llamada a Claude (no hay forma gratuita de consultarlo aparte).
          Incluye todo tu uso de Claude, también las sesiones interactivas. Con el umbral, Nexura no lanza pasos nuevos con Claude
          mientras la ventana de 5 h esté por encima, y sigue sola cuando se reinicia; los pasos sin LLM siguen corriendo.
        </p>
        <label class="mt-3 flex items-center gap-2">
          Pausar pasos con Claude al llegar al
          <input
            type="number"
            min="1"
            max="100"
            placeholder="nunca"
            class="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono outline-none focus:border-accent"
            [value]="draft().quotaPausePercent ?? ''"
            (input)="setQuota(value($event))"
          />
          % de la ventana de 5 h
        </label>
      </div>

      <div>
        <h2 class="font-semibold">Comentarios de PR</h2>
        <p class="mt-1 text-[12px] text-muted">
          Cada cuánto se revisan (por REST, gratis) las PRs abiertas de los flujos terminados. Solo avisa y marca la pestaña;
          nunca lanza Claude por su cuenta. Deja de vigilar una PR cuando se completa o se abandona.
        </p>
        <label class="mt-3 flex items-center gap-2">
          Revisar cada
          <input
            type="number"
            min="0"
            step="30"
            class="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono outline-none focus:border-accent"
            [value]="draft().prPollSeconds"
            (input)="patch({ prPollSeconds: +value($event) })"
          />
          segundos <span class="text-[12px] text-muted">(0 = apagado, mínimo 30)</span>
        </label>
      </div>

      <div class="flex items-center gap-2">
        <button type="button" class="rounded-md bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40" [disabled]="busy()" (click)="save()">
          Guardar
        </button>
        @if (message(); as msg) {
          <span [class]="msg.ok ? 'text-ok' : 'text-err'" role="status">{{ msg.text }}</span>
        }
      </div>
    </section>
  `,
})
export class GeneralSettings {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly draft = linkedSignal<NexuraSettings>(() => ({ ...(this.store.settings() ?? DEFAULT_SETTINGS) }));
  protected readonly busy = signal(false);
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected patch(changes: Partial<NexuraSettings>): void {
    this.draft.update((draft) => ({ ...draft, ...changes }));
  }

  protected setQuota(text: string): void {
    this.patch({ quotaPausePercent: text.trim() ? Number(text) : null });
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      this.store.settings.set(await this.api.saveSettings(this.draft()));
      this.message.set({ ok: true, text: "Guardado. Se aplica al momento." });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo guardar") });
    } finally {
      this.busy.set(false);
    }
  }
}
