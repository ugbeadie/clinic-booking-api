import { Pool } from "pg";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy api/.env.example to api/.env and fill it in.");
}

/**
 * One pool for the whole process. Neon's pooled endpoint (-pooler) sits in front
 * of this, so we keep our own max low: we are multiplexed on their side already.
 */
/**
 * TLS is left to the connection string's `sslmode=require`, which `pg` now
 * treats as verify-full. The scaffold had `ssl: { rejectUnauthorized: false }`
 * here — the usual copy-paste fix for Postgres TLS errors, and it turns off
 * certificate verification altogether, so the encrypted connection no longer
 * proves anything about who is on the other end. Neon presents a certificate
 * from a public CA, so there was nothing to work around: verified.
 */
export const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/** Postgres unique-violation. We translate this into 409 / idempotency replays. */
export const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== UNIQUE_VIOLATION) return false;
  return constraint ? e.constraint === constraint : true;
}
