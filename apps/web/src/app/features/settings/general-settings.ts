import { Component, computed, inject, linkedSignal, resource, signal } from "@angular/core";
import { AGENT_LABELS, DEFAULT_SETTINGS, type NexuraSettings } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";

@Component({
  selector: "nx-general-settings",
  template: `
    <section class="flex max-w-3xl flex-col gap-5 rounded-lg border border-border bg-surface p-4">
      <div>
        <div class="flex items-center gap-2">
          <h2 class="font-semibold">Agentes</h2>
          <button type="button" class="ml-auto rounded-md border border-border px-2 py-0.5 text-[12px] hover:bg-surface-3" (click)="refreshAgents()">
            {{ agents.isLoading() ? "Comprobando…" : "Volver a comprobar" }}
          </button>
        </div>
        <p class="mt-1 text-[12px] text-muted">
          Cada paso de un perfil puede ir con Claude Code, Codex o GitHub Copilot, y se pueden mezclar en un mismo flujo (también los dos
          jueces de la revisión doble ciega). Se comprueba con <code class="font-mono">--version</code>, sin gastar tokens. Codex usa tu
          plan de ChatGPT (<code class="font-mono">codex login</code>) y Copilot el tuyo de GitHub (<code class="font-mono">copilot login</code>).
        </p>
        <ul class="mt-2 flex flex-col gap-1 text-[12px]">
          @for (info of agentList(); track info.agent) {
            <li class="flex flex-wrap items-baseline gap-2">
              <span class="w-24 font-medium">{{ agentLabels[info.agent] }}</span>
              @if (info.available) {
                <span class="text-ok">✓ {{ info.version }}</span>
              } @else {
                <span class="text-warn" [title]="info.error ?? ''">✗ {{ info.error ?? "no instalado" }}</span>
              }
            </li>
          }
        </ul>
        <p class="mt-2 text-[11px] text-muted">
          Instalar: <code class="font-mono">npm install -g &#64;openai/codex</code> · <code class="font-mono">winget install GitHub.Copilot</code> (o <code class="font-mono">npm install -g &#64;github/copilot</code>).
          Otro binario: <code class="font-mono">NEXURA_CLAUDE_BIN</code>, <code class="font-mono">NEXURA_CODEX_BIN</code>,
          <code class="font-mono">NEXURA_COPILOT_BIN</code>. Solo los pasos con Claude miden la cuota, respetan el presupuesto y admiten mensajes a
          mitad de paso.
        </p>
      </div>

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
        <h2 class="font-semibold">Memoria compartida</h2>
        <p class="mt-1 text-[12px] text-muted">
          Los pasos con memoria (se elige en cada paso) reciben lo que se sabe del ticket y del repo, y pueden buscar y guardar decisiones,
          causas raíz y convenciones. Al acabar cada ticket, Nexura guarda un resumen sin gastar tokens. Se guarda en
          <code class="font-mono">data/memory.sqlite</code>; en Configuración → Memoria puedes consultarla y dársela también a tu Claude Code
          interactivo. Apagada, los pasos siguen usando las notas aprendidas del repo.
        </p>
        <label class="mt-3 flex cursor-pointer items-center gap-2">
          <input type="checkbox" class="size-4 accent-accent" [checked]="draft().memoryEnabled" (change)="patch({ memoryEnabled: !draft().memoryEnabled })" />
          Usar la memoria compartida
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

  protected readonly agentLabels = AGENT_LABELS;
  private readonly refresh = signal(0);
  protected readonly agents = resource({ params: () => this.refresh(), loader: ({ params }) => this.api.getAgents(params > 0) });
  protected readonly agentList = computed(() => (this.agents.hasValue() ? this.agents.value() : []));

  protected readonly draft = linkedSignal<NexuraSettings>(() => ({ ...(this.store.settings() ?? DEFAULT_SETTINGS) }));

  protected refreshAgents(): void {
    this.refresh.update((count) => count + 1);
  }
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
