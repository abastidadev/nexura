// Brings third_party/agent-office up to an upstream ref while keeping Nexura's local patches.
// It applies upstream's own diff (pinned commit -> target) as a three-way merge, so our hooks
// survive and real clashes are left as conflict markers. It never commits.
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

// The lockfile is always taken verbatim from upstream: our copy only drifts through npm versions.
const tmp = mkdtempSync(join(tmpdir(), "nexura-office-"));
const patch = join(tmp, "upstream.patch");
try {
  const diff = git(["diff", "--binary", "--full-index", pin.commit, target, "--", ".", ":(exclude)package-lock.json"]);
  if (diff.status !== 0) {
    console.error(diff.stderr);
    process.exit(1);
  }
  writeFileSync(patch, diff.stdout);
  if (diff.stdout.trim()) {
    const applied = git(["apply", "--3way", "--whitespace=nowarn", `--directory=${dir}`, patch]);
    process.stdout.write(applied.stdout);
    process.stderr.write(applied.stderr);
  }
  const lock = git(["show", `${target}:package-lock.json`]);
  if (lock.status === 0) writeFileSync(join(root, dir, "package-lock.json"), lock.stdout);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

writeFileSync(pinFile, `${JSON.stringify({ ...pin, commit: target }, null, 2)}\n`);
// Staged like the files `git apply --3way` just merged, so the whole update reads as one diff.
git(["add", "--", `${dir}/package-lock.json`, "third_party/agent-office.upstream.json"]);

const conflicts = gitOk(["diff", "--name-only", "--diff-filter=U"]);
if (conflicts) {
  console.error(
    `\nConflictos con los parches locales (ver third_party/agent-office.patches.md):\n${conflicts}\n` +
      "Resuélvelos, márcalos con git add y ejecuta npm run setup:office para recompilar.",
  );
  process.exit(2);
}

console.log("\nCambios de upstream aplicados sin conflictos. Recompilando y probando la oficina…");
const ok =
  runNpm("run", "setup:office") &&
  runNpm("run", "typecheck", "--prefix", dir) &&
  runNpm("test", "--prefix", dir);
if (!npmCli) console.log("Ejecuta npm run setup:office para instalar y recompilar.");
console.log(ok ? "\nAgent Office actualizado. Revisa el diff antes de confirmar." : "\nActualizado, pero la compilación o los tests de la oficina fallan.");
process.exit(ok ? 0 : 1);
