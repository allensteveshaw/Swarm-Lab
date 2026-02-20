import { drizzle } from "drizzle-orm/postgres-js";

import { getSql } from "./client";

declare global {
  // eslint-disable-next-line no-var
  var __swarmDb: ReturnType<typeof drizzle> | undefined;
}

let cachedDb: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (cachedDb) return cachedDb;
  if (globalThis.__swarmDb) {
    cachedDb = globalThis.__swarmDb;
    return cachedDb;
  }
  cachedDb = drizzle(getSql());
  globalThis.__swarmDb = cachedDb;
  return cachedDb;
}
