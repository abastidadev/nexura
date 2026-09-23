import { Component, computed, inject, linkedSignal, signal } from "@angular/core";
import type { RepoConfig } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";

type RepoDraft = Omit<RepoConfig, "checks" | "nodeModules"> & { checks: string; nodeModules: NonNullable<RepoConfig["nodeModules"]> };

const NODE_MODULES_OPTIONS: { value: RepoDraft["nodeModules"]; label: string }[] = [
  { value: "link", label: "Enlazar los del repo (rápido)" },
  { value: "install", label: "npm ci en cada worktree" },
  { value: "none", label: "Ninguno" },
];

function toDraft(repo: RepoConfig): RepoDraft {
  return { ...repo, branchPrefix: repo.branchPrefix ?? "", checks: repo.checks.join("\n"), nodeModules: repo.nodeModules ?? "link" };
}

@Component({
  selector: "nx-repos-editor",
  templateUrl: "./repos-editor.html",
  host: { class: "block" },
})
export class ReposEditor {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly options = NODE_MODULES_OPTIONS;
  private readonly saved = computed(() => (this.store.config()?.repos ?? []).map(toDraft));
  protected readonly drafts = linkedSignal(() => structuredClone(this.saved()));
  protected readonly dirty = computed(() => JSON.stringify(this.drafts()) !== JSON.stringify(this.saved()));
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly busy = signal(false);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected patch(index: number, changes: Partial<RepoDraft>): void {
    this.drafts.update((drafts) => drafts.map((draft, i) => (i === index ? { ...draft, ...changes } : draft)));
  }

  protected setNodeModules(index: number, event: Event): void {
    this.patch(index, { nodeModules: this.value(event) as RepoDraft["nodeModules"] });
  }

  protected add(): void {
    this.drafts.update((drafts) => [
      ...drafts,
      { name: "", path: "", baseBranch: "dev", branchPrefix: "feat", checks: "npm run lint", nodeModules: "link" },
    ]);
  }

  protected remove(index: number): void {
    this.drafts.update((drafts) => drafts.filter((_, i) => i !== index));
  }

  protected discard(): void {
    this.drafts.set(structuredClone(this.saved()));
    this.message.set(null);
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.api.saveRepos(
        this.drafts().map((draft) => ({
          ...draft,
          branchPrefix: draft.branchPrefix || undefined,
          checks: draft.checks.split("\n").map((check) => check.trim()).filter(Boolean),
        })),
      );
      await this.store.reloadConfig();
      this.message.set({ ok: true, text: "Repos guardados en config/repos.json" });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudieron guardar los repos") });
    } finally {
      this.busy.set(false);
    }
  }
}
