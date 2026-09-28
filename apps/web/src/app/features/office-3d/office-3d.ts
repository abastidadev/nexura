import { ChangeDetectionStrategy, Component } from "@angular/core";

/** The full Agent Office runs on its own local server and keeps its own sessions. */
@Component({
  selector: "nx-office-3d",
  templateUrl: "./office-3d.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex h-full min-h-0 flex-col" },
})
export class Office3DPage {}
