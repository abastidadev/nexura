import { Component, computed, effect, inject, input } from "@angular/core";
import { Router } from "@angular/router";
import { TICKET_KIND_LABELS } from "@nexura/shared";
import { NexuraStore } from "../../core/nexura-store";
import { Icon } from "../../shared/icon";
import { StatusPill } from "../../shared/status-pill";
import { TicketDraftView } from "./ticket-draft-view";
import { draftStatus, draftTitle } from "./ticket-format";
import { TicketStart } from "./ticket-start";

/**
 * Tickets: write a work item (Azure DevOps) or an issue (GitHub) with an assistant that
 * looks at the code and asks plain questions, in the team's format, and create it on the board.
 */
@Component({
  selector: "nx-tickets-page",
  imports: [Icon, StatusPill, TicketStart, TicketDraftView],
  templateUrl: "./tickets-page.html",
  host: { class: "flex h-full min-h-0 flex-col lg:flex-row" },
})
export class TicketsPage {
  private readonly router = inject(Router);
  protected readonly store = inject(NexuraStore);

  /** Query param (withComponentInputBinding): the open draft. */
  public readonly draft = input<string>();

  protected readonly kindLabels = TICKET_KIND_LABELS;
  protected readonly status = draftStatus;
  protected readonly title = draftTitle;

  protected readonly selected = computed(() => {
    const id = this.draft();
    return id ? this.store.ticketDrafts().find((draft) => draft.id === id) : undefined;
  });
  protected readonly pending = computed(() => this.store.ticketDrafts().filter((draft) => draft.status !== "created"));
  protected readonly created = computed(() => this.store.ticketDrafts().filter((draft) => draft.status === "created"));

  public constructor() {
    // An open ticket gets its header tab, like flows, reviews and terminals.
    effect(() => {
      const draft = this.selected();
      if (draft) {
        this.store.openTab(draft.id);
      }
    });
  }

  protected open(id: string | null): void {
    void this.router.navigate([], { queryParams: { draft: id } });
  }
}
