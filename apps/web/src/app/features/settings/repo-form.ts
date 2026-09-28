import { Component, computed, DestroyRef, inject, input, linkedSignal, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import type { CheckKind, CheckSuggestion, CheckTrial, CheckTrialResult, ClaudeInventory, RepoConfig } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { formatDuration, sourceLabel } from "../../core/format";
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

const NEW_REPO: RepoDraft = { name: "", path: "", baseBranch: "", branchPrefix: "feat", checks: "", nodeModules: "link" };

const KIND_LABELS: Record<CheckKind, string> = {
  format: "formato",
  lint: "lint",
  typecheck: "tipos",
  build: "build",
  test: "tests",
  other: "otro",
};

const TRIAL_STATUS: Record<CheckTrialResult["status"], { label: string; tone: string }> = {
  pending: { label: "en cola", tone: "text-muted" },
  running: { label: "ejecutando…", tone: "text-info" },
  passed: { label: "pasa", tone: "text-ok" },
  failed: { label: "falla en la rama base", tone: "text-err" },
  timedOut: { label: "tiempo agotado", tone: "text-warn" },
  skipped: { label: "no se ejecutó", tone: "text-muted" },
};

const TRIAL_POLL_MS = 1500;

function checkLines(checks: string): string[] {
  return checks
    .split("\n")
    .map((check) => check.trim())
    .filter(Boolean);
}

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
  private destroyed = false;

  public constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
  }

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

  protected readonly kindLabels = KIND_LABELS;
  protected readonly trialStatus = TRIAL_STATUS;
  protected readonly formatDuration = formatDuration;
  protected readonly suggestions = signal<CheckSuggestion[] | null>(null);
  /** Base branch read from git; the form fills it in until the user types another one. */
  protected readonly detectedBase = signal<string | undefined>(undefined);
  protected readonly detecting = signal(false);
  protected readonly detectError = signal("");
  protected readonly lines = computed(() => checkLines(this.draft().checks));
  protected readonly trial = signal<CheckTrial | null>(null);
  protected readonly trialError = signal("");
  protected readonly trialRunning = computed(() => this.trial()?.status === "running");
  /** Checks of the last trial that failed or hung on the base branch and are still configured. */
  protected readonly failingChecks = computed(() =>
    (this.trial()?.results ?? []).filter((result) => (result.status === "failed" || result.status === "timedOut") && this.lines().includes(result.command)),
  );

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
        await this.pathChanged();
      }
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo abrir el selector de carpetas") });
    } finally {
      this.picking.set(false);
    }
  }

  /** A new repo gets its checks read from its files as soon as it has a folder. */
  protected async pathChanged(): Promise<void> {
    if (this.isNew() && this.draft().path.trim()) {
      await this.detectChecks();
    }
  }

  /**
   * Reads the repo's base branch and checks. A new repo takes the branch (unless the user typed
   * another) and, with no checks yet, the recommended ones.
   */
  protected async detectChecks(): Promise<void> {
    const path = this.draft().path.trim();
    if (!path) {
      this.detectError.set("Indica antes la carpeta del repo");
      return;
    }
    this.detecting.set(true);
    this.detectError.set("");
    try {
      const { baseBranch, checks } = await this.api.detectRepo(path);
      const previous = this.detectedBase();
      this.detectedBase.set(baseBranch);
      this.suggestions.set(checks);
      const typed = this.draft().baseBranch.trim();
      if (this.isNew() && baseBranch && (!typed || typed === previous)) {
        this.patch({ baseBranch });
      }
      if (this.isNew() && !this.lines().length) {
        this.patch({ checks: checks.filter((check) => check.recommended).map((check) => check.command).join("\n") });
      }
    } catch (error: unknown) {
      this.suggestions.set(null);
      this.detectError.set(apiError(error, "No se pudo leer el repo"));
    } finally {
      this.detecting.set(false);
    }
  }

  protected toggleCheck(command: string): void {
    const lines = this.lines();
    this.patch({ checks: (lines.includes(command) ? lines.filter((line) => line !== command) : [...lines, command]).join("\n") });
  }

  protected removeFailing(): void {
    const failing = new Set(this.failingChecks().map((result) => result.command));
    this.patch({ checks: this.lines().filter((line) => !failing.has(line)).join("\n") });
  }

  /** Runs the configured checks on a clean worktree of the base branch and follows the result. */
  protected async testChecks(): Promise<void> {
    const { path, baseBranch, nodeModules } = this.draft();
    this.trialError.set("");
    try {
      let trial = await this.api.startCheckTrial({ path: path.trim(), baseBranch: baseBranch.trim(), nodeModules }, this.lines());
      this.trial.set(trial);
      while (trial.status === "running" && !this.destroyed) {
        await new Promise((done) => setTimeout(done, TRIAL_POLL_MS));
        trial = await this.api.checkTrial(trial.id);
        this.trial.set(trial);
      }
    } catch (error: unknown) {
      this.trialError.set(apiError(error, "No se pudieron probar los checks"));
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
      checks: checkLines(draft.checks),
    };
    if (!repo.name || !repo.path) {
      this.message.set({ ok: false, text: "Faltan el nombre o la ruta" });
      return;
    }
    repo.baseBranch = repo.baseBranch.trim();
    if (!repo.baseBranch) {
      this.message.set({ ok: false, text: "Falta la rama base" });
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
