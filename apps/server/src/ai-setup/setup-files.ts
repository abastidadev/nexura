import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AiSetupFile } from "@nexura/shared";
import { isAgentConfigPath } from "../workspace/git.ts";

export const MAX_FILE_CHARS = 100_000;

/** What a plugin marketplace like the ai-toolkit adds to the agent configuration paths. */
const TOOLKIT_PATH = /^(plugins\/|\.claude-plugin\/|CHANGELOG\.md$|README\.md$)/;

/** A repo that is a Claude Code plugin marketplace (the ai-toolkit or one like it). */
export function isToolkitRepo(repoPath: string): boolean {
  return existsSync(join(repoPath, ".claude-plugin", "marketplace.json"));
}

/** A path the Setup IA section may not write; `status` is the HTTP status the API answers with. */
export class SetupPathError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The path as written to disk, relative and with forward slashes, or an error: only agent
 * configuration (plus plugins, catalogue, changelog and README in a toolkit repo), nothing
 * under `.git`, never outside the repo.
 */
export function checkSetupPath(path: string, toolkit: boolean): string {
  const clean = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || clean.length > 300 || clean.includes("\0")) {
    throw new SetupPathError(400, `Ruta no válida: ${clean || "(vacía)"}`);
  }
  if (clean.startsWith("/") || /^[a-z]:/i.test(clean)) {
    throw new SetupPathError(400, `La ruta tiene que ser relativa a la raíz del repo: ${clean}`);
  }
  const segments = clean.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SetupPathError(400, `Ruta no válida: ${clean}`);
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    throw new SetupPathError(400, `No se escribe dentro de .git: ${clean}`);
  }
  if (!isAgentConfigPath(clean) && !(toolkit && TOOLKIT_PATH.test(clean))) {
    throw new SetupPathError(400, `Setup IA solo escribe configuración de agentes (CLAUDE.md, AGENTS.md, .claude/, .mcp.json…), no ${clean}`);
  }
  return clean;
}

export function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** sha256 of the file as it is on disk, "" if it does not exist (or is not a readable file). */
export function diskHash(repoPath: string, path: string): string {
  try {
    return hashOf(readFileSync(join(repoPath, path), "utf8"));
  } catch {
    return "";
  }
}

/** Refuses a target that leaves the repo through a link (the file itself or a folder on the way). */
function assertInside(repoPath: string, path: string): void {
  const root = realpathSync(repoPath);
  const target = resolve(root, path);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new SetupPathError(400, `${path} es un enlace: no se sobrescribe`);
  }
  let existing = dirname(target);
  while (!existsSync(existing)) {
    existing = dirname(existing);
  }
  const real = realpathSync(existing);
  const inside = relative(root, real);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new SetupPathError(400, `${path} sale del repo`);
  }
}

/** What would stop a file from being written as it is; checked for all of them before writing any. */
export function checkSetupFile(repoPath: string, file: AiSetupFile, toolkit: boolean, secretIn: (text: string) => string | undefined): string {
  const path = checkSetupPath(file.path, toolkit);
  if (file.content.length > MAX_FILE_CHARS) {
    throw new SetupPathError(400, `${path} es demasiado largo`);
  }
  if (!file.content.trim()) {
    throw new SetupPathError(400, `${path} está vacío`);
  }
  if (path.endsWith(".json")) {
    try {
      JSON.parse(file.content);
    } catch (error) {
      throw new SetupPathError(400, `${path} no es JSON válido: ${(error as Error).message}`);
    }
  }
  const secret = secretIn(file.content);
  if (secret) {
    throw new SetupPathError(400, `${path} parece contener ${secret}. Quítalo antes de escribirlo.`);
  }
  assertInside(repoPath, path);
  // The person reviewed the version the assistant read: never overwrite a newer one.
  if (diskHash(repoPath, path) !== file.baseHash) {
    throw new SetupPathError(409, file.baseHash ? `${path} ha cambiado desde que el asistente lo leyó: pídele que lo vuelva a mirar` : `${path} ya existe: pídele al asistente que lo lea y lo integre`);
  }
  return path;
}

export function writeSetupFile(repoPath: string, path: string, content: string): void {
  const target = join(repoPath, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`);
}
