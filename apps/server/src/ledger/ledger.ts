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

  /** Keep the latest entry per step, newest first; the full audit trail stays on disk. */
  public readForPrompt(maxChars = 4000): string {
    const entries = this.read().split(/(?=^### )/m).filter(Boolean);
    const seen = new Set<string>();
    const selected: string[] = [];
    for (const entry of entries.reverse()) {
      const key = entry.split(" — ")[0]!.replace(/\s+\(intento \d+\)$/, "");
      if (!seen.has(key)) {
        seen.add(key);
        selected.push(entry.trim());
      }
    }
    const text = selected.join("\n\n");
    if (text.length <= maxChars) {
      return text;
    }
    const marker = "\n… (historial completo guardado por Nexura)";
    return (text.slice(0, Math.max(0, maxChars - marker.length)) + marker).slice(0, Math.max(0, maxChars));
  }
}
