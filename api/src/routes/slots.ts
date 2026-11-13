import { Router } from "express";
import { pool } from "../db.js";
import { toSlot, type SlotRow } from "../serialize.js";

export const slotsRouter = Router();

/**
 * Level 1 - every slot, earliest start first.
 *
 * `available` is false only while a slot has a CONFIRMED booking, and the
 * database answers that in the same query. Two things the spec implies that are
 * easy to get wrong by being helpful: past slots are still listed, and a past
 * slot with no booking is still available. Neither is filtered out.
 */
const LIST_SQL = `
  SELECT s.id,
         s.provider,
         s.start_at,
         s.end_at,
         NOT EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.slot_id = s.id AND b.status = 'confirmed'
         ) AS available
    FROM slots s
   WHERE $1::text IS NULL OR s.provider = $1
   ORDER BY s.start_at, s.id
`;

slotsRouter.get("/slots", async (req, res) => {
  const raw = req.query.provider;
  // Exact match when asked for. An empty ?provider= means "no filter" rather
  // than "find the provider called empty string".
  const provider = typeof raw === "string" && raw.length > 0 ? raw : null;

  const { rows } = await pool.query<SlotRow>(LIST_SQL, [provider]);
  res.json({ slots: rows.map(toSlot) });
});
