import { Component, computed, inject, input, output, resource, signal } from "@angular/core";
import { AGENT_LABELS, type Conversation, type TranscriptMessage } from "@nexura/shared";
import { Api } from "../../core/api";
import { timeOfDay } from "../../core/format";

const PREVIEW_CHARS = 600;

/** The conversation as text, across every agent it went through (read from their session files, no tokens). */
@Component({
  selector: "nx-conversation-history",
  template: `
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      <span class="font-medium">Historial</span>
      <span class="text-xs text-muted">{{ messages().length }} mensajes</span>
      <span class="ml-auto flex gap-1">
        <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" title="Recargar" aria-label="Recargar el historial" (click)="history.reload()">↻</button>
        <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" title="Copiar como Markdown" (click)="copy()">
          {{ copied() ? "✓" : "⧉" }}
        </button>
        <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" aria-label="Cerrar el historial" (click)="closed.emit()">×</button>
      </span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      @if (history.isLoading() && !messages().length) {
        <p class="text-muted">Cargando…</p>
      } @else if (history.error()) {
        <p class="text-err">No se pudo leer el historial.</p>
      }
      @for (message of messages(); track $index) {
        <article class="mb-3">
          <header class="mb-0.5 flex items-center gap-1.5 text-xs">
            <span class="font-semibold" [class]="message.role === 'user' ? 'text-accent' : 'text-fg-soft'">
              {{ message.role === "user" ? "Tú" : agentLabels[message.agent] }}
            </span>
            @if (message.role === "user" && showAgent()) {
              <span class="text-muted">→ {{ agentLabels[message.agent] }}</span>
            }
            <span class="text-muted">{{ time(message.ts) }}</span>
          </header>
          <p class="text-sm break-words whitespace-pre-wrap" [class.text-fg-soft]="message.role === 'assistant'">{{ expanded().has($index) ? message.text : preview(message.text) }}</p>
          @if (message.text.length > previewChars) {
            <button type="button" class="text-xs text-accent hover:underline" (click)="toggle($index)">
              {{ expanded().has($index) ? "ver menos" : "ver todo" }}
            </button>
          }
          @if (message.tools?.length) {
            <ul class="mt-1 space-y-0.5 font-mono text-xs text-muted">
              @for (tool of message.tools; track $index) {
                <li class="truncate" [attr.title]="tool">• {{ tool }}</li>
              }
            </ul>
          }
        </article>
      } @empty {
        @if (!history.isLoading()) {
          <p class="text-muted">Todavía no hay mensajes (o el agente aún no ha guardado su sesión).</p>
        }
      }
    </div>
  `,
  host: { class: "flex min-h-0 flex-col bg-surface" },
})
export class ConversationHistory {
  private readonly api = inject(Api);
  public readonly conversation = input.required<Conversation>();
  public readonly closed = output<void>();

  protected readonly agentLabels = AGENT_LABELS;
  protected readonly previewChars = PREVIEW_CHARS;
  protected readonly copied = signal(false);
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());

  /** Reloads when the conversation changes state (a process ends, a session is found, the agent switches). */
  protected readonly history = resource({
    params: () => ({ id: this.conversation().id, version: `${this.conversation().updatedAt}:${this.conversation().segments.length}:${this.conversation().status}` }),
    loader: ({ params }) => this.api.conversationHistory(params.id),
  });
  protected readonly messages = computed<TranscriptMessage[]>(() => (this.history.hasValue() ? this.history.value() : []));
  protected readonly showAgent = computed(() => new Set(this.conversation().segments.map((segment) => segment.agent)).size > 1);

  protected time(ts: string): string {
    return ts && !Number.isNaN(Date.parse(ts)) ? timeOfDay(ts) : "";
  }

  protected preview(text: string): string {
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  }

  protected toggle(index: number): void {
    this.expanded.update((current) => {
      const next = new Set(current);
      if (!next.delete(index)) {
        next.add(index);
      }
      return next;
    });
  }

  protected async copy(): Promise<void> {
    const markdown = this.messages()
      .map((message) => `### ${message.role === "user" ? "Usuario" : AGENT_LABELS[message.agent]}\n\n${message.text}${message.tools?.length ? `\n\nHerramientas: ${message.tools.join(" · ")}` : ""}`)
      .join("\n\n");
    await navigator.clipboard?.writeText(markdown);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
