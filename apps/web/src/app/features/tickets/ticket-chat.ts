import { afterRenderEffect, Component, computed, ElementRef, input, linkedSignal, output, signal, viewChild } from "@angular/core";
import { AGENT_LABELS, type AgentKind, type TicketChatMessage, type TicketQuestion } from "@nexura/shared";
import { Icon } from "../../shared/icon";

/** What the chat shows: a ticket draft or a Setup IA session. `created`/`applied` close it. */
export type ChatThread = {
  messages: TicketChatMessage[];
  status: string;
  activity?: string;
  error?: string;
  agent: { agent: AgentKind };
};

/**
 * The conversation with the assistant. Its questions come with suggested answers: a click
 * picks one (another click unpicks it) and they go, with whatever the person types, as one answer.
 */
@Component({
  selector: "nx-ticket-chat",
  imports: [Icon],
  host: { class: "flex min-h-0 flex-col" },
  template: `
    <div #scroller class="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
      <ol class="flex flex-col gap-3">
        @for (message of draft().messages; track $index; let last = $last) {
          @if (message.role === "user") {
            <li class="ml-10 self-end rounded-lg bg-accent-soft px-3 py-2 whitespace-pre-wrap">
              <span class="sr-only">Tú: </span>{{ message.text }}
            </li>
          } @else {
            <li class="mr-10 flex flex-col gap-3 rounded-lg bg-surface-2 px-3 py-2">
              <p class="whitespace-pre-wrap"><span class="sr-only">Asistente: </span>{{ message.text }}</p>
              @if (message.questions?.length) {
                <div class="flex flex-col gap-3">
                  @for (question of message.questions; track $index; let q = $index) {
                    <div>
                      <p class="font-medium">{{ question.text }}</p>
                      @if (last && open()) {
                        <div class="mt-1.5 flex flex-wrap gap-1.5">
                          @for (option of question.options; track option) {
                            <button
                              type="button"
                              class="rounded-full border px-2.5 py-1 text-sm"
                              [class]="picked()[q] === option ? 'border-accent bg-accent-soft text-accent' : 'border-border hover:bg-surface-3'"
                              [attr.aria-pressed]="picked()[q] === option"
                              (click)="pick(q, option)"
                            >
                              {{ option }}
                            </button>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </li>
          }
        }
        @if (draft().status === "thinking") {
          <li class="mr-10 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-fg-soft">
            <span class="size-2 shrink-0 rounded-full bg-info nx-pulse" aria-hidden="true"></span>
            <span class="min-w-0 flex-1 truncate">{{ draft().activity ?? agentLabel() + " está pensando…" }}</span>
            <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" (click)="stop.emit()"><nx-icon name="stop" [size]="13" />Parar</button>
          </li>
        }
      </ol>
      @if (draft().status === "error" && draft().error) {
        <p class="mt-3 rounded-md border border-err/40 bg-err-soft px-3 py-2 text-err" role="alert">{{ draft().error }}</p>
      }
    </div>

    @if (draft().status !== "created" && draft().status !== "applied") {
      <form class="flex flex-col gap-2 border-t border-border p-3" (submit)="$event.preventDefault(); submit()">
        @if (pickedLines().length) {
          <ul class="flex flex-col gap-0.5 text-sm text-fg-soft">
            @for (line of pickedLines(); track line) {
              <li class="truncate">✓ {{ line }}</li>
            }
          </ul>
        }
        <div class="flex items-end gap-2">
          <textarea
            class="nx-input min-h-10 flex-1 resize-y"
            rows="2"
            aria-label="Tu respuesta"
            [placeholder]="open() ? 'Contesta o cuéntale algo más (Enter envía, Mayús+Enter salta de línea)' : 'Espera a que el asistente termine…'"
            [disabled]="!open()"
            [value]="text()"
            (input)="text.set($any($event.target).value)"
            (keydown.enter)="onEnter($any($event))"
          ></textarea>
          <button type="submit" class="nx-btn nx-btn-primary" [disabled]="!open() || !answer()">Enviar</button>
        </div>
      </form>
    }
  `,
})
export class TicketChat {
  public readonly draft = input.required<ChatThread>();
  public readonly send = output<string>();
  public readonly stop = output<void>();

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>("scroller");

  protected readonly open = computed(() => this.draft().status === "idle" || this.draft().status === "error");
  protected readonly agentLabel = computed(() => AGENT_LABELS[this.draft().agent.agent]);
  protected readonly text = signal("");
  /** Suggested answers picked for the latest questions (reset when a new message arrives). */
  protected readonly picked = linkedSignal<number, Record<number, string>>({ source: () => this.draft().messages.length, computation: () => ({}) });

  private readonly questions = computed<TicketQuestion[]>(() => this.draft().messages.at(-1)?.questions ?? []);
  protected readonly pickedLines = computed(() =>
    Object.entries(this.picked()).map(([index, option]) => `${this.questions()[Number(index)]?.text ?? ""} → ${option}`),
  );
  protected readonly answer = computed(() => [...this.pickedLines(), this.text().trim()].filter(Boolean).join("\n"));

  public constructor() {
    // Follow the conversation as it grows.
    afterRenderEffect(() => {
      this.draft().messages.length;
      this.draft().status;
      const element = this.scroller().nativeElement;
      element.scrollTop = element.scrollHeight;
    });
  }

  protected pick(question: number, option: string): void {
    this.picked.update((picked) => {
      const { [question]: current, ...rest } = picked;
      return current === option ? rest : { ...rest, [question]: option };
    });
  }

  protected onEnter(event: KeyboardEvent): void {
    if (!event.shiftKey) {
      event.preventDefault();
      this.submit();
    }
  }

  protected submit(): void {
    const answer = this.answer();
    if (!this.open() || !answer) {
      return;
    }
    this.send.emit(answer);
  }

  /** After the answer reached the server (a failed send keeps it to try again). */
  public clear(): void {
    this.text.set("");
    this.picked.set({});
  }
}
