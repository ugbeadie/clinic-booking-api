import { pool } from "./db.js";

/**
 * The whole schema, idempotent, so it is safe to run on every deploy.
 * It grows as the levels do.
 */
const SCHEMA = `
-- Why timestamptz(3) and not plain timestamptz: (3) means "to the
-- millisecond". Postgres would otherwise store microseconds, and a JavaScript
-- Date cannot hold them - so a timestamp that goes out as JSON and comes back
-- as a pagination cursor would be slightly *earlier* than the row it came
-- from, and that row would be served again on the next page. Storing only what
-- a JSON timestamp can carry makes that impossible rather than careful.
CREATE TABLE IF NOT EXISTS slots (
  id        text           PRIMARY KEY,
  provider  text           NOT NULL,
  start_at  timestamptz(3) NOT NULL,
  end_at    timestamptz(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id         text           PRIMARY KEY,
  slot_id    text           NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       text           NOT NULL,
  email      text           NOT NULL,
  status     text           NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS cannot change a table that already exists, so
-- these bring a database created before the line above into line. Re-running
-- them does nothing. (This is the limit of a create-only migration script,
-- noted in docs/DESIGN.md - the first time it actually bit.)
ALTER TABLE slots    ALTER COLUMN start_at   TYPE timestamptz(3);
ALTER TABLE slots    ALTER COLUMN end_at     TYPE timestamptz(3);
ALTER TABLE bookings ALTER COLUMN created_at TYPE timestamptz(3);

-- The most important line in the project (level 3), created now because it is
-- cheap and awkward to retrofit.
--
-- "No two rows may share a slot_id - but only count rows that are confirmed."
--
-- Two things fall out of it. Postgres refuses the second simultaneous insert
-- for a slot, so two people can never book it at the same moment; the route
-- turns that error into a 409. And because the index is PARTIAL, a cancelled
-- booking drops out of it and the slot becomes bookable again, which is exactly
-- what cancelling has to do.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

-- Level 4: "this person's bookings, oldest first", which is also the order the
-- pagination cursor walks.
CREATE INDEX IF NOT EXISTS bookings_by_email
  ON bookings (email, created_at, id);

-- Level 4: one row per Idempotency-Key we have seen.
--
-- request_hash is a fingerprint of the request body, so the same key sent with
-- a different body can be told apart and refused. status_code and
-- response_body are null while the first request holding this key is still
-- working, and hold its answer once it finishes - that answer is what every
-- retry gets back.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text        PRIMARY KEY,
  request_hash  text        NOT NULL,
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
`;

async function main() {
  await pool.query(SCHEMA);
  console.log("schema up to date");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
