import { randomUUID } from "node:crypto";
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
 * Book a slot.
 *
 * Levels 1 and 2. Idempotency and rate limiting arrive at levels 4 and 5; the
 * order they slot into is in docs/DESIGN.md §3.
 */
bookingsRouter.post("/bookings", async (req, res) => {
  const { slotId, name, email } = readBooking(req.body);

  // One query answers both questions. `now()` is the database's clock, so the
  // answer does not depend on this server's clock being right.
  const slot = await pool.query<{ started: boolean }>(
    "SELECT start_at <= now() AS started FROM slots WHERE id = $1",
    [slotId],
  );
  if (slot.rowCount === 0) throw fail(404, "slot not found");
  if (slot.rows[0]!.started) throw fail(400, "slot has already started");

  try {
    const { rows } = await pool.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING *`,
      [randomUUID(), slotId, name, email],
    );
    res.status(201).json(toBooking(rows[0]!));
  } catch (err) {
    // Notice there is no "is this slot available?" check anywhere above. That
    // check is exactly what breaks when two requests arrive together - both
    // would read "available" before either writes. So we attempt the insert and
    // let the database arbitrate; it owns the rule, not this code.
    if (isUniqueViolation(err, "bookings_one_confirmed_per_slot")) {
      throw fail(409, "slot already booked");
    }
    throw err;
  }
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
