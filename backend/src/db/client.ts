import postgres from "postgres";

declare global {
  // eslint-disable-next-line no-var
  var __swarmSql: ReturnType<typeof postgres> | undefined;
}

let cachedSql: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (cachedSql) return cachedSql;
  if (globalThis.__swarmSql) {
    cachedSql = globalThis.__swarmSql;
    return cachedSql;
  }

  const databaseUrl =
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_PRISMA_URL;
  if (!databaseUrl) {
    throw new Error(
      "Missing database connection string (set DATABASE_URL or POSTGRES_URL)"
    );
  }

  cachedSql = postgres(databaseUrl, {
    // Keep pool conservative in local dev; hot-reload can otherwise fan out clients quickly.
    max: Number(process.env.DB_POOL_MAX ?? 4),
    idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SEC ?? 10),
    max_lifetime: Number(process.env.DB_MAX_LIFETIME_SEC ?? 60 * 10),
    connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_SEC ?? 10),
  });
  globalThis.__swarmSql = cachedSql;
  return cachedSql;
}
