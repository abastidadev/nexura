import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { CheckKind, CheckSuggestion } from "@nexura/shared";

const KIND_ORDER: CheckKind[] = ["format", "lint", "typecheck", "build", "test", "other"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "bin", "obj", "target", "vendor", "third_party", "coverage"]);
/** Instructions for agents and contributors: the commands they must pass. */
const DOC_FILES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", ".github/copilot-instructions.md"];
const MAX_DEPTH = 2;

/** Scripts that start, watch, write, install or ship something: never a check. */
const NOT_A_CHECK_NAME = /start|serve|watch|dev$|^dev[:-]|kill|link|deploy|release|publish|prepare|clean|extract|generate|compile|setup|install|^ng$|prettify$|^format$|[:-]fix$|client|prod/i;
const NOT_A_CHECK_BODY = /--write|--fix\b|\bnpm (i|install|ci)\b|\b(pnpm|yarn) install\b|\bserve\b|--watch(?!=false)|\bwatch\b(?!=)|tauri|docker|deploy|publish/i;
const CI_SKIP = /\$\{\{|\b(npm (ci|install|i)|pnpm install|yarn install|docker|deploy|publish|upload|release|echo|curl|az|gh)\b|--write|--fix\b|actions\//i;
const CI_CHECK = /\b(lint|test|build|typecheck|type-check|tsc|format|prettier|eslint|check|vet|clippy|ruff|mypy|pytest|dotnet|cargo|go (vet|test|build)|e2e|cypress|playwright)\b/i;
const SLOW = /storybook|e2e|cypress|playwright|integration/i;

type Candidate = CheckSuggestion & { order: number };

class Suggestions {
  private readonly byCommand = new Map<string, Candidate>();
  private order = 0;

  public add(command: string, kind: CheckKind, source: string, recommended: boolean, note?: string): void {
    const key = normalize(command);
    const existing = this.byCommand.get(key);
    if (existing) {
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
      }
      // A check the CI or the docs ask for is recommended unless it is known to be a problem.
      existing.recommended ||= recommended && !existing.note;
      return;
    }
    this.byCommand.set(key, { command: key, kind, sources: [source], recommended: recommended && !note, ...(note ? { note } : {}), order: this.order++ });
  }

  /** Marks an already found check as asked for by the docs. */
  public mention(command: string, source: string): boolean {
    const existing = this.byCommand.get(normalize(command));
    if (!existing) {
      return false;
    }
    this.add(existing.command, existing.kind, source, true);
    return true;
  }

  public list(): CheckSuggestion[] {
    return [...this.byCommand.values()]
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.order - b.order)
      .map(({ order: _order, ...suggestion }) => suggestion);
  }
}

/** Same check whatever its spelling: `npm run test` is `npm test`, spaces collapsed. */
function normalize(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/\bnpm run(-script)? test\b/g, "npm test");
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

/** `cd <dir> && ` for a check that must run in a subfolder (e.g. `frontend/` of a monorepo). */
function inDir(dir: string, command: string): string {
  return dir && dir !== "." ? `cd ${dir} && ${command}` : command;
}

