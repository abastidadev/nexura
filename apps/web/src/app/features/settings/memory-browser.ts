import { Component, computed, inject, linkedSignal, signal } from "@angular/core";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";

/** Reads the shared memory (engram) of a repo: its recent context, or a search. Zero tokens. */
@Component({
  selector: "nx-memory-browser",
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <p class="text-[12px] text-muted">
        Lo que los pasos y tus sesiones de Claude Code han guardado en engram para cada repo (engram usa el remote de git como proyecto). Sin
        búsqueda muestra lo más reciente. Para editar o borrar, usa <code class="font-mono">engram tui</code>.
      </p>
      <form class="flex flex-wrap items-center gap-2" (submit)="$event.preventDefault(); search()">
        <select aria-label="Repo" class="rounded-md border border-border bg-surface-2 px-2 py-1.5" (change)="repo.set(value($event))">
          @for (name of repos(); track name) {
            <option [value]="name" [selected]="name === repo()">{{ name }}</option>
          }
        </select>
        <input
          type="search"
          placeholder="Buscar (vacío = lo más reciente)"
          aria-label="Buscar en la memoria"
          class="min-w-64 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 outline-none focus:border-accent"
          [value]="query()"
          (input)="query.set(value($event))"
        />
        <button type="submit" class="rounded-md bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40" [disabled]="busy() || !repo()">
          {{ query().trim() ? "Buscar" : "Ver reciente" }}
        </button>
      </form>
      @if (error(); as text) {
        <p class="text-err" role="alert">{{ text }}</p>
      }
      @if (result() !== null) {
        <pre class="max-h-[60vh] overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12px] whitespace-pre-wrap">{{ result() || "Nada guardado todavía." }}</pre>
      }
    </section>
  `,
})
export class MemoryBrowser {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly repos = computed(() => (this.store.config()?.repos ?? []).map((repo) => repo.name));
  protected readonly repo = linkedSignal(() => this.repos()[0] ?? "");
  protected readonly query = signal("");
  protected readonly result = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected async search(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.result.set(await this.api.searchMemory(this.repo(), this.query()));
    } catch (error: unknown) {
      this.result.set(null);
      this.error.set(apiError(error, "No se pudo leer la memoria"));
    } finally {
      this.busy.set(false);
    }
  }
}
