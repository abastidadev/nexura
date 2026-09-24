import { Component, inject, linkedSignal, signal } from "@angular/core";
import { DEFAULT_SETTINGS, type MemoryStatus, type NexuraSettings } from "@nexura/shared";
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

      <div>
        <h2 class="font-semibold">Memoria compartida (engram)</h2>
        <p class="mt-1 text-[12px] text-muted">
          Los pasos con memoria (se elige en cada paso) reciben lo que se sabe del ticket y del repo, y pueden buscar y guardar decisiones,
          causas raíz y convenciones. Al acabar cada ticket, Nexura guarda un resumen sin gastar tokens. Es la misma memoria que usa tu Claude Code
          interactivo con el plugin de engram, y se puede compartir con el equipo con <code class="font-mono">engram sync</code>. Sin engram,
          los pasos siguen usando las notas aprendidas del repo.
        </p>
        <label class="mt-3 flex cursor-pointer items-center gap-2">
          <input type="checkbox" class="size-4 accent-accent" [checked]="draft().memoryEnabled" (change)="patch({ memoryEnabled: !draft().memoryEnabled })" />
          Usar la memoria compartida
        </label>
        <label class="mt-2 flex items-center gap-2">
          Binario de engram
          <input
            type="text"
            spellcheck="false"
            placeholder="engram (en el PATH)"
            class="w-96 max-w-full rounded-md border border-border bg-surface-2 px-2 py-1 font-mono outline-none focus:border-accent"
            [value]="draft().engramBin"
            (input)="patch({ engramBin: value($event) })"
          />
        </label>
        <p class="mt-2 text-[12px]" role="status">
          @if (memory(); as status) {
            @if (status.available) {
              <span class="text-ok">{{ status.version }}</span> <span class="font-mono text-muted">{{ status.bin }}</span>
              @if (!status.enabled) {
                <span class="text-muted"> · desactivada</span>
              }
            } @else {
              <span class="text-err">{{ status.error }}.</span>
              <span class="text-muted">
                Instálalo desde
                <a class="underline" href="https://github.com/Gentleman-Programming/engram/releases" target="_blank" rel="noopener">las releases de engram</a>
                y guarda de nuevo.
              </span>
            }
          } @else {
            <span class="text-muted">Comprobando engram…</span>
          }
        </p>
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
  protected readonly memory = signal<MemoryStatus | null>(null);

  public constructor() {
    void this.checkMemory();
  }

  private async checkMemory(): Promise<void> {
    try {
      this.memory.set(await this.api.getMemoryStatus());
    } catch (error: unknown) {
      this.memory.set({ enabled: false, available: false, error: apiError(error, "No se pudo comprobar engram") });
    }
  }

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
      void this.checkMemory();
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo guardar") });
    } finally {
      this.busy.set(false);
    }
  }
}
