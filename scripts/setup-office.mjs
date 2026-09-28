import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const office = join(root, "third_party", "agent-office");
const lock = join(office, "package-lock.json");
const modules = join(office, "node_modules");
const stamp = join(modules, ".nexura-lock-sha256");
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Ejecuta este script con npm run setup:office.");
  process.exit(1);
}

function lockHash() {
  return createHash("sha256").update(readFileSync(lock)).digest("hex");
}

function runNpm(...args) {
  const result = spawnSync(process.execPath, [npmCli, ...args, "--prefix", office], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const installed = [
  "@lydell/node-pty",
  "esbuild",
  "three",
  "typescript",
  "vite",
].every((name) => existsSync(join(modules, name, "package.json")));
const esbuildAvailable = process.platform !== "win32" || existsSync(join(modules, "@esbuild", `win32-${process.arch}`, "esbuild.exe"));
const current = installed && esbuildAvailable && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === lockHash();

if (current) {
  console.log("Dependencias de Agent Office al día; recompilando.");
  runNpm("run", "build");
} else {
  console.log("Instalando dependencias de Agent Office.");
  runNpm("install");
  writeFileSync(stamp, `${lockHash()}\n`);
}
