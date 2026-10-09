import path from "node:path";
import { fileURLToPath } from "node:url";

import { CatalogueStoreError } from "../persistence/errors.ts";

export type CatalogueStoreConfig = { adapter: "static" } | { adapter: "sqlite"; file: string };

/**
 * Which catalogue adapter the runtime binds (DYAI-39). Unset or `static`: the validated bootstrap data
 * (unchanged behaviour). `sqlite`: the durable store at DATABASE_URL, which must be a `file:` URL.
 * Anything else is a configuration error; nothing falls back to the static data. Error messages name
 * the variable, never its value (a mistyped URL may carry credentials).
 */
export function readCatalogueStoreConfig(env: Record<string, string | undefined>): CatalogueStoreConfig {
  const adapter = (env.COMMAND_STORE_ADAPTER ?? "").trim();
  if (adapter === "" || adapter === "static") return { adapter: "static" };
  if (adapter !== "sqlite") throw new CatalogueStoreError("CONFIG_INVALID", "COMMAND_STORE_ADAPTER must be `static` or `sqlite`");
  return { adapter: "sqlite", file: databaseFile(env.DATABASE_URL) };
}

/** Absolute database path from `file:///abs/path` or `file:relative/or/abs/path` (resolved against cwd). */
export function databaseFile(url: string | undefined): string {
  const value = (url ?? "").trim();
  if (value === "") throw new CatalogueStoreError("CONFIG_INVALID", "DATABASE_URL is required when COMMAND_STORE_ADAPTER=sqlite");
  if (!value.startsWith("file:")) throw new CatalogueStoreError("CONFIG_INVALID", "DATABASE_URL must be a file: URL for the sqlite adapter");
  let file: string;
  try {
    file = value.startsWith("file://") ? fileURLToPath(value) : path.resolve(value.slice("file:".length));
  } catch {
    throw new CatalogueStoreError("CONFIG_INVALID", "DATABASE_URL is not a valid file: URL");
  }
  if (value.slice("file:".length).replace(/^\/+/, "") === "" || /:memory:|\?mode=memory/.test(value)) {
    throw new CatalogueStoreError("CONFIG_INVALID", "DATABASE_URL must name a durable file, not an in-memory database");
  }
  return file;
}
