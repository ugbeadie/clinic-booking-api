/** Database rows in, the JSON shapes the spec asks for out. */

export type SlotRow = {
  id: string;
  provider: string;
  start_at: Date;
  end_at: Date;
  available: boolean;
};

export type BookingRow = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: string;
  created_at: Date;
};

/**
 * ISO-8601 in UTC. `toISOString()` always adds milliseconds, so a slot sent to
 * us as "2026-12-10T09:00:00Z" would come back as "2026-12-10T09:00:00.000Z" -
 * valid, and still a different string. Dropping a ".000" means what you send is
 * what you get back.
 */
export function isoZ(d: Date): string {
  return d.toISOString().replace(/\.000Z$/, "Z");
}

export function toSlot(row: SlotRow) {
  return {
    id: row.id,
    provider: row.provider,
    start: isoZ(row.start_at),
    end: isoZ(row.end_at),
    available: row.available,
  };
}

export function toBooking(row: BookingRow) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: isoZ(row.created_at),
  };
}
