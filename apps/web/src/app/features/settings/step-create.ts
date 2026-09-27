import { Component, computed, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { CUSTOM_STEP_NAME, orderSteps } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

/** Steps that never run inside the pipeline, so nothing can be placed after them. */
const OFF_PIPELINE = new Set(["classify", "addressReview", "prReview"]);

/** Create screen of a custom step (`?tab=steps&create=1`); then its edit screen opens. */
@Component({
  selector: "nx-step-create",
  imports: [RouterLink],
  template: `
    <div class="flex flex-wrap items-center gap-3">
      <a class="rounded-md border border-border px-2.5 py-1 text-muted hover:bg-surface-3 hover:text-fg" routerLink="/config" [queryParams]="{ tab: 'steps' }">
        ← Pasos
      </a>
      <h1 class="text-xl font-semibold tracking-tight">Nuevo paso</h1>
    </div>

    <form class="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4" (submit)="$event.preventDefault(); create()">
      <p class="max-w-3xl text-muted">
        Un paso propio es una llamada a Claude con tu prompt. Recibe las mismas variables que los demás (ticket, repos, libro de tareas…) y su respuesta queda
        en el libro de tareas y en <code class="font-mono">{{ "{{" }}output.&lt;nombre&gt;{{ "}}" }}</code> para los pasos siguientes. Si cambia ficheros, Nexura hace
        commit al terminar. Después de crearlo, actívalo en los perfiles que quieras.
      </p>
      <div class="grid gap-4 md:grid-cols-3">
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-medium text-muted uppercase">Nombre técnico</span>
          <input
            class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono outline-none focus:border-accent"
            placeholder="docs"
            [value]="name()"
            (input)="name.set(value($event))"
          />
          <span class="text-[11px]" [class]="name() && !validName() ? 'text-err' : 'text-muted'">Letra inicial; luego letras, números o guiones.</span>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-medium text-muted uppercase">Nombre visible</span>
          <input
            class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 outline-none focus:border-accent"
            placeholder="Documentación"
            [value]="label()"
            (input)="label.set(value($event))"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-medium text-muted uppercase">Se ejecuta después de</span>
          <select class="rounded-md border border-border bg-surface-2 px-2 py-1.5" (change)="after.set(value($event))">
            @for (option of anchors(); track option.name) {
              <option [value]="option.name" [selected]="option.name === after()">{{ option.label }}</option>
            }
          </select>
        </label>
        <label class="flex flex-col gap-1 md:col-span-3">
          <span class="text-[11px] font-medium text-muted uppercase">Para qué sirve</span>
          <input
            class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 outline-none focus:border-accent"
            placeholder="Actualiza el README y el CHANGELOG con lo que ha cambiado"
            [value]="description()"
            (input)="description.set(value($event))"
          />
        </label>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          class="rounded-md bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40"
          [disabled]="busy() || !validName()"
        >
          Crear y editar su prompt
        </button>
        <a class="rounded-md border border-border px-3 py-1.5 hover:bg-surface-3" routerLink="/config" [queryParams]="{ tab: 'steps' }">Cancelar</a>
        @if (error(); as message) {
          <span class="text-err" role="alert">{{ message }}</span>
        }
      </div>
    </form>
  `,
  host: { class: "flex flex-col gap-4" },
})
export class StepCreate {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);
  private readonly router = inject(Router);

  protected readonly name = signal("");
  protected readonly label = signal("");
  protected readonly description = signal("");
  protected readonly after = signal("implement");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly validName = computed(() => CUSTOM_STEP_NAME.test(this.name().trim()));
  protected readonly anchors = computed(() =>
    orderSteps(this.store.config()?.steps ?? [])
      .filter((step) => !OFF_PIPELINE.has(step.name))
      .map((step) => ({ name: step.name, label: stepLabel(step.name) })),
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected async create(): Promise<void> {
    const name = this.name().trim();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.createStep({ name, label: this.label().trim() || undefined, description: this.description().trim(), after: this.after() });
      await this.store.reloadConfig();
      await this.router.navigate(["/config"], { queryParams: { tab: "steps", step: name } });
    } catch (error: unknown) {
      this.error.set(apiError(error, "No se pudo crear el paso"));
    } finally {
      this.busy.set(false);
    }
  }
}
