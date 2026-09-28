import { Component, computed, inject, input, linkedSignal, output, resource, signal, viewChild, type OnDestroy } from "@angular/core";
import { RouterLink } from "@angular/router";
import { AGENT_LABELS, TICKET_KIND_LABELS, TICKET_SIDE_LABELS, type TicketDraft, type TicketItem } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";
import { Icon } from "../../shared/icon";
import { StatusPill } from "../../shared/status-pill";
import { SOURCE_LABELS } from "../new-run/ticket-picker";
import { TicketChat } from "./ticket-chat";
import { TicketItemFields } from "./ticket-item-fields";
import { draftStatus, draftTitle } from "./ticket-format";

const SAVE_DELAY_MS = 700;

/** What an item still lacks by the team's format, checked here without asking the assistant. */
export function itemGaps(item: TicketItem): string[] {
  const gaps: string[] = [];
  if (!item.title.trim()) {
    gaps.push("Falta el título");
  }
  if (item.kind === "story") {
    if (!item.description.trim()) {
      gaps.push("Falta la descripción");
    }
    if (!/does not include|no incluye/i.test(item.acceptanceCriteria)) {
      gaps.push("Los criterios no dicen qué NO incluye");
    }
  } else {
    if (!/^\s*1[.)]\s/m.test(item.reproSteps)) {
      gaps.push("Faltan los pasos numerados para reproducirlo");
    }
    if (!/expected|esperad/i.test(item.reproSteps)) {
      gaps.push("Falta el comportamiento esperado");
    }
  }
  return gaps;
}

/**
 * A draft: the conversation on one side, the items on the other. Edits are saved as the
 * person types (and travel with any action, so nothing typed is lost); while the assistant
 * thinks, the items are read-only. Creating asks for confirmation; afterwards each item
 * offers to launch the flow that resolves it.
 */
@Component({
  selector: "nx-ticket-draft-view",
  imports: [Icon, RouterLink, StatusPill, TicketChat, TicketItemFields],
  templateUrl: "./ticket-draft-view.html",
  host: { class: "flex min-h-0 flex-col" },
})
export class TicketDraftView implements OnDestroy {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly draft = input.required<TicketDraft>();
  public readonly deleted = output<void>();
  private readonly chat = viewChild(TicketChat);

  protected readonly kindLabels = TICKET_KIND_LABELS;
  protected readonly sideLabels = TICKET_SIDE_LABELS;
  protected readonly sourceLabels = SOURCE_LABELS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly status = computed(() => draftStatus(this.draft()));
  protected readonly title = computed(() => draftTitle(this.draft()));

  // ---- local edits: kept over the server's echo until they are saved
  private editSeq = 0;
  private savedSeq = 0;
  private editedDraft = "";
  private saveTimer?: ReturnType<typeof setTimeout>;
  private dirty(id: string): boolean {
    return this.editedDraft === id && this.editSeq !== this.savedSeq;
  }
  protected readonly items = linkedSignal<TicketDraft, TicketItem[]>({
    source: this.draft,
    computation: (draft, previous) => (previous && previous.source.id === draft.id && this.dirty(draft.id) ? previous.value : draft.items),
  });
  protected readonly tab = linkedSignal<number, number>({ source: () => this.items().length, computation: (length, previous) => Math.min(previous?.value ?? 0, length - 1) });

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly editable = computed(() => ["idle", "error"].includes(this.draft().status) && !this.busy());
  protected readonly created = computed(() => this.draft().status === "created");
  protected readonly createdItems = computed(() => this.items().filter((item) => item.created));

  /** Repos an item may go to: those on the draft's provider. */
  private readonly providers = resource({
    params: () => (this.store.config()?.repos ?? []).map((repo) => repo.name),
    loader: async ({ params }) => Object.fromEntries(await Promise.all(params.map(async (name) => [name, await this.api.repoProvider(name).catch(() => null)] as const))),
  });
  protected readonly repos = computed(() => {
    const all = (this.store.config()?.repos ?? []).map((repo) => repo.name);
    const providers = this.providers.hasValue() ? this.providers.value() : undefined;
    const same = providers ? all.filter((name) => providers[name] === this.draft().source) : all;
    return same.length ? same : [this.draft().repo];
  });

