import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { isUniqueViolation, pool } from "../db.js";
import { fail } from "../errors.js";
import { toBooking, type BookingRow } from "../serialize.js";

export const bookingsRouter = Router();

// "something@something.something", with no spaces. Not the full RFC - that is a
// famously unreadable regex - but it rejects everything a real typo looks like.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Level 2 - reject bookings with missing or invalid details, and clean up the
 * ones we accept: spaces trimmed, email stored lower case.
 */
function readBooking(body: any) {
  const slotId = typeof body?.slot_id === "string" ? body.slot_id.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!slotId) throw fail(400, "slot_id is required");
  if (!name) throw fail(400, "name is required");
  if (!email) throw fail(400, "email is required");
  if (!EMAIL.test(email)) throw fail(400, "email is not valid");

  return { slotId, name, email };
}

/**
 * What a booking attempt came to: a status code and a JSON body.
 *
 * `book` returns one of these instead of throwing, because level 4 has to be
 * able to save whatever happened under an Idempotency-Key and hand the same
 * answer back to a retry.
 */
type Outcome = { status: number; body: unknown };

/** Levels 1-3: make the booking, or report why not. */
async function book(slotId: string, name: string, email: string): Promise<Outcome> {
  // One query answers both questions. `now()` is the database's clock, so the
  // answer does not depend on this server's clock being right.
  const slot = await pool.query<{ started: boolean }>(
    "SELECT start_at <= now() AS started FROM slots WHERE id = $1",
    [slotId],
  );
  if (slot.rowCount === 0) return { status: 404, body: { error: "slot not found" } };
  if (slot.rows[0]!.started) return { status: 400, body: { error: "slot has already started" } };

  try {
    const { rows } = await pool.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING *`,
      [randomUUID(), slotId, name, email],
    );
    return { status: 201, body: toBooking(rows[0]!) };
  } catch (err) {
    // Notice there is no "is this slot available?" check anywhere above. That
    // check is exactly what breaks when two requests arrive together - both
    // would read "available" before either writes. So we attempt the insert and
    // let the database arbitrate; it owns the rule, not this code.
    if (isUniqueViolation(err, "bookings_one_confirmed_per_slot")) {
      return { status: 409, body: { error: "slot already booked" } };
    }
    throw err;
  }
}

// --- Level 4: a retried request never creates a second booking --------------

/**
 * A fingerprint of the request. Built from the cleaned-up fields rather than
 * the raw JSON text, so the same request with its keys in a different order, or
 * with stray spaces, is recognised as the same request instead of being
 * refused as a different one.
 */
const fingerprint = (slotId: string, name: string, email: string) =>
  createHash("sha256").update(JSON.stringify([slotId, name, email])).digest("hex");

type KeyRow = { request_hash: string; status_code: number | null; response_body: unknown };

const readKey = async (key: string) =>
  (
    await pool.query<KeyRow>(
      "SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1",
      [key],
    )
  ).rows[0];

/**
 * Claim the key. Returns true if it is now ours to work on, false if someone
 * got there first - the primary key makes that decision, so two requests
 * arriving together cannot both claim it.
 */
async function claimKey(key: string, hash: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [key, hash],
  );
  return rowCount === 1;
}

/** The answer already stored under this key - waiting for it if need be. */
async function storedAnswer(key: string, hash: string): Promise<Outcome> {
  // Up to two seconds, because the request that claimed this key may still be
  // working on it. Normally the answer is already there on the first look.
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await readKey(key);
    if (!row) break;
    if (row.request_hash !== hash) {
      throw fail(422, "this Idempotency-Key was already used with a different body");
    }
    if (row.status_code !== null) {
      return { status: row.status_code, body: row.response_body };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw fail(409, "a request with this Idempotency-Key is still in progress");
}

// --- Level 5: stop anyone from spamming bookings ---------------------------

const MAX_ATTEMPTS = 5;

/**
 * Count this email's attempts in the last minute and record this one, in a
 * single statement. One statement rather than a count followed by an insert,
 * so there is no gap between deciding and recording for a flood of requests to
 * slip through.
 *
 * Nothing is inserted when the limit is already reached. If a refused attempt
 * were recorded it would push the caller's own window forward, and they could
 * never get out of it.
 */
const RECORD_ATTEMPT_SQL = `
  INSERT INTO booking_attempts (email)
  SELECT $1::text
   WHERE (SELECT count(*) FROM booking_attempts
           WHERE email = $1 AND created_at > now() - interval '60 seconds') < $2
  RETURNING id
`;

/** How long until the oldest attempt in the window ages out, in whole seconds. */
const RETRY_AFTER_SQL = `
  SELECT greatest(1, ceil(extract(epoch from
           (min(created_at) + interval '60 seconds' - now()))))::int AS seconds
    FROM booking_attempts
   WHERE email = $1 AND created_at > now() - interval '60 seconds'
`;

async function enforceRateLimit(email: string) {
  const { rowCount } = await pool.query(RECORD_ATTEMPT_SQL, [email, MAX_ATTEMPTS]);
  if (rowCount === 1) return; // under the limit, and now counted

  const { rows } = await pool.query<{ seconds: number }>(RETRY_AFTER_SQL, [email]);
  throw fail(429, "too many booking attempts for this email", {
    "Retry-After": String(rows[0]?.seconds ?? 1),
  });
}

// --- the whole POST /bookings pipeline -------------------------------------

/**
 * Levels 1-5 in the order they are checked. docs/DESIGN.md §3 explains why this
 * order, and the one place it was reversed after building it.
 */
async function attemptBooking(
  key: string | null,
  slotId: string,
  name: string,
  email: string,
): Promise<Outcome> {
  const hash = key ? fingerprint(slotId, name, email) : null;

  // A request we have already answered is not a new attempt: replaying a
  // stored answer creates nothing, so it costs none of this email's budget.
  // It also cannot be abused - the same key with a different body is refused,
  // so one key can only ever produce one booking.
  if (key && hash && (await readKey(key))) {
    return storedAnswer(key, hash);
  }

  await enforceRateLimit(email);

  if (!key || !hash) return book(slotId, name, email);

  // Someone claimed this key in the moment since we looked: use their answer.
  if (!(await claimKey(key, hash))) return storedAnswer(key, hash);

  const outcome = await book(slotId, name, email);
  await pool.query(
    "UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1",
    [key, outcome.status, JSON.stringify(outcome.body)],
  );
  return outcome;
}

bookingsRouter.post("/bookings", async (req, res) => {
  const { slotId, name, email } = readBooking(req.body);
  const key = req.header("Idempotency-Key")?.trim() || null;

  const outcome = await attemptBooking(key, slotId, name, email);
  res.status(outcome.status).json(outcome.body);
});

// --- Level 4: paging through one person's bookings --------------------------

function readLimit(raw: unknown): number {
  if (raw === undefined) return 10;
  // Only digits: this rejects "abc", "1.5", "-1" and "" as well as 0 and 51.
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw fail(400, "limit must be a whole number from 1 to 50");
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 50) throw fail(400, "limit must be a whole number from 1 to 50");
  return limit;
}

/**
 * The cursor is just "where the last page stopped": a timestamp and an id,
 * base64'd so it survives a URL. Both halves are needed - see the query below.
 */
const encodeCursor = (row: BookingRow) =>
  Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString("base64url");

function readCursor(raw: unknown): { at: string; id: string } | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw === "") throw fail(400, "invalid cursor");
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!at || !id || Number.isNaN(Date.parse(at))) throw fail(400, "invalid cursor");
  return { at, id };
}

/**
 * Level 4 - this person's bookings, oldest first, a page at a time.
 *
 * `(created_at, id) > ($2, $3)` compares the pair, not just the timestamp. Two
 * bookings made in the same instant would otherwise be in no particular order
 * between pages, and one of them could be skipped or sent twice. Ordering by
 * the same pair the cursor seeks on is what makes the paging stable.
 */
const PAGE_SQL = `
  SELECT * FROM bookings
   WHERE email = $1
     AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
   ORDER BY created_at, id
   LIMIT $4
`;

bookingsRouter.get("/bookings", async (req, res) => {
  // Emails are stored lower case, so matching case-insensitively is just a
  // matter of lowering the query too - no scan over every row.
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!email) throw fail(400, "email is required");

  const limit = readLimit(req.query.limit);
  const after = readCursor(req.query.cursor);

  // Ask for one more row than the page needs: if it comes back, there is
  // another page, and we can say so without guessing.
  const { rows } = await pool.query<BookingRow>(PAGE_SQL, [
    email,
    after?.at ?? null,
    after?.id ?? null,
    limit + 1,
  ]);

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];

  res.json({
    bookings: page.map(toBooking),
    next_cursor: hasMore && last ? encodeCursor(last) : null,
  });
});

/** Level 1 - look up a booking. A cancelled booking is returned as itself. */
bookingsRouter.get("/bookings/:id", async (req, res) => {
  const { rows } = await pool.query<BookingRow>("SELECT * FROM bookings WHERE id = $1", [
    req.params.id,
  ]);
  const booking = rows[0];
  if (!booking) throw fail(404, "booking not found");
  res.json(toBooking(booking));
});

/**
 * Level 3 - cancel a booking, which frees the slot.
 *
 * The `AND status = 'confirmed'` is what makes this safe: the database finds the
 * row and changes it in one step, so two simultaneous cancels cannot both
 * succeed. Reading the booking first and then updating it would let both see
 * "confirmed" before either wrote.
 *
 * Nothing frees the slot explicitly. The slot was never marked as taken - it
 * looked taken because a confirmed booking pointed at it, and the partial
 * unique index only covers confirmed rows, so this one update does both jobs.
 */
bookingsRouter.delete("/bookings/:id", async (req, res) => {
  const { rows } = await pool.query<BookingRow>(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed'
      RETURNING *`,
    [req.params.id],
  );

  if (rows[0]) {
    res.json(toBooking(rows[0]));
    return;
  }

  // Nothing was updated. Either there is no such booking, or it was already
  // cancelled - and the spec wants different codes for those.
  const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
  if (exists.rowCount === 0) throw fail(404, "booking not found");
  throw fail(409, "booking is already cancelled");
});
