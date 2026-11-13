# Design notes — Clinic Booking API

Contract: `docs/spec.openapi.json` (vendored from https://koyaacademy.com/assessment-api/openapi.json
on 2026-11-13, so the build targets a fixed, machine-readable version of the spec).

Audience: whoever reviews this repo. It records *why* the code looks the way it does,
especially the places where the spec leaves a choice open.

---

## 1. The contract, condensed

Global: everything is JSON. Every error body is exactly `{"error": "<message>"}`.
Every request needs `X-API-Key`; missing or wrong → **401**. Auth is declared at the
root of the spec, so it applies to `/reset` too.

| Endpoint | Level | Behaviour |
|---|---|---|
| `POST /reset` | 1 | Delete every booking, replace all slots with the ones sent. Past slots allowed. 200. |
| `GET /slots` | 1 | Every slot, earliest `start` first. `?provider=` exact match. Each slot carries `available` (false while it has a *confirmed* booking). |
| `POST /bookings` | 1–5 | See §3. |
| `GET /bookings?email=` | 4 | That person's bookings, oldest first, email match case-insensitive. Cursor pagination, `limit` 1–50 default 10, anything else 400. Last page has `next_cursor: null`. |
| `GET /bookings/{id}` | 1 | 200 the booking, 404 if unknown. |
| `DELETE /bookings/{id}` | 3 | `status` → `cancelled`, frees the slot. 404 unknown, 409 already cancelled. |

Shapes:
- `Slot` = `{id, provider, start, end}` — `id` is **client-supplied** (`"s1"`), not generated.
- `Booking` = `{id, slot_id, name, email, status, created_at}`, status `confirmed|cancelled`.

## 2. Non-obvious things in the spec

Listed because each one is a place a plausible implementation gets it wrong.

1. **Slot ids come from the client.** `/reset` sends `"s1"`. So `slots.id` is a `text`
   primary key. A generated uuid would break every subsequent call.
2. **`/reset` needs the API key** — auth is global in the spec. Easy to leave open
   because it reads like a test fixture.
3. **`available` is only about confirmed bookings.** A slot in the past with no
   booking is still `available: true`, and `GET /slots` returns past slots too — the
   spec never says to filter them. Don't be clever here.
4. **Cancelling frees the slot**, so "one booking per slot" is really "one *confirmed*
   booking per slot" — the constraint has to be partial. See §4.
5. **Failed attempts count toward the rate limit** (level 5), so a run of 404s or 409s
   must still burn the budget. That forces the rate-limit check *before* the slot
   lookup, not after.
6. **Malformed JSON** must come back as `{"error": ...}`. Express's default body-parser
   error is an HTML 400 — it has to be caught.
7. **Unknown routes and unhandled crashes** must also return `{"error": ...}`, not
   Express's HTML 404/500 pages.
8. **CORS preflight must skip auth.** The browser's `OPTIONS` request never carries
   `X-API-Key`; if the auth middleware answers it with 401, the whole web page dies
   while the API still looks fine from curl.
9. **`created_at` must be ISO-8601 with `Z`.** `pg` hands back a JS `Date`; serialise
   it explicitly rather than relying on whatever the JSON layer happens to do.
10. **"Already started" needs one clock.** Compare against the database's `now()`, not
    the Node process's, so the answer does not depend on host clock drift.

## 3. `POST /bookings` — the pipeline, and why in this order

The spec attaches five status codes to one endpoint across four levels. The order they
are checked in is not stated, and it is the most consequential decision here.

```
1.  CORS preflight            → answered, no auth
2.  X-API-Key                 → 401
3.  JSON parse                → 400
4.  email present + valid     → 400
5.  rate limit on that email  → 429 + Retry-After
6.  Idempotency-Key gate      → 422 (same key, different body) | replay stored response
7.  slot_id / name present    → 400
8.  slot exists               → 404
9.  slot.start <= now()       → 400
10. insert                    → 409 if the slot already has a confirmed booking
11. store the response under the idempotency key, commit
```

Reasoning for the contested positions:

- **Rate limit (5) before the slot checks (8–10):** level 5 says failed attempts count.
  A client firing six requests at a nonexistent slot must see 404 ×5 then 429. If the
  limit were checked last, those 404s would never be counted.
- **Rate limit (5) before idempotency (6):** a genuine trade-off. Putting it first
  means a request retried more than five times with the same `Idempotency-Key` gets a
  429 instead of its stored reply, in slight tension with "the same key returns the
  same response". Putting idempotency first would let a client bypass the limit by
  reusing one key. Level 5's rule is written without exceptions, so it wins; real
  retries number two or three, not six.
- **Email validated before the things that depend on it:** the rate limit is keyed on
  email, so there is no counter to charge until the email is known. A request with no
  usable email is a 400 and is not counted — there is nothing to count it against.
- **A rejected (429) request is not itself recorded as an attempt.** Otherwise the
  window would keep extending itself and a blocked client could never recover.

`Retry-After` = seconds until the oldest attempt in the window ages out, rounded up,
floor of 1.

## 4. Concurrency (level 3) — how "never the same slot twice" is actually enforced

