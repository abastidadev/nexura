import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Ledger } from "./ledger.ts";

it("bounds the prompt ledger and supersedes old attempts without losing the audit trail", () => {
  const root = mkdtempSync(join(tmpdir(), "nexura-ledger-"));
  try {
    const ledger = new Ledger("run", root);
    ledger.append("implement (intento 1)", "obsolete output");
    ledger.append("codeReview", "obsolete finding");
    ledger.append("implement (intento 2)", "corrected implementation");
    ledger.append("codeReview", "approved");
    expect(ledger.readForPrompt()).toContain("corrected implementation");
    expect(ledger.readForPrompt()).not.toContain("obsolete");
    expect(ledger.read()).toContain("obsolete output");
    ledger.append("qaCode", "latest result " + "x".repeat(6000));
    expect(ledger.readForPrompt().length).toBeLessThanOrEqual(4000);
    expect(ledger.readForPrompt()).toContain("latest result");
    expect(ledger.read().length).toBeGreaterThan(6000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
