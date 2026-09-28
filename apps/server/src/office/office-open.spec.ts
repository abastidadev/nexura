import type { RepoConfig } from "@nexura/shared";
import { describe, expect, it } from "vitest";
import { openTarget } from "./office-open.ts";

const repos: RepoConfig[] = [{ name: "app", path: "C:/code/app", baseBranch: "main", checks: [] }];

describe("openTarget", () => {
  it("opens a run or a prefilled new flow in an existing Nexura window", () => {
    expect(openTarget({ kind: "run", runId: "run-42" }, repos)).toEqual({ type: "open", path: ["/runs", "run-42"] });
    expect(openTarget({ kind: "new-run", ticketId: "42", source: "github", repoDir: "c:\\CODE\\APP", extra: "ignored" }, repos)).toEqual({
      type: "open",
      path: ["/new"],
      queryParams: { ticket: "42", source: "github", repo: "app" },
    });
  });

  it("rejects paths and unsupported requests", () => {
    expect(openTarget({ kind: "run", runId: "../other" }, repos)).toBeUndefined();
    expect(openTarget({ kind: "new-run", ticketId: "x", source: "github" }, repos)).toBeUndefined();
    expect(openTarget({ kind: "new-run", ticketId: "42", source: "other" }, repos)).toBeUndefined();
    expect(openTarget({ kind: "new-run", ticketId: "42", source: "github", repoDir: "\\\\other-host\\share" }, repos)).toEqual({
      type: "open", path: ["/new"], queryParams: { ticket: "42", source: "github" },
    });
  });
});
