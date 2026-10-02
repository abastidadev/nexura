import { Component, computed, effect, inject, input, linkedSignal, output, signal } from "@angular/core";
import type { Conversation, DiffComment } from "@nexura/shared";
import { Api } from "../../core/api";
import { commentsMessage } from "../../core/diff-comments";
import { readStorage, removeStorage, writeStorage } from "../../core/storage";
import { DiffPanel, type DiffLoader } from "../../shared/diff-panel";
import type { NewDiffComment, ShownComment } from "../../shared/diff-view";

/** While the CLI works the files change under the panel: read them again this often. */
const POLL_MS = 5000;

const draftsKey = (id: string): string => `nexura.terminalComments.${id}`;

/**
 * What is not committed in the conversation's repo, refreshed while the CLI runs. In an agent
 * conversation the user comments lines and pastes them into the CLI (without sending them:
 * they read the text and press Enter).
 */
@Component({
  selector: "nx-conversation-changes",
  imports: [DiffPanel],
  template: `
    <nx-diff-panel
      class="min-h-0 flex-1"
      [load]="load()"
      [version]="conversation().status"
      [pollMs]="conversation().status === 'running' ? pollMs : 0"
      [emptyText]="'No hay nada que comparar.'"
      [noChangesText]="'No hay cambios sin commit en este repo.'"
      [commentable]="agent() ? 'any' : 'none'"
      [comments]="shownComments()"
      [placeholder]="'Qué tiene que cambiar el agente aquí…'"
      [(ignoreWhitespace)]="ignoreWhitespace"
      (closed)="closed.emit()"
      (comment)="add($event)"
      (remove)="remove($event)"
    >
      @if (agent() && drafts().length) {
        <footer class="border-t border-border bg-surface px-4 py-2.5">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm font-medium">{{ drafts().length }} comentario(s)</span>
            <input
              class="nx-input min-w-48 flex-1"
              aria-label="Indicación general (opcional)"
              placeholder="Indicación general (opcional)"
              [value]="note()"
              (input)="note.set($any($event.target).value)"
            />
            <button type="button" class="nx-btn nx-btn-sm" (click)="discard()">Descartar</button>
            <button
              type="button"
              class="nx-btn nx-btn-primary nx-btn-sm"
              [disabled]="conversation().status !== 'running'"
              [attr.title]="conversation().status === 'running' ? null : 'Reanuda la conversación para pegarlos'"
              (click)="pasteAll()"
            >
              Pegar en la terminal
            </button>
          </div>
          <p class="mt-1 text-xs text-muted">Se escriben en la terminal sin enviarlos: revisa el texto y pulsa Enter.</p>
        </footer>
      }
    </nx-diff-panel>
  `,
  host: { class: "flex min-h-0 flex-col bg-bg" },
})
export class ConversationChanges {
  private readonly api = inject(Api);

  public readonly conversation = input.required<Conversation>();
  public readonly closed = output<void>();
  /** Text to type into the conversation's CLI. */
  public readonly paste = output<string>();

  protected readonly pollMs = POLL_MS;
  protected readonly ignoreWhitespace = signal(false);
  private readonly id = computed(() => this.conversation().id);
  protected readonly agent = computed(() => this.conversation().kind === "agent");
  /** Stable per conversation: its updates must not read the diff again (the polling does). */
  protected readonly load = computed<DiffLoader>(() => {
    const id = this.id();
    return (ignoreWhitespace) => this.api.getConversationDiff(id, ignoreWhitespace);
  });

  protected readonly drafts = linkedSignal<string, DiffComment[]>({
    source: this.id,
    computation: (id) => readStorage<DiffComment[]>(draftsKey(id), []),
  });
  protected readonly note = signal("");
  protected readonly shownComments = computed<ShownComment[]>(() => this.drafts().map((comment) => ({ ...comment, removable: true })));

  public constructor() {
    effect(() => {
      const id = this.id();
      const drafts = this.drafts();
      if (drafts.length) {
        writeStorage(draftsKey(id), drafts);
      } else {
        removeStorage(draftsKey(id));
      }
    });
  }

  protected add(comment: NewDiffComment): void {
    const { severity: _severity, ...draft } = comment;
    this.drafts.update((drafts) => [...drafts, draft]);
  }

  protected remove(comment: ShownComment): void {
    this.drafts.update((drafts) =>
      drafts.filter(
        (draft) =>
          !(draft.repo === comment.repo && draft.file === comment.file && draft.side === comment.side
            && draft.startLine === comment.startLine && draft.endLine === comment.endLine && draft.body === comment.body),
      ),
    );
  }

  protected discard(): void {
    this.drafts.set([]);
    this.note.set("");
  }

  protected pasteAll(): void {
    this.paste.emit(commentsMessage(this.drafts(), this.note()));
    this.discard();
  }
}
