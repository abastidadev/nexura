import { Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";

const NODE_MODULES_LABELS: Record<string, string> = { link: "enlazados", install: "npm ci", none: "ninguno" };

@Component({
  selector: "nx-repos-list",
  imports: [RouterLink],
  template: `
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-3xl text-muted">
        Los repos que puede tocar un flujo. Cada ejecución crea un worktree en <code class="font-mono">&lt;ruta&gt;.worktrees/nexura-&lt;id&gt;</code> con una
        rama <code class="font-mono">&lt;prefijo&gt;/&lt;ticket&gt;-&lt;título&gt;</code> desde la rama base.
      </p>
      <a
        class="nx-btn nx-btn-primary shrink-0"
        routerLink="/config"
        [queryParams]="{ tab: 'repos', create: 1 }"
      >
        + Añadir repo
      </a>
    </div>

    @if (repos().length === 0) {
      <p class="rounded-lg border border-dashed border-border px-4 py-10 text-center text-muted">Todavía no hay repos. Añade el primero.</p>
    } @else {
      <div class="overflow-hidden rounded-lg border border-border bg-surface">
        <table class="w-full border-collapse text-left">
          <thead class="border-b border-border text-xs text-muted">
            <tr>
              <th class="px-4 py-2 font-medium">Nombre</th>
              <th class="px-4 py-2 font-medium">Ruta</th>
              <th class="px-4 py-2 font-medium">Rama base</th>
              <th class="px-4 py-2 font-medium">Checks</th>
              <th class="px-4 py-2 font-medium">node_modules</th>
              <th class="px-4 py-2"><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            @for (repo of repos(); track repo.name) {
              <tr class="border-b border-border last:border-b-0 hover:bg-surface-2">
                <td class="px-4 py-2.5">
                  <a class="font-medium hover:text-accent hover:underline" routerLink="/config" [queryParams]="{ tab: 'repos', edit: repo.name }">{{ repo.name }}</a>
                </td>
                <td class="max-w-[360px] truncate px-4 py-2.5 font-mono text-sm text-fg-soft" [attr.title]="repo.path">{{ repo.path }}</td>
                <td class="px-4 py-2.5 font-mono text-sm">{{ (repo.branchPrefix || "feat") + "/… ← " + repo.baseBranch }}</td>
                <td class="px-4 py-2.5 text-sm text-fg-soft" [attr.title]="repo.checks.join('\\n')">
                  {{ repo.checks.length ? repo.checks.length + " check(s)" : "—" }}
                </td>
                <td class="px-4 py-2.5 text-sm text-fg-soft">{{ nodeModules[repo.nodeModules ?? "link"] }}</td>
                <td class="px-4 py-2.5 text-right whitespace-nowrap">
                  <a
                    class="nx-btn nx-btn-sm"
                    routerLink="/config"
                    [queryParams]="{ tab: 'repos', edit: repo.name }"
                    >Editar</a
                  >
                  <button
                    type="button"
                    class="nx-btn nx-btn-sm nx-btn-ghost text-err! hover:bg-err-soft! ml-1"
                    [disabled]="busy()"
                    (click)="remove(repo.name)"
                  >
                    Borrar
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
    @if (message(); as msg) {
      <p class="mt-3" [class]="msg.ok ? 'text-ok' : 'text-err'" role="status">{{ msg.text }}</p>
    }
  `,
  host: { class: "block" },
})
export class ReposList {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly nodeModules = NODE_MODULES_LABELS;
  protected readonly repos = computed(() => this.store.config()?.repos ?? []);
  protected readonly busy = signal(false);
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);

  protected async remove(name: string): Promise<void> {
    if (!confirm(`¿Quitar el repo ${name} de Nexura? No se borra nada del disco.`)) {
      return;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.api.saveRepos(this.repos().filter((repo) => repo.name !== name));
      await this.store.reloadConfig();
      this.message.set({ ok: true, text: `Repo ${name} quitado` });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo quitar el repo") });
    } finally {
      this.busy.set(false);
    }
  }
}
