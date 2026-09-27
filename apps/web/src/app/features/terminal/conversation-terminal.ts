import { afterNextRender, afterRenderEffect, Component, DestroyRef, ElementRef, inject, input, signal, viewChild, type Signal } from "@angular/core";
import { TerminalSessions } from "./terminal-sessions";

/** Shows a conversation's terminal (kept by TerminalSessions) and keeps it sized to this box. */
@Component({
  selector: "nx-conversation-terminal",
  template: `
    <div #host class="h-full w-full px-2 py-1"></div>
    @if (connection() && !connection()!()) {
      <span class="absolute top-2 right-3 rounded bg-warn-soft px-2 py-0.5 text-xs text-warn" role="status">Reconectando…</span>
    }
  `,
  host: { class: "relative block min-h-0 min-w-0 bg-[var(--nx-bg)]" },
})
export class ConversationTerminal {
  public readonly conversationId = input.required<string>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>("host");
  private readonly sessions = inject(TerminalSessions);
  protected readonly connection = signal<Signal<boolean> | null>(null);
  private mounted?: string;

  public constructor() {
    afterRenderEffect(() => {
      const id = this.conversationId();
      if (this.mounted === id) {
        return;
      }
      if (this.mounted) {
        this.sessions.unmount(this.mounted);
      }
      this.mounted = id;
      this.connection.set(this.sessions.mount(id, this.host().nativeElement));
    });
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new ResizeObserver(() => this.mounted && this.sessions.fit(this.mounted));
      observer.observe(this.host().nativeElement);
      destroyRef.onDestroy(() => {
        observer.disconnect();
        if (this.mounted) {
          this.sessions.unmount(this.mounted);
        }
      });
    });
  }

  public focus(): void {
    if (this.mounted) {
      this.sessions.focus(this.mounted);
    }
  }
}
