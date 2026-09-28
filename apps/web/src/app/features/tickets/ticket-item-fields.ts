import { Component, computed, input, output, resource, signal, inject } from "@angular/core";
import { TICKET_KIND_LABELS, TICKET_KINDS, TICKET_SIDE_LABELS, TICKET_SIDES, type TicketItem, type TicketSource } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { Icon } from "../../shared/icon";

/**
 * One item of a draft: its texts in the fields the board keeps them in (a story's
 * description and criteria, a bug's repro steps), its tags, and where it goes: repo,
 * sprint, who does it and (Azure) team and area. The choices come from the item's repo board.
 */
@Component({
  selector: "nx-ticket-item-fields",
  imports: [Icon],
  templateUrl: "./ticket-item-fields.html",
})
export class TicketItemFields {
  private readonly api = inject(Api);

  public readonly item = input.required<TicketItem>();
  public readonly source = input.required<TicketSource>();
  public readonly disabled = input(false);
  /** Repos the item may go to (same provider as the draft). */
  public readonly repos = input.required<string[]>();
  public readonly itemChange = output<TicketItem>();

  protected readonly kinds = TICKET_KINDS;
  protected readonly kindLabels = TICKET_KIND_LABELS;
  protected readonly sides = TICKET_SIDES;
  protected readonly sideLabels = TICKET_SIDE_LABELS;

  protected readonly options = resource({
    params: () => ({ repo: this.item().repo, team: this.item().team }),
    loader: ({ params }) => this.api.ticketOptions(params.repo, params.team),
  });
  protected readonly optionsError = computed(() => apiError(this.options.error(), "No se pudo consultar el tablero"));
  private readonly board = computed(() => (this.options.hasValue() ? this.options.value() : undefined));

  /** Sprints to offer; the item's own one stays in the list even when it is no longer open. */
  protected readonly iterations = computed(() => {
    const list = this.board()?.iterations ?? [];
    const own = this.item().iteration;
    return own && !list.some((iteration) => iteration.value === own) ? [{ value: own, name: own, current: false }, ...list] : list;
  });
  protected readonly people = computed(() => {
    const board = this.board();
    const list = board?.people ?? [];
    const own = this.item().assignee;
    const withOwn = own && !list.some((person) => person.value === own) ? [{ value: own, name: own }, ...list] : list;
    // The signed-in user first, as «Yo».
    return board?.me ? [...withOwn.filter((person) => person.value === board.me), ...withOwn.filter((person) => person.value !== board.me)] : withOwn;
  });
  protected readonly me = computed(() => this.board()?.me);
  protected readonly teams = computed(() => this.board()?.teams ?? []);
  protected readonly defaultTeam = computed(() => this.board()?.team);
  protected readonly defaultArea = computed(() => this.board()?.areaPath ?? "");
  /** GitHub: labels of the repo not on the item yet, one click away. */
  protected readonly labelSuggestions = computed(() => {
    const tags = new Set(this.item().tags.map((tag) => tag.toLowerCase()));
    return (this.board()?.labels ?? []).filter((label) => !tags.has(label.toLowerCase()));
  });

  protected readonly newTag = signal("");

  protected patch(change: Partial<TicketItem>): void {
    this.itemChange.emit({ ...this.item(), ...change });
  }

  protected addTag(value: string): void {
    const tag = value.trim();
    if (tag && !this.item().tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      this.patch({ tags: [...this.item().tags, tag] });
    }
    this.newTag.set("");
  }

  protected removeTag(tag: string): void {
    this.patch({ tags: this.item().tags.filter((existing) => existing !== tag) });
  }

  protected onTagKey(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      this.addTag(this.newTag());
    }
  }
}
