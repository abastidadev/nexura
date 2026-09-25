import { Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { orderSteps } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

/** Profiles shipped with Nexura; the rest were created by the user. */
const BASE_PROFILES = new Set(["minimal", "standard", "full"]);

@Component({
  selector: "nx-profiles-list",
  imports: [RouterLink],
  template: `
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-3xl text-muted">
        Un perfil decide qué pasos corre un flujo, con qué modelo y esfuerzo, cuántas vueltas review→implement admite y su tope de gasto. Crea los tuyos
        (p. ej. "solo-estilos" o "bug-rapido"): aparecen al lanzar un flujo y el modo Automático también puede elegirlos por su descripción.
      </p>
      <a
        class="shrink-0 rounded-md bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90"
        routerLink="/config"
        [queryParams]="{ tab: 'profiles', create: 1 }"
      >
        + Nuevo perfil
      </a>
    </div>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      @for (card of cards(); track card.name) {
        <article class="flex flex-col rounded-lg border border-border bg-surface p-4">
          <div class="flex items-center gap-2">
            <a class="font-mono font-semibold hover:text-accent hover:underline" routerLink="/config" [queryParams]="{ tab: 'profiles', edit: card.name }">{{
              card.name
            }}</a>
            <span class="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted uppercase">{{ card.base ? "base" : "propio" }}</span>
          </div>
          <p class="mt-1 text-[12px] text-fg-soft">{{ card.description || "Sin descripción" }}</p>
          <div class="mt-2 flex flex-wrap gap-1">
            @for (step of card.steps; track step) {
              <span class="rounded bg-surface-3 px-1.5 py-0.5 text-[11px]">{{ step }}</span>
            }
          </div>
          <p class="mt-2 text-[11px] text-muted">{{ card.maxLoops }} vuelta(s) · presupuesto {{ card.budget }}{{ card.blind ? " · revisión doble ciega" : "" }}</p>
          <div class="mt-3 flex gap-1 border-t border-border pt-3">
            <a
              class="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-3"
              routerLink="/config"
              [queryParams]="{ tab: 'profiles', edit: card.name }"
              >Editar</a
            >
            <a
              class="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-3"
              routerLink="/config"
              [queryParams]="{ tab: 'profiles', create: 1, from: card.name }"
              >Duplicar</a
            >
            <button
              type="button"
              class="ml-auto rounded-md px-2.5 py-1 text-[12px] text-err hover:bg-err-soft disabled:opacity-40"
              [disabled]="busy()"
              (click)="remove(card.name)"
            >
              Borrar
            </button>
          </div>
        </article>
      }
    </div>
    @if (message(); as msg) {
      <p class="mt-3" [class]="msg.ok ? 'text-ok' : 'text-err'" role="status">{{ msg.text }}</p>
    }
  `,
  host: { class: "block" },
})
export class ProfilesList {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly busy = signal(false);
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);
  private readonly order = computed(() => orderSteps(this.store.config()?.steps ?? []).map((step) => step.name));
  protected readonly cards = computed(() =>
    (this.store.config()?.profiles ?? []).map((profile) => ({
      name: profile.name,
      description: profile.description,
      base: BASE_PROFILES.has(profile.name),
      maxLoops: profile.maxLoops,
      blind: profile.reviewMode === "blind",
      budget: profile.budgetUsd === undefined ? "sin límite" : `$${profile.budgetUsd.toFixed(2)}`,
      steps: this.order()
        .filter((name) => profile.steps[name]?.enabled)
        .map((name) => stepLabel(name)),
    })),
  );

  protected async remove(name: string): Promise<void> {
    if (!confirm(`¿Borrar el perfil ${name}?`)) {
      return;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.api.deleteProfile(name);
      await this.store.reloadConfig();
      this.message.set({ ok: true, text: `Perfil ${name} borrado` });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo borrar el perfil") });
    } finally {
      this.busy.set(false);
    }
  }
}
