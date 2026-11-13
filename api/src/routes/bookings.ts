import { randomUUID } from "node:crypto";
import { Router } from "express";
import { isUniqueViolation, pool } from "../db.js";
import { fail } from "../errors.js";
import { toBooking, type BookingRow } from "../serialize.js";

export const bookingsRouter = Router();

/**
 * Book a slot. Level 1 is the happy path: 201 with the booking, confirmed.
 *
 * Two later-level responses are already here, because the alternative was a
 * 500: the foreign key raises an error for a slot that does not exist (404,
 * level 2) and the unique index raises one for a slot already taken (409,
 * level 3). Validation, idempotency and rate limiting arrive at their levels -
 * the order they slot into is in docs/DESIGN.md §3.
 */
bookingsRouter.post("/bookings", async (req, res) => {
  const { slot_id, name, email } = req.body ?? {};

  const slot = await pool.query("SELECT id FROM slots WHERE id = $1", [slot_id ?? ""]);
  if (slot.rowCount === 0) throw fail(404, "slot not found");

  try {
    const { rows } = await pool.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING *`,
      [randomUUID(), slot_id, name ?? "", email ?? ""],
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
