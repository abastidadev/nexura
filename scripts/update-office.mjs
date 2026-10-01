// Brings third_party/agent-office up to an upstream ref while keeping Nexura's local patches.
// It merges upstream's own change (pinned commit -> target) into our copy with git's merge, which
// follows files upstream renames, so our hooks survive and real clashes are left as conflict markers.
// It never commits.
//
//   npm run update:office            # latest upstream main
//   npm run update:office -- <ref>   # a branch, tag or commit
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dir = "third_party/agent-office";
const pinFile = join(root, "third_party", "agent-office.upstream.json");
const ref = process.argv[2] ?? "main";
const npmCli = process.env.npm_execpath;

function git(args, options = {}) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function gitOk(args, options) {
  const result = git(args, options);
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function runNpm(...args) {
  if (!npmCli) return true;
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: "inherit" });
  return result.status === 0;
}

const pin = JSON.parse(readFileSync(pinFile, "utf8"));

const dirty = gitOk(["status", "--porcelain", "--", dir]);
if (dirty) {
  console.error(`Hay cambios sin confirmar en ${dir}; confírmalos o descártalos antes de actualizar.\n${dirty}`);
  process.exit(1);
}

console.log(`Descargando ${ref} de ${pin.repo}…`);
gitOk(["fetch", "--no-tags", pin.repo, ref]);
const target = gitOk(["rev-parse", "FETCH_HEAD"]);
if (target === pin.commit) {
  console.log(`Agent Office ya está en ${target.slice(0, 7)}.`);
  process.exit(0);
}

const log = gitOk(["log", "--oneline", "--no-decorate", `${pin.commit}..${target}`]);
console.log(`${log.split("\n").filter(Boolean).length} commits nuevos (${pin.commit.slice(0, 7)} → ${target.slice(0, 7)}).`);

/**
 * A commit of HEAD's tree with `dir` swapped for upstream `commit`, so git can merge upstream's change
 * into ours with rename detection (`git apply` can't follow a file upstream moved or split).
 */
function graft(commit, parent, message) {
  const index = join(tmp, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  gitOk(["read-tree", "HEAD"], { env });
  gitOk(["rm", "-r", "-q", "--cached", "--", dir], { env });
  gitOk(["read-tree", `--prefix=${dir}/`, commit], { env });
  const tree = gitOk(["write-tree"], { env });
  rmSync(index, { force: true });
  return gitOk(["commit-tree", tree, "-p", parent, "-m", message]);
}

// Upstream's change (pinned commit -> target) merged into our copy; our patches survive, and real
// clashes are left as conflict markers. Then upstream's lockfile, to restore our dependencies onto.
const tmp = mkdtempSync(join(tmpdir(), "nexura-office-"));
try {
  const base = graft(pin.commit, "HEAD", `agent-office ${pin.commit.slice(0, 7)}`);
  const next = graft(target, base, `agent-office ${target.slice(0, 7)}`);
  const picked = git(["cherry-pick", "--no-commit", next]);
  process.stdout.write(picked.stdout);
  // Forget the cherry-pick itself: what it changed stays in the index and the working tree.
  git(["cherry-pick", "--quit"]);
  const unmerged = gitOk(["diff", "--name-only", "--diff-filter=U"]);
  if (picked.status !== 0 && !unmerged) {
    console.error(picked.stderr);
    process.exit(1);
  }
  const lock = git(["show", `${target}:package-lock.json`]);
  if (lock.status === 0) {
    writeFileSync(join(root, dir, "package-lock.json"), lock.stdout);
    git(["add", "--", `${dir}/package-lock.json`]);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

writeFileSync(pinFile, `${JSON.stringify({ ...pin, commit: target }, null, 2)}\n`);
// Staged like the files the merge just brought in, so the whole update reads as one diff.
git(["add", "--", "third_party/agent-office.upstream.json"]);

const conflicts = gitOk(["diff", "--name-only", "--diff-filter=U"]);
if (conflicts) {
  console.error(
    `\nConflictos con los parches locales (ver third_party/agent-office.patches.md):\n${conflicts}\n` +
      "Resuélvelos, márcalos con git add y ejecuta npm run setup:office para recompilar.",
  );
  process.exit(2);
}

if (npmCli && !runNpm("install", "--package-lock-only", "--ignore-scripts", "--prefix", dir)) {
  console.error("No se pudo actualizar el lockfile con las dependencias locales de Nexura.");
  process.exit(1);
}
git(["add", "--", `${dir}/package-lock.json`]);

console.log("\nCambios de upstream aplicados sin conflictos. Recompilando y probando la oficina…");
const ok =
  runNpm("run", "setup:office") &&
  runNpm("run", "typecheck", "--prefix", dir) &&
  runNpm("test", "--prefix", dir);
if (!npmCli) console.log("Ejecuta npm run setup:office para instalar y recompilar.");
console.log(ok ? "\nAgent Office actualizado. Revisa el diff antes de confirmar." : "\nActualizado, pero la compilación o los tests de la oficina fallan.");
process.exit(ok ? 0 : 1);
