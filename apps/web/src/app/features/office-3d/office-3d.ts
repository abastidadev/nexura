import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, resource, viewChild } from "@angular/core";
import { DomSanitizer, type SafeResourceUrl } from "@angular/platform-browser";
import { Router } from "@angular/router";
import { Api } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";

const DEFAULT_OFFICE_URL = "http://localhost:4600/";

const samePath = (a: string, b: string): boolean => {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
};

/** What the office sends up when a Nexura worker or a board card is opened (third_party/agent-office/src/client/nexura). */
type OfficeMessage = { type: "nexura:open-run"; runId: string } | { type: "nexura:new-run"; repoDir?: string; ticketId: string; source: "azure" | "github"; project?: string };

function officeMessage(data: unknown): OfficeMessage | undefined {
  const message = data as Partial<OfficeMessage> | null;
  if (message?.type === "nexura:open-run" && typeof message.runId === "string" && /^[\w-]+$/.test(message.runId)) {
    return message as OfficeMessage;
  }
  if (message?.type === "nexura:new-run" && typeof message.ticketId === "string" && (message.source === "azure" || message.source === "github")) {
    return message as OfficeMessage;
  }
  return undefined;
}

/**
 * The full Agent Office runs on its own local server and keeps its own sessions. Under
 * `npm run start:all` it also shows Nexura's runs at its desks; opening one lands here.
 */
@Component({
  selector: "nx-office-3d",
  templateUrl: "./office-3d.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex h-full min-h-0 flex-col" },
})
export class Office3DPage {
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>("frame");
  private readonly office = resource({ loader: () => this.api.getOffice() });

  /** Where the office runs; only a local http(s) address is framed. */
  protected readonly url = computed(() => {
    const url = this.office.value()?.url ?? DEFAULT_OFFICE_URL;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url) ? url : DEFAULT_OFFICE_URL;
  });
  protected readonly frameUrl = computed<SafeResourceUrl>(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.url()));
  protected readonly bridge = computed(() => this.office.value()?.bridge ?? false);

  constructor() {
    const listener = (event: MessageEvent) => this.onMessage(event);
    window.addEventListener("message", listener);
    inject(DestroyRef).onDestroy(() => window.removeEventListener("message", listener));
  }

  private onMessage(event: MessageEvent): void {
    // Only the office in our own iframe may steer the UI.
    const frame = this.frame()?.nativeElement;
    if (!frame || event.source !== frame.contentWindow) {
      return;
    }
    const message = officeMessage(event.data);
    if (message?.type === "nexura:open-run") {
      void this.router.navigate(["/runs", message.runId]);
    } else if (message?.type === "nexura:new-run") {
      // The office knows its floor by folder; Nexura's form wants the configured repo's name.
      const repoDir = message.repoDir;
      const repo = repoDir ? this.store.config()?.repos.find((candidate) => samePath(candidate.path, repoDir))?.name : undefined;
      void this.router.navigate(["/new"], { queryParams: { ticket: message.ticketId, source: message.source, repo } });
    }
  }
}
