import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "../config/paths.ts";

/**
 * "Libro de tareas": short record of what each step did (plus commit SHAs), fed to later
 * steps so they don't have to re-read everything.
 */
export class Ledger {
  private readonly file: string;

  public constructor(runId: string, runsDir = RUNS_DIR) {
    const dir = join(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "ledger.md");
  }

  public append(step: string, text: string): void {
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    appendFileSync(this.file, `### ${step} — ${stamp}\n${text.trim()}\n\n`);
  }

  public read(): string {
    return existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
  }
}
