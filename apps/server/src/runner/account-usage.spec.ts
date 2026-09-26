import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeWindows, codexWindows, parseClaudeReset, parseClaudeUsage, readClaudeUsage } from "./account-usage.ts";

describe("Claude account usage", () => {
  const report = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 60% used · resets Aug 10 at 8:59pm (Asia/Seoul)\nCurrent week (all models): 96% used · resets Aug 13 at 7:59am (Asia/Seoul)\nCurrent week (Fable): 100% used";

  it("reads the two plan windows without mixing in model-specific usage", () => {
    expect(claudeWindows(report)?.windows).toEqual([
      { label: "5 h", usedPercent: 60, resetText: "Aug 10 at 8:59pm (Asia/Seoul)" },
      { label: "7 d", usedPercent: 96, resetText: "Aug 13 at 7:59am (Asia/Seoul)" },
    ]);
  });

  it("converts Claude's reset time with its timezone, including year rollover", () => {
    expect(parseClaudeReset("Sep 26, 3:39pm (Europe/Madrid)", Date.parse("2026-09-26T10:00:00Z")))
      .toBe(Date.parse("2026-09-26T13:39:00Z") / 1000);
    expect(parseClaudeReset("Jan 1 at 1:00am (Europe/Madrid)", Date.parse("2026-12-31T22:00:00Z")))
      .toBe(Date.parse("2027-01-01T00:00:00Z") / 1000);
    expect(parseClaudeReset("Sep 27, 10am (Europe/Madrid)", Date.parse("2026-09-26T11:00:00Z")))
      .toBe(Date.parse("2026-09-27T08:00:00Z") / 1000);
    expect(parseClaudeReset("Sep 26, 3:39pm (Invalid/Zone)", Date.parse("2026-09-26T10:00:00Z"))).toBeUndefined();
  });

  it("accepts only a free, zero-turn CLI result", () => {
    const base = {
      result: report, is_error: false, num_turns: 0, duration_api_ms: 0, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard", server_tool_use: { web_search_requests: 0 } },
    };
    expect(parseClaudeUsage(JSON.stringify(base))?.windows).toHaveLength(2);
    expect(parseClaudeUsage(JSON.stringify({ ...base, num_turns: 1 }))).toBeUndefined();
    expect(parseClaudeUsage(JSON.stringify({ ...base, usage: { ...base.usage, input_tokens: 1 } }))).toBeUndefined();
    expect(parseClaudeUsage("not JSON")).toBeUndefined();
  });

  it("loads the report through the fake CLI without starting a turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexura-usage-"));
    const bin = join(dir, "fake-claude.mjs");
    const previous = process.env.NEXURA_CLAUDE_BIN;
    writeFileSync(bin, `
      const args = process.argv.slice(2);
      if (!args.includes("/usage") || !args.includes("--safe-mode") || !args.includes("--no-session-persistence")) process.exit(1);
      process.stdout.write(JSON.stringify({ result: ${JSON.stringify(report)}, is_error: false, num_turns: 0, duration_api_ms: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    `);
    process.env.NEXURA_CLAUDE_BIN = bin;
    try {
      expect((await readClaudeUsage())?.windows.map((window) => window.usedPercent)).toEqual([60, 96]);
    } finally {
      if (previous === undefined) delete process.env.NEXURA_CLAUDE_BIN;
      else process.env.NEXURA_CLAUDE_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex account usage", () => {
  it("uses the Codex bucket and keeps its two reset windows separate", () => {
    const usage = codexWindows({
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1000 },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2000 },
        },
        codex_other: { primary: { usedPercent: 90, windowDurationMins: 60, resetsAt: 3000 } },
      },
    });
    expect(usage?.windows).toEqual([
      { label: "5 h", usedPercent: 16, resetsAt: 1000 },
      { label: "7 d", usedPercent: 40, resetsAt: 2000 },
    ]);
  });

  it("omits unavailable or invalid windows", () => {
    expect(codexWindows({ rateLimits: null })).toBeUndefined();
    expect(codexWindows({ rateLimits: { primary: { usedPercent: NaN, resetsAt: 1000 } } })).toBeUndefined();
  });
});
