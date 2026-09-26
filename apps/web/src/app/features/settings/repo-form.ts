import { Component, computed, inject, input, linkedSignal, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import type { ClaudeInventory, RepoConfig } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { sourceLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

type RepoDraft = Omit<RepoConfig, "checks" | "nodeModules" | "branchPrefix"> & {
  branchPrefix: string;
  checks: string;
  nodeModules: NonNullable<RepoConfig["nodeModules"]>;
};

const NODE_MODULES_OPTIONS: { value: RepoDraft["nodeModules"]; label: string }[] = [
  { value: "link", label: "Enlazar los del repo (rápido)" },
  { value: "install", label: "npm ci en cada worktree" },
  { value: "none", label: "Ninguno" },
];

const NEW_REPO: RepoDraft = { name: "", path: "", baseBranch: "dev", branchPrefix: "feat", checks: "npm run lint", nodeModules: "link" };

function toDraft(repo: RepoConfig | undefined): RepoDraft {
  return repo
    ? { ...repo, branchPrefix: repo.branchPrefix ?? "", checks: repo.checks.join("\n"), nodeModules: repo.nodeModules ?? "link" }
    : { ...NEW_REPO };
}

/** Last folder of a path, as a valid repo name. */
function nameFromPath(path: string): string {
  return (path.split(/[\\/]/).filter(Boolean).at(-1) ?? "").replace(/[^\w.-]+/g, "-");
}

/** Create/edit screen of one repo (`?tab=repos&edit=<name>` or `?tab=repos&create=1`). */
@Component({
  selector: "nx-repo-form",
  imports: [RouterLink],
  templateUrl: "./repo-form.html",
  host: { class: "flex flex-col gap-4" },
})
export class RepoForm {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);
  private readonly router = inject(Router);

  /** Name of the repo being edited; undefined when creating one. */
  public readonly name = input<string | undefined>();

  protected readonly options = NODE_MODULES_OPTIONS;
  private readonly repos = computed(() => this.store.config()?.repos ?? []);
  protected readonly original = computed(() => this.repos().find((repo) => repo.name === this.name()));
  protected readonly isNew = computed(() => !this.name());
  protected readonly notFound = computed(() => !this.isNew() && this.store.config() !== null && !this.original());
  protected readonly draft = linkedSignal(() => toDraft(this.original()));
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(toDraft(this.original())));
  protected readonly busy = signal(false);
  protected readonly picking = signal(false);
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);

  protected readonly notes = signal<string | null>(null);
  protected readonly notesMessage = signal("");

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected patch(changes: Partial<RepoDraft>): void {
    this.draft.update((draft) => ({ ...draft, ...changes }));
  }

  protected setNodeModules(event: Event): void {
    this.patch({ nodeModules: this.value(event) as RepoDraft["nodeModules"] });
  }

  /** Native folder dialog (opened by the Nexura server, which runs on this machine). */
  protected async browse(): Promise<void> {
    this.picking.set(true);
    this.message.set(null);
    try {
      const path = await this.api.pickFolder(this.draft().path);
      if (path) {
        this.patch({ path, ...(this.draft().name ? {} : { name: nameFromPath(path) }) });
      }
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo abrir el selector de carpetas") });
    } finally {
      this.picking.set(false);
    }
  }

  protected readonly claudeConfig = signal<ClaudeInventory | null>(null);
  protected readonly claudeConfigError = signal("");
  protected readonly sourceLabel = sourceLabel;

  protected async loadClaudeConfig(): Promise<void> {
    const name = this.name();
    if (!name || this.claudeConfig()) {
      return;
    }
    try {
      this.claudeConfig.set(await this.api.claudeConfig(name));
    } catch (error: unknown) {
      this.claudeConfigError.set(apiError(error, "No se pudo leer la config de Claude del repo"));
    }
  }

  protected async loadNotes(): Promise<void> {
    const name = this.name();
    if (name && this.notes() === null) {
      this.notes.set(await this.api.getRepoNotes(name).catch(() => ""));
    }
  }

  protected async saveNotes(): Promise<void> {
    const name = this.name();
    if (!name) {
      return;
    }
    try {
      await this.api.saveRepoNotes(name, this.notes() ?? "");
      this.notesMessage.set("Guardadas");
    } catch (error: unknown) {
      this.notesMessage.set(apiError(error, "No se pudieron guardar"));
    }
  }

  protected async save(): Promise<void> {
    const draft = this.draft();
    const repo: RepoConfig = {
      ...draft,
      name: draft.name.trim(),
      path: draft.path.trim(),
      branchPrefix: draft.branchPrefix.trim() || undefined,
      checks: draft.checks
        .split("\n")
        .map((check) => check.trim())
        .filter(Boolean),
    };
    if (!repo.name || !repo.path) {
      this.message.set({ ok: false, text: "Faltan el nombre o la ruta" });
      return;
    }
    const original = this.name();
    if (repo.name !== original && this.repos().some((candidate) => candidate.name === repo.name)) {
      this.message.set({ ok: false, text: `Ya existe un repo llamado ${repo.name}` });
      return;
    }
    const next = original ? this.repos().map((candidate) => (candidate.name === original ? repo : candidate)) : [...this.repos(), repo];
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.api.saveRepos(next);
      await this.store.reloadConfig();
      await this.router.navigate(["/config"], { queryParams: { tab: "repos" } });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo guardar el repo") });
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const name = this.name();
    if (!name || !confirm(`¿Quitar el repo ${name} de Nexura? No se borra nada del disco.`)) {
      return;
    }
    this.busy.set(true);
    try {
      await this.api.saveRepos(this.repos().filter((repo) => repo.name !== name));
      await this.store.reloadConfig();
      await this.router.navigate(["/config"], { queryParams: { tab: "repos" } });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo quitar el repo") });
    } finally {
      this.busy.set(false);
    }
  }
}