Application-level check-then-insert cannot hold this: two requests both read
"available" before either writes. Two real options:

- `SELECT ... FOR UPDATE` on the slot row, then insert. Works, but the correctness
  lives in remembering to take the lock on every path.
- **A partial unique index** — chosen:
  ```sql
  CREATE UNIQUE INDEX bookings_one_confirmed_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed';
  ```
  The database refuses the second concurrent insert; we catch Postgres error `23505`
  and translate it to **409**. The guarantee is structural — no code path can forget
  it — and because the index is partial, cancelled rows fall out of it and the slot
  becomes bookable again, which is exactly what level 3's cancel requires.

Cancel is a conditional update, `... WHERE status = 'confirmed' RETURNING *`. Nothing
returned means either no such booking (404) or it was already cancelled (409), told
apart in the same statement rather than with a racy read-then-write.

## 5. Idempotency (level 4)

Table `idempotency_keys(key PK, request_hash, status_code, response_body, created_at)`,
where `request_hash` is a SHA-256 of the canonicalised request body.

The key row is inserted **in the same transaction as the booking**. That makes
concurrent retries serialise for free: the second request's insert blocks on the unique
index until the first transaction commits, then conflicts, reads the committed row and
replays it. Same key + different hash → 422.

Outcomes other than 201 (404, 409, the "already started" 400) are stored too, so a
retry returns the same status code rather than re-deciding.

## 6. Pagination (level 4)

`ORDER BY created_at, id` — **not** `created_at` alone. Two bookings created in the
same millisecond would otherwise be unordered between pages, and a row could be
skipped or repeated. The cursor is a base64 encoding of that `(created_at, id)` pair,
compared as a tuple:

```sql
WHERE email = $1 AND (created_at, id) > ($2, $3)
ORDER BY created_at, id
LIMIT $4
```

`limit` outside 1–50, or not an integer → 400. A malformed cursor → 400 (the spec does
not say; 400 is the only sane reading). Email is stored already lowercased, so the
case-insensitive match is a plain index lookup rather than `lower(email)` over every row.

## 7. Rate limiting (level 5)

A `booking_attempts(email, created_at)` table, sliding 60-second window, not an
in-memory counter — the host can restart or run more than one instance, and the task
says state must survive. Rows older than the window are cleaned up opportunistically.

## 8. Schema

```sql
slots    (id text PK, provider text, start_at timestamptz, end_at timestamptz)
bookings (id text PK, slot_id text REFERENCES slots(id) ON DELETE CASCADE,
          name text, email text, status text CHECK (status IN ('confirmed','cancelled')),
          created_at timestamptz DEFAULT now())
         UNIQUE INDEX (slot_id) WHERE status = 'confirmed'
         INDEX (email, created_at, id)
idempotency_keys (key text PK, request_hash text, status_code int, response_body jsonb, created_at)
booking_attempts (id bigserial PK, email text, created_at timestamptz)  INDEX (email, created_at)
```

The `ON DELETE CASCADE` is what makes `/reset` a two-statement operation.

## 9. Judgment calls the spec does not cover

| Question | Decision | Why |
|---|---|---|
| Does `/reset` clear rate-limit counters and idempotency keys? | Yes | It is a fixture reset. If attempt rows survived it, an earlier test group's requests would poison the level-5 check. |
| Does `GET /bookings` include cancelled bookings? | Yes | It says "that person's bookings", unqualified. |
| Garbage `cursor` | 400 | Unspecified; the alternative is silently returning page one. |
| Missing `email` on `GET /bookings` | 400 | Declared required. |
| Idempotency key scope | Global | The spec ties the key to the body, not the caller; the body hash does the disambiguating. |

## 10. Deployment

- API: Node + TypeScript + Express 5 as a **Render web service** — a long-running
  process, so the `pg` pool is shared and real. Postgres on Neon, pooled `-pooler`
  endpoint, which is what a small pool should sit behind.
- Web: React + TypeScript + Vite, static.
- Two risks, both about things going to sleep: Render's free tier spins the service
  down after ~15 minutes idle, giving a ~50s cold start on the next request, and Neon
  auto-suspends an idle compute. The task says to keep the deployment running and
  untouched after submission, so an automated checker may well arrive cold.
  Mitigations, both needed:
  - A `GET /health` endpoint that touches the database, pinged every ~10 minutes by an
    external uptime service, keeping both Render and the Neon compute warm.
  - Startup must not depend on a live database connection: the process has to bind its
    port and start answering even if the first query is slow, so a cold Neon compute
    delays one request instead of failing the boot.
- The API key will be visible in the browser bundle — unavoidable when a static page
  calls a key-protected API directly, and the task asks for the key. In a real
  deployment the page would call a server-side proxy that holds the key.

## 11. Verifying it

A conformance script (`api/src/test/conformance.ts`) runs the spec's own rules against a
base URL: every status code above, plus the two that only appear under load — ~20
simultaneous bookings of one slot expecting exactly one 201 and the rest 409, and a
repeated `Idempotency-Key` expecting one booking and identical responses. It runs
against localhost *and* against the deployed URL, because "works locally" and "works on
the host" differ in exactly the places that matter: pooling, cold starts, TLS, CORS.