  /** What the assistant still needs plus what the format checks find, per item. */
  protected readonly gaps = computed(() => {
    const labelled = this.items().length > 1;
    const local = this.items().flatMap((item) => itemGaps(item).map((gap) => (labelled ? `${this.sideLabels[item.side]}: ${gap}` : gap)));
    return [...this.draft().missing, ...local];
  });
  protected readonly ready = computed(() => this.draft().ready && this.gaps().length === 0);

  public ngOnDestroy(): void {
    // Leaving the draft saves what was typed.
    void this.save();
  }

  protected edit(index: number, item: TicketItem): void {
    this.items.update((items) => items.map((current, position) => (position === index ? item : current)));
    this.touched();
  }

  protected removeItem(index: number): void {
    const item = this.items()[index];
    if (!item || !confirm(`¿Quitar el item de ${this.sideLabels[item.side]}? El otro se queda como ticket único.`)) {
      return;
    }
    this.items.update((items) => items.filter((_item, position) => position !== index));
    this.touched();
  }

  private touched(): void {
    this.editSeq++;
    this.editedDraft = this.draft().id;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    const id = this.editedDraft;
    if (!id || !this.dirty(id) || this.draft().id !== id || !this.editable()) {
      return;
    }
    const seq = this.editSeq;
    try {
      this.store.upsertTicketDraft(await this.api.updateTicketDraft(id, this.items()));
      this.savedSeq = Math.max(this.savedSeq, seq);
    } catch (error) {
      this.error.set(apiError(error, "No se pudieron guardar los cambios"));
    }
  }

  /** Runs an action that carries the items on screen; on failure they stay unsaved (and are kept). */
  private async act(call: (items: TicketItem[]) => Promise<TicketDraft>, fallback: string): Promise<boolean> {
    clearTimeout(this.saveTimer);
    const sentSeq = this.editSeq;
    this.busy.set(true);
    this.error.set(null);
    try {
      const draft = await call(this.items());
      this.savedSeq = Math.max(this.savedSeq, sentSeq);
      this.store.upsertTicketDraft(draft);
      return true;
    } catch (error) {
      this.error.set(apiError(error, fallback));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected async reply(text: string): Promise<void> {
    if (await this.act((items) => this.api.replyTicketDraft(this.draft().id, text, items), "No se pudo enviar la respuesta")) {
      this.chat()?.clear();
    }
  }

  protected split(): Promise<boolean> {
    return this.act((items) => this.api.splitTicketDraft(this.draft().id, items), "No se pudo dividir");
  }

  protected async stop(): Promise<void> {
    try {
      this.store.upsertTicketDraft(await this.api.cancelTicketDraft(this.draft().id));
    } catch (error) {
      this.error.set(apiError(error, "No se pudo parar"));
    }
  }

  protected async create(): Promise<void> {
    const where = this.sourceLabels[this.draft().source];
    const list = this.items()
      .filter((item) => !item.created)
      .map((item) => `• ${this.kindLabels[item.kind]} de ${this.sideLabels[item.side].toLowerCase()} en ${item.repo}: ${item.title || "(sin título)"}`)
      .join("\n");
    const warning = this.gaps().length ? `\n\nOjo, aún falta:\n${this.gaps().map((gap) => `- ${gap}`).join("\n")}` : "";
    if (!confirm(`Se creará en ${where}:\n\n${list}${warning}\n\n¿Crear ahora?`)) {
      return;
    }
    await this.act((items) => this.api.createTicketDraft(this.draft().id, items), `No se pudo crear en ${where}`);
  }

  protected async remove(): Promise<void> {
    const question = this.created()
      ? "¿Quitar este ticket de la lista? En el tablero sigue existiendo."
      : "¿Borrar este borrador? Se pierde la conversación.";
    if (!confirm(question)) {
      return;
    }
    try {
      await this.api.deleteTicketDraft(this.draft().id);
      this.store.forgetTicketDraft(this.draft().id);
      this.deleted.emit();
    } catch (error) {
      this.error.set(apiError(error, "No se pudo borrar"));
    }
  }
}
