import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { learnRepoNotes, MAX_NOTES, readRepoNotes, repoMap } from "./repo-context.ts";

const root = mkdtempSync(join(tmpdir(), "nexura-context-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("repoMap", () => {
  it("summarises tracked files by directory and lists npm scripts", async () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src", "lib", "badge"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { lint: "x", build: "y" } }));
    writeFileSync(join(repo, "src", "lib", "badge", "badge.ts"), "");
    writeFileSync(join(repo, "src", "main.ts"), "");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "i"], { cwd: repo });

    const map = await repoMap({ repo: "demo", repoPath: repo, path: repo, branch: "b", baseRef: "main" });
    expect(map).toContain("**demo** (3 ficheros versionados)");
    expect(map).toContain("Raíz: package.json");
    expect(map).toContain("src/ (2)");
    expect(map).toContain("    badge/ (1)");
    expect(map).toContain("Scripts npm: lint, build");
  });
});

describe("learned repo notes", () => {
  it("appends new conventions only, ignoring case/markup duplicates, and keeps the latest", () => {
    const dataDir = join(root, "data");
    expect(learnRepoNotes("demo", ["Usa `inject()`", "Tailwind solo"], dataDir)).toBe(2);
    expect(learnRepoNotes("demo", ["usa inject()", "Nuevo: signals"], dataDir)).toBe(1);
    expect(readRepoNotes("demo", dataDir)).toBe("- Usa `inject()`\n- Tailwind solo\n- Nuevo: signals\n");

    learnRepoNotes("demo", Array.from({ length: MAX_NOTES }, (_, i) => `nota ${i}`), dataDir);
    const lines = readRepoNotes("demo", dataDir).trim().split("\n");
    expect(lines).toHaveLength(MAX_NOTES);
    expect(lines.at(-1)).toBe(`- nota ${MAX_NOTES - 1}`);
    expect(() => readRepoNotes("../x", dataDir)).toThrow(/no válido/);
  });
});
