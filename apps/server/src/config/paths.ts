import { join, resolve } from "node:path";

/** Repo root of Nexura (apps/server/src/config -> ../../../..). Overridable for tests. */
export const NEXURA_HOME = resolve(process.env.NEXURA_HOME ?? join(import.meta.dirname, "..", "..", "..", ".."));

export const CONFIG_DIR = join(NEXURA_HOME, "config");
export const DATA_DIR = resolve(process.env.NEXURA_DATA_DIR ?? join(NEXURA_HOME, "data"));
export const RUNS_DIR = join(DATA_DIR, "runs");
export const DB_FILE = join(DATA_DIR, "nexura.sqlite");
export const MEMORY_DB_FILE = join(DATA_DIR, "memory.sqlite");
