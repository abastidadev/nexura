import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckTrial } from "@nexura/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CheckTrials } from "./check-trial.ts";

const dirs: string[] = [];

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "nexura-trial-"));
  dirs.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "ok.txt"), "base");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return repo;
}

async function finished(trials: CheckTrials, id: string): Promise<CheckTrial> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const trial = trials.get(id)!;
    if (trial.status !== "running") {
      return trial;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("La prueba no terminó");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CheckTrials", () => {
  it("runs each check on a clean worktree of the base branch and removes it", async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "ok.txt"), "uncommitted change that the base does not have");
    const trials = new CheckTrials(30_000);
    const started = trials.start({ path: repo, baseBranch: "main", nodeModules: "none" }, [
      "node -e \"process.exit(require('fs').readFileSync('ok.txt','utf8')==='base'?0:1)\"",
      "node -e \"console.log('boom'); process.exit(3)\"",
    ]);
    expect(started.results.map((result) => result.status)).toEqual(["pending", "pending"]);

    const trial = await finished(trials, started.id);
    expect(trial).toMatchObject({ status: "done", baseRef: "main" });
    expect(trial.results[0]).toMatchObject({ status: "passed", exitCode: 0 });
    expect(trial.results[1]).toMatchObject({ status: "failed", exitCode: 3, outputTail: expect.stringContaining("boom") });
    expect(existsSync(`${repo}.worktrees/nexura-checks-${trial.id}`)).toBe(false);
  });

  it("never deletes through a node_modules link that a checkout hook added", async () => {
    const repo = gitRepo();
    const shared = join(repo, "..", "shared-node_modules");
    mkdirSync(shared);
    writeFileSync(join(shared, "keep.txt"), "x");
    const trials = new CheckTrials(30_000);
    // The check plays the post-checkout hook of a monorepo: frontend/node_modules -> the main checkout's.
    const hook = `node -e "const fs=require('fs');fs.mkdirSync('frontend');fs.symlinkSync(process.argv[1],'frontend/node_modules','junction')" "${shared}"`;
    const trial = await finished(trials, trials.start({ path: repo, baseBranch: "main", nodeModules: "none" }, [hook]).id);
    expect(trial.results[0]).toMatchObject({ status: "passed" });
    expect(existsSync(`${repo}.worktrees/nexura-checks-${trial.id}`)).toBe(false);
    expect(existsSync(join(shared, "keep.txt"))).toBe(true);
  });

  it("reports a missing base branch without running anything", async () => {
    const repo = gitRepo();
    const trials = new CheckTrials(30_000);
    const trial = await finished(trials, trials.start({ path: repo, baseBranch: "develop" }, ["node -e \"0\""]).id);
    expect(trial).toMatchObject({ status: "failed", error: expect.stringContaining("develop"), results: [{ status: "skipped" }] });
  });

  it("refuses an empty list and a second trial of the same repo", async () => {
    const repo = gitRepo();
    const trials = new CheckTrials(30_000);
    expect(() => trials.start({ path: repo, baseBranch: "main" }, [" "])).toThrow(/No hay checks/);
    const first = trials.start({ path: repo, baseBranch: "main" }, ["node -e \"0\""]);
    expect(() => trials.start({ path: repo, baseBranch: "main" }, ["node -e \"0\""])).toThrow(/en marcha/);
    await finished(trials, first.id);
  });
});
