import { Component, computed, effect, inject, linkedSignal, signal, untracked } from "@angular/core";
import type { MemoryObservation } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

/** Browses the shared memory of a repo (latest, or a full-text search) and deletes entries. Zero tokens. */
@Component({
  selector: "nx-memory-browser",
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <p class="text-sm text-muted">
        Lo que han guardado los pasos, Nexura (convenciones y resumen de cada ticket) y tus sesiones de Claude Code para cada repo. El proyecto
        es el nombre del repo en su remote <code class="font-mono">origin</code>, así que todos sus worktrees y clones comparten memoria.
      </p>

      <form class="flex flex-wrap items-center gap-2" (submit)="$event.preventDefault(); search()">
        <select aria-label="Repo" class="nx-input" (change)="repo.set(value($event))">
          @for (name of repos(); track name) {
            <option [value]="name" [selected]="name === repo()">{{ name }}</option>
          }
        </select>
        <input
          type="search"
          placeholder="Buscar (vacío = lo más reciente)"
          aria-label="Buscar en la memoria"
          class="nx-input min-w-64 flex-1"
          [value]="query()"
          (input)="query.set(value($event))"
        />
        <button type="submit" class="nx-btn nx-btn-primary" [disabled]="busy() || !repo()">
          {{ query().trim() ? "Buscar" : "Ver lo último" }}
        </button>
      </form>

      @if (error(); as text) {
        <p class="text-err" role="alert">{{ text }}</p>
      }
      @if (result(); as current) {
        <p class="text-sm text-muted">
          Proyecto <span class="font-mono text-fg-soft">{{ current.project }}</span> · {{ current.observations.length }} resultado(s)
        </p>
        @if (current.observations.length === 0) {
          <p class="py-6 text-center text-muted">{{ query().trim() ? "Nada coincide con la búsqueda." : "Nada guardado todavía." }}</p>
        }
        <ul class="flex flex-col gap-2">
          @for (item of current.observations; track item.id) {
            <li class="rounded-md border border-border bg-surface-2">
              <details>
                <summary class="flex cursor-pointer items-center gap-2 px-3 py-2">
                  <span class="rounded border border-border px-1.5 font-mono text-xs text-muted">{{ item.type }}</span>
                  <span class="min-w-0 flex-1 truncate font-medium">{{ item.title }}</span>
                  <span class="shrink-0 text-xs text-muted" [title]="'Actualizada ' + item.updatedAt">
                    {{ sourceLabel(item.source) }} · {{ item.updatedAt.slice(0, 10) }}
                    @if (item.revisions > 1) {
                      · rev. {{ item.revisions }}
                    }
                  </span>
                </summary>
                <div class="flex flex-col gap-2 border-t border-border px-3 py-2">
                  @if (item.topicKey) {
                    <p class="text-xs text-muted">Tema <span class="font-mono">{{ item.topicKey }}</span> (guardar con el mismo tema lo actualiza)</p>
                  }
                  @if (item.files?.length) {
                    <p class="text-xs text-muted">
                      Ficheros
                      @for (file of item.files; track file) {
                        <span class="ml-1 font-mono text-fg-soft">{{ file }}</span>
                      }
                    </p>
                  }
                  <pre class="font-mono text-sm whitespace-pre-wrap">{{ item.content }}</pre>
                  <div>
                    <button type="button" class="nx-btn nx-btn-sm text-err" (click)="remove(item)">Borrar</button>
                  </div>
                </div>
              </details>
            </li>
          }
        </ul>
      }
    </section>

    <section class="mt-4 flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
      <h2 class="font-semibold">Usarla desde tu Claude Code</h2>
      <p class="text-sm text-muted">
        Para que tus sesiones interactivas lean y guarden en la misma memoria, añade el servidor MCP de Nexura una vez (ámbito de usuario). Cada
        sesión usa el proyecto del repo en el que la abres.
      </p>
      @if (mcpCommand(); as command) {
        <div class="flex items-start gap-2">
          <code class="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-2 font-mono text-sm break-all">{{ command }}</code>
          <button type="button" class="nx-btn shrink-0" (click)="copy(command)">
            {{ copied() ? "Copiado" : "Copiar" }}
          </button>
        </div>
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
  protected readonly result = signal<{ project: string; observations: MemoryObservation[] } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly mcpCommand = signal("");
  protected readonly copied = signal(false);

  public constructor() {
    void this.api.memoryMcpCommand().then((command) => this.mcpCommand.set(command));
    // Show the latest of the selected repo straight away (only the repo change triggers it, not typing).
    effect(() => {
      if (this.repo()) {
        untracked(() => void this.search());
      }
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected sourceLabel(source: string | undefined): string {
    if (!source || source === "nexura") {
      return "Nexura";
    }
    return source === "claude-code" ? "Claude Code" : stepLabel(source);
  }

  protected async search(): Promise<void> {
    const repo = this.repo();
    this.busy.set(true);
    this.error.set(null);
    try {
      this.result.set(await this.api.searchMemory(repo, this.query()));
    } catch (error: unknown) {
      this.result.set(null);
      this.error.set(apiError(error, "No se pudo leer la memoria"));
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(item: MemoryObservation): Promise<void> {
    if (!confirm(`¿Borrar "${item.title}" de la memoria?`)) {
      return;
    }
    try {
      await this.api.deleteMemory(item.id);
      this.result.update((current) => current && { ...current, observations: current.observations.filter((o) => o.id !== item.id) });
    } catch (error: unknown) {
      this.error.set(apiError(error, "No se pudo borrar"));
    }
  }

  protected async copy(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