/** The repo and its folders down to MAX_DEPTH, skipping hidden, dependency and output folders. */
function folders(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    found.push(dir);
    if (depth >= MAX_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
        walk(join(dir, entry.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

function packageManager(dir: string, root: string): "npm" | "pnpm" | "yarn" | "bun" {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(current, "yarn.lock"))) return "yarn";
    if (existsSync(join(current, "bun.lockb")) || existsSync(join(current, "bun.lock"))) return "bun";
    if (existsSync(join(current, "package-lock.json")) || current === root || dirname(current) === current) return "npm";
  }
}

function scriptCommand(manager: ReturnType<typeof packageManager>, script: string): string {
  if (manager === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  return manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
}

/** A script's body with the scripts it calls (`npm run x`, `npm-run-all x y`), two levels deep. */
function expandedBody(scripts: Record<string, string>, name: string, depth = 0): string {
  const body = scripts[name] ?? "";
  if (depth >= 2) {
    return body;
  }
  const called = Object.keys(scripts).filter((other) => other !== name && calls(body, other));
  return [body, ...called.map((other) => expandedBody(scripts, other, depth + 1))].join("\n");
}

function calls(body: string, script: string): boolean {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `npm run x`, `pnpm run x`, `yarn x`, `run-s a x`, `npm-run-all --parallel a x`.
  return new RegExp(`\\b(run(-s|-p|-all)?|yarn)\\s+([\\w:-]+\\s+)*${escaped}(\\s|$|&|;|")`).test(body);
}

type ScriptCheck = { kind: CheckKind; recommended: boolean; note?: string };

function classifyScript(name: string, scripts: Record<string, string>): ScriptCheck | undefined {
  const body = scripts[name] ?? "";
  // `prebuild`/`postbuild` are npm hooks of another script, not checks of their own.
  const hookOf = /^(pre|post)(.+)$/.exec(name)?.[2];
  if ((hookOf && scripts[hookOf] !== undefined) || NOT_A_CHECK_NAME.test(name) || NOT_A_CHECK_BODY.test(body)) {
    return undefined;
  }
  if (/(prettier|prettify|format)[:-]?check|check[:-]?format/i.test(name) || /prettier\b.*--(check|list-different)/.test(body)) {
    return { kind: "format", recommended: true };
  }
  if (/^lint$/i.test(name)) {
    return { kind: "lint", recommended: true };
  }
  if (/^lint[:-]/i.test(name) && !scripts["lint"]) {
    return { kind: "lint", recommended: false };
  }
  if (/^(typecheck|type-check|check[:-]?types|types|tsc)$/i.test(name)) {
    return { kind: "typecheck", recommended: true };
  }
  if (/^build([:-].+)?$/i.test(name)) {
    if (SLOW.test(name)) {
      return { kind: "build", recommended: false, note: "Lento: compila Storybook o un entorno completo" };
    }
    if (name !== "build" && scripts["build"]) {
      return undefined;
    }
    const builds = Object.keys(scripts).filter((other) => /^build([:-].+)?$/i.test(other) && !SLOW.test(other) && !NOT_A_CHECK_NAME.test(other));
    return { kind: "build", recommended: name === "build" || builds.length === 1 };
  }
  if (/^test([:-].+)?$/i.test(name) || /^(e2e|cypress|playwright)/i.test(name)) {
    if (/no test specified/.test(body)) {
      return undefined;
    }
    const endToEnd = /e2e|cypress|playwright|integration/i;
    if (endToEnd.test(name) || endToEnd.test(body)) {
      return { kind: "test", recommended: false, note: "Lento: pruebas end-to-end" };
    }
    if (name !== "test" && scripts["test"]) {
      return undefined;
    }
    const expanded = expandedBody(scripts, name);
    if (/\bng test\b|\bkarma\b/.test(expanded) && !/--watch=false|--no-watch|--single-run/.test(expanded)) {
      return { kind: "test", recommended: false, note: "ng test se queda en modo watch y abre un navegador: añade --watch=false o --browsers=ChromeHeadless" };
    }
    return { kind: "test", recommended: true };
  }
  if (/(^|[:-])(checks?|verify|validate|audit|find)([:-]|$)/i.test(name)) {
    return { kind: "other", recommended: false };
  }
  return undefined;
}

/**
 * Suggests the checks among a package's scripts and returns their kinds. `skipKinds`: what the
 * root of an npm workspace already checks for all its packages.
 */
function detectPackageScripts(root: string, dir: string, suggestions: Suggestions, skipKinds = new Set<CheckKind>()): Set<CheckKind> {
  const kinds = new Set<CheckKind>();
  const manifest = readText(join(dir, "package.json"));
  if (!manifest) {
    return kinds;
  }
  let scripts: Record<string, string>;
  try {
    scripts = (JSON.parse(manifest) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return kinds;
  }
  const rel = posix(relative(root, dir)) || ".";
  const manager = packageManager(dir, root);
  const source = rel === "." ? "package.json" : `${rel}/package.json`;
  const checks = new Map<string, ScriptCheck>();
  for (const name of Object.keys(scripts)) {
    const check = classifyScript(name, scripts);
    if (check) {
      checks.set(name, check);
    }
  }
  // A script that another suggested script already runs (lint-lib inside lint) is not suggested apart.
  for (const name of [...checks.keys()]) {
    if ([...checks.keys()].some((other) => other !== name && calls(scripts[other] ?? "", name))) {
      checks.delete(name);
    }
  }
  for (const [name, check] of checks) {
    if (!skipKinds.has(check.kind)) {
      suggestions.add(inDir(rel, scriptCommand(manager, name)), check.kind, source, check.recommended, check.note);
      kinds.add(check.kind);
    }
  }
  return kinds;
}

function kindOf(command: string): CheckKind {
  if (/prettier|format|fmt/i.test(command)) return "format";
  if (/lint|eslint|clippy|ruff|vet\b/i.test(command)) return "lint";
  if (/typecheck|type-check|tsc|mypy/i.test(command)) return "typecheck";
  if (/test|pytest/i.test(command)) return "test";
  if (/build/i.test(command)) return "build";
  return "other";
}

type CiStep = { commands: string[]; dir?: string };

/**
 * `run:` (GitHub Actions) or `script:`/`bash:`/`pwsh:` (Azure Pipelines) commands of a CI file,
 * with their step's working directory. Line-based: enough for the usual layouts, no YAML parser.
 */
export function parseCiSteps(text: string, runKeys: string[], dirKey: string): CiStep[] {
  const lines = text.split(/\r?\n/);
  const steps: (CiStep & { indent: number })[] = [];
  let defaultDir: string | undefined;
  let current: (CiStep & { indent: number }) | undefined;
  const keyPattern = new RegExp(`^(\\s*)(-\\s+)?(${runKeys.join("|")}):\\s*(.*)$`);
  const dirPattern = new RegExp(`^\\s*(-\\s+)?${dirKey}:\\s*["']?([^"'#]*?)["']?\\s*(#.*)?$`);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    // A step is a list item; it ends at the next line that is not indented under its dash.
    if (current && line.search(/\S/) <= current.indent) {
      current = undefined;
    }
    const item = /^(\s*)-\s/.exec(line);
    if (item) {
      current = { commands: [], indent: item[1]!.length, dir: defaultDir };
      steps.push(current);
    }
    const dir = dirPattern.exec(line);
    if (dir) {
      // Outside a step: `defaults.run.working-directory` of the workflow or job.
      if (current) {
        current.dir = dir[2]!.trim();
      } else {
        defaultDir = dir[2]!.trim();
      }
      continue;
    }
    const match = keyPattern.exec(line);
    const value = match?.[4]!.trim();
    // An empty value is a mapping (`defaults: run:`), not a command.
    if (!match || !current || !value) {
      continue;
    }
    if (!/^[|>][-+]?$/.test(value)) {
      current.commands.push(value.replace(/^(["'])(.*)\1$/, "$2"));
      continue;
    }
    const keyIndent = match[1]!.length + (match[2]?.length ?? 0);
    while (index + 1 < lines.length && (!lines[index + 1]!.trim() || lines[index + 1]!.search(/\S/) > keyIndent)) {
      current.commands.push(lines[++index]!.trim());
    }
  }
  return steps
    .map(({ commands, dir }) => ({
      commands: commands.flatMap((command) => command.split(/\s+&&\s+/)).map((command) => command.trim()).filter((command) => command && !command.startsWith("#")),
      ...(dir ? { dir } : {}),
    }))
    .filter((step) => step.commands.length);
}

function detectCi(root: string, suggestions: Suggestions): void {
  const files: { file: string; runKeys: string[]; dirKey: string }[] = [];
  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows)) {
      if (/\.ya?ml$/i.test(name)) {
        files.push({ file: join(workflows, name), runKeys: ["run"], dirKey: "working-directory" });
      }
    }
  }
  for (const name of ["azure-pipelines.yml", "azure-pipelines.yaml", ".azure-pipelines.yml"]) {
    if (existsSync(join(root, name))) {
      files.push({ file: join(root, name), runKeys: ["script", "bash", "pwsh", "powershell"], dirKey: "workingDirectory" });
    }
  }
  for (const { file, runKeys, dirKey } of files) {
    const text = readText(file);
    if (!text) {
      continue;
    }
    const source = `CI: ${posix(relative(root, file))}`;
    for (const step of parseCiSteps(text, runKeys, dirKey)) {
      const dir = step.dir?.replace(/^\.\/?/, "").replace(/\/$/, "");
      for (const command of step.commands) {
        if (CI_SKIP.test(command) || !CI_CHECK.test(command)) {
          continue;
        }
        const slow = SLOW.test(command);
        suggestions.add(inDir(dir ?? "", command), kindOf(command), source, !slow, slow ? "Lento en local: el CI lo ejecuta aparte" : undefined);
      }
    }
  }
}

function detectOtherEcosystems(root: string, dir: string, suggestions: Suggestions): void {
  const rel = posix(relative(root, dir)) || ".";
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const at = (file: string): string => (rel === "." ? file : `${rel}/${file}`);
  // A project inside a JS app (a Tauri or Capacitor backend) is optional: it needs its own toolchain.
  const host = rel.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/")).find((ancestor) => existsSync(join(root, ancestor, "package.json")));
  const note = host ? `Proyecto dentro de ${host}/: necesita su propio toolchain` : undefined;
  const suggest = (command: string, kind: CheckKind, source: string, recommended = true): void =>
    suggestions.add(inDir(rel, command), kind, source, recommended, note);
  const solution = names.find((name) => /\.sln$/i.test(name));
  const project = names.find((name) => /\.csproj$/i.test(name));
  if (solution || (project && rel === ".")) {
    const source = at(solution ?? project!);
    suggest("dotnet build", "build", source, true);
    // A test project in the solution (or next to the project).
    const text = solution ? readText(join(dir, solution)) ?? "" : names.join("\n");
    if (/test/i.test(text)) {
      suggest("dotnet test", "test", source, true);
    }
  }
  const python = ["pyproject.toml", "setup.cfg", "requirements-dev.txt", "requirements.txt"].filter((name) => names.includes(name));
  if (python.length) {
    const text = python.map((name) => readText(join(dir, name)) ?? "").join("\n");
    if (/\bruff\b/.test(text)) suggest("ruff check .", "lint", at(python[0]!), true);
    if (/\bmypy\b/.test(text)) suggest("mypy .", "typecheck", at(python[0]!), true);
    if (/\bpytest\b/.test(text) || names.includes("tests")) suggest("pytest", "test", at(python[0]!), true);
  }
  if (names.includes("Cargo.toml")) {
    suggest("cargo clippy", "lint", at("Cargo.toml"), true);
    suggest("cargo test", "test", at("Cargo.toml"), true);
  }
  if (names.includes("go.mod")) {
    suggest("go vet ./...", "lint", at("go.mod"), true);
    suggest("go test ./...", "test", at("go.mod"), true);
  }
  if (names.includes("Makefile")) {
    const text = readText(join(dir, "Makefile")) ?? "";
    for (const target of text.matchAll(/^(lint|check|typecheck|test|fmt-check|format-check):/gm)) {
      suggest(`make ${target[1]}`, kindOf(target[1]!), at("Makefile"), target[1] !== "test");
    }
  }
}

/** Checks the agent instructions name (`npm run i18n:find`): recommended, in whichever folder has the script. */
function detectDocMentions(root: string, dirs: string[], suggestions: Suggestions): void {
  for (const doc of DOC_FILES) {
    const text = readText(join(root, doc));
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(/\b(npm run|npm|pnpm run|pnpm|yarn|bun run)\s+([\w:.-]+)/g)) {
      const script = match[2]!;
      for (const dir of dirs) {
        const rel = posix(relative(root, dir)) || ".";
        const command = inDir(rel, scriptCommand(packageManager(dir, root), script));
        if (suggestions.mention(command, doc)) {
          break;
        }
      }
    }
  }
}

/** QA checks a repo is meant to pass, read from its CI, manifests and agent instructions. */
export function detectChecks(repoPath: string): CheckSuggestion[] {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`No existe la carpeta ${repoPath}`);
  }
  const suggestions = new Suggestions();
  const dirs = folders(repoPath);
  detectCi(repoPath, suggestions);
  const workspaceRoot = /"workspaces"s*:/.test(readText(join(repoPath, "package.json")) ?? "");
  let rootKinds = new Set<CheckKind>();
  for (const dir of dirs) {
    const kinds = detectPackageScripts(repoPath, dir, suggestions, dir === repoPath || !workspaceRoot ? undefined : rootKinds);
    if (dir === repoPath) {
      rootKinds = kinds;
    }
    detectOtherEcosystems(repoPath, dir, suggestions);
  }
  detectDocMentions(repoPath, dirs, suggestions);
  return suggestions.list();
}
