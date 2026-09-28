import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChecks, parseCiSteps } from "./check-detection.ts";

const dirs: string[] = [];

function repo(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), "nexura-checks-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectChecks", () => {
  it("picks the checks among a package's scripts, in its folder, and leaves out the rest", () => {
    const root = repo({
      "frontend/package.json": {
        scripts: {
          start: "ng serve",
          build: "npm run build-lib && ng build app",
          "build-lib": "ng build lib",
          "build-storybook": "ng run lib:build-storybook",
          prebuild: "node gen.js",
          lint: "ng lint",
          "lint-lib": "ng lint lib",
          prettify: "prettier --write .",
          "prettify-check": "prettier --check .",
          test: "ng test",
          "i18n:find": "transloco-keys-manager find",
          checks: "npm i && npm run prettify && npm run lint",
        },
      },
      "frontend/package-lock.json": "{}",
      "CLAUDE.md": "Before committing run `npm run i18n:find` and `npm run lint`.",
    });
    const checks = detectChecks(root);
    expect(checks.filter((check) => check.recommended).map((check) => check.command)).toEqual([
      "cd frontend && npm run prettify-check",
      "cd frontend && npm run lint",
      "cd frontend && npm run build",
      "cd frontend && npm run i18n:find",
    ]);
    expect(checks.find((check) => check.command.endsWith("i18n:find"))!.sources).toEqual(["frontend/package.json", "CLAUDE.md"]);
    expect(checks.find((check) => check.command === "cd frontend && npm test")).toMatchObject({ recommended: false, note: expect.stringContaining("watch") });
    expect(checks.find((check) => check.command.endsWith("build-storybook"))).toMatchObject({ recommended: false });
    expect(checks.map((check) => check.command)).not.toEqual(expect.arrayContaining([expect.stringMatching(/prebuild|build-lib|lint-lib|checks|start|prettify$/)]));
  });

  it("reads CI steps with their working directory and merges them with the scripts", () => {
    const root = repo({
      ".github/workflows/ci.yml": [
        "on: push",
        "defaults:",
        "  run:",
        "    working-directory: web",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm ci",
        "      - name: Lint and test",
        "        run: |",
        "          npm run lint",
        "          npm run test",
        "      - name: API",
        "        working-directory: ./api",
        "        run: dotnet test --no-build && echo done",
        "      - run: npm run e2e",
      ].join("\n"),
      "web/package.json": { scripts: { lint: "eslint .", test: "vitest run", check: "node verify.js" } },
    });
    const checks = detectChecks(root);
    expect(checks.map((check) => [check.command, check.recommended])).toEqual([
      ["cd web && npm run lint", true],
      ["cd web && npm test", true],
      ["cd api && dotnet test --no-build", true],
      ["cd web && npm run e2e", false],
      ["cd web && npm run check", false],
    ]);
    expect(checks[0]!.sources).toEqual(["CI: .github/workflows/ci.yml", "web/package.json"]);
  });

  it("does not repeat in the packages of an npm workspace what its root already checks", () => {
    const root = repo({
      "package.json": { workspaces: ["apps/*"], scripts: { test: "vitest run", typecheck: "tsc -p ." } },
      "apps/web/package.json": { scripts: { test: "vitest run", lint: "eslint ." } },
    });
    expect(detectChecks(root).map((check) => check.command)).toEqual(["cd apps/web && npm run lint", "npm run typecheck", "npm test"]);
  });

  it("suggests the usual checks of other ecosystems, optional inside a JS app", () => {
    const root = repo({
      "Api.sln": "Project(\"Api\")\nProject(\"Api.Tests\")",
      "tools/pyproject.toml": "[tool.ruff]\n[tool.pytest.ini_options]",
      "app/package.json": { scripts: {} },
      "app/src-tauri/Cargo.toml": "[package]",
    });
    const checks = detectChecks(root);
    expect(checks.filter((check) => check.recommended).map((check) => check.command)).toEqual([
      "cd tools && ruff check .",
      "dotnet build",
      "dotnet test",
      "cd tools && pytest",
    ]);
    expect(checks.find((check) => check.command === "cd app/src-tauri && cargo clippy")).toMatchObject({ recommended: false, note: expect.stringContaining("app/") });
  });

  it("fails on a folder that does not exist", () => {
    expect(() => detectChecks(join(tmpdir(), "nexura-no-such-repo"))).toThrow(/No existe/);
  });
});

describe("parseCiSteps", () => {
  it("reads Azure Pipelines scripts", () => {
    const yaml = ["steps:", "- script: npm run lint", "  workingDirectory: frontend", "- bash: |", "    npm test", "  displayName: Test"].join("\n");
    expect(parseCiSteps(yaml, ["script", "bash"], "workingDirectory")).toEqual([
      { commands: ["npm run lint"], dir: "frontend" },
      { commands: ["npm test"] },
    ]);
  });
});
