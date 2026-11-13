import { Router } from "express";
import { pool } from "../db.js";
import { fail } from "../errors.js";

export const resetRouter = Router();

/**
 * Level 1 - replace all slots and delete every booking.
 * Past slots are allowed, so nothing here looks at the clock.
 */
resetRouter.post("/reset", async (req, res) => {
  const slots: unknown = req.body?.slots;
  if (!Array.isArray(slots)) throw fail(400, "slots must be an array");

  // The spec does not ask for this, but an unparseable timestamp reaching
  // Postgres would be a 500 with the wrong body shape.
  for (const s of slots) {
    if (!s?.id || !s?.provider) throw fail(400, "every slot needs an id and a provider");
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      throw fail(400, "every slot needs ISO-8601 start and end times");
    }
  }

  const client = await pool.connect();
  try {
    // One transaction, so a client that resets and immediately lists slots can
    // never catch the gap between the delete and the insert.
    await client.query("BEGIN");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");
    for (const s of slots) {
      // ON CONFLICT so a repeated id in one payload is "last one wins" rather
      // than a primary-key error halfway through.
      await client.query(
        `INSERT INTO slots (id, provider, start_at, end_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
            SET provider = $2, start_at = $3, end_at = $4`,
        [String(s.id).trim(), String(s.provider).trim(), s.start, s.end],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true, slots: slots.length });
});
