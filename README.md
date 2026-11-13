# Clinic booking API

Koya Cohort 4 assessment, Task 1. An API for booking clinic appointment slots, plus a
web page that uses it. All five levels are implemented.

Built against the contract at https://koyaacademy.com/assessment-api — the page renders
client-side, so the machine-readable version it loads is vendored here as
[docs/spec.openapi.json](docs/spec.openapi.json) and the build targets that fixed copy.

| | |
|---|---|
| **API** | https://clinic-booking-api-j42d.onrender.com |
| **Web page** | https://web-delta-rosy-80.vercel.app |

Requests need an `X-API-Key` header (the key is submitted separately, not in this repo).

## Stack

- **API** — Node 22, TypeScript, Express 5, PostgreSQL 18 on Neon. Hosted on Render.
- **Web** — React, TypeScript, Vite. Hosted on Vercel.

No ORM: the central requirement of level 3 is a partial unique index, which Prisma
cannot express in its schema, so the SQL is written directly. See
[docs/DESIGN.md](docs/DESIGN.md) for that and the other decisions.

## The five levels

| Level | Requirement | Implementation |
|---|---|---|
| 1 | List slots, book one, look up a booking | [routes/slots.ts](api/src/routes/slots.ts), [routes/bookings.ts](api/src/routes/bookings.ts), [routes/reset.ts](api/src/routes/reset.ts) |
| 2 | API key, reject invalid details | [auth.ts](api/src/auth.ts), `readBooking` in [routes/bookings.ts](api/src/routes/bookings.ts) |
| 3 | Never double-book, even simultaneously; cancel | partial unique index in [migrate.ts](api/src/migrate.ts) |
| 4 | Retries never duplicate; page through bookings | `Idempotency-Key` handling and the keyset cursor in [routes/bookings.ts](api/src/routes/bookings.ts) |
| 5 | Stop booking spam | `enforceRateLimit` in [routes/bookings.ts](api/src/routes/bookings.ts) |

Three things worth looking at:

- **Level 3 is enforced by the database, not by application code.** There is no
  "is this slot available?" check anywhere — that check is precisely what fails when
  two requests arrive together, since both read "available" before either writes.
  Instead a partial unique index, `UNIQUE (slot_id) WHERE status = 'confirmed'`, makes
  Postgres refuse the second insert, and error `23505` becomes a 409. Because the index
  is partial, a cancelled booking falls out of it and the slot frees itself, which is
  what level 3's cancel requires.
- **Every error response is built in one place**, the error handler in
  [app.ts](api/src/app.ts), so the spec's `{"error": "..."}` shape has no exceptions —
  including unknown routes and malformed JSON, where Express would otherwise return
  HTML.
- **Middleware order carries real weight.** The CORS preflight is answered above the
  API-key check, because a browser preflight never carries custom headers; if auth
  answered it with a 401 the web page would break while `curl` still worked perfectly.

## Running it locally

Needs Node 22 and a PostgreSQL connection string.

```bash
cd api
cp .env.example .env     # fill in DATABASE_URL and choose an API_KEY
npm install
npm run migrate          # creates the schema; safe to re-run
npm run dev              # http://localhost:3000
```

```bash
cd web
cp .env.example .env.local   # point VITE_API_BASE_URL at the API, same VITE_API_KEY
npm install
npm run dev                  # http://localhost:5173
```

## Tests

`api/src/test/conformance.ts` asserts the spec's rules over HTTP against a base URL, so
the same suite runs against localhost and against the deployment — which is where
pooling, cold starts, TLS and CORS actually differ.

```bash
cd api
npm run conform                                             # localhost
BASE_URL=https://clinic-booking-api-j42d.onrender.com npm run conform
```

79 checks, including the two that only appear under load: 20 simultaneous bookings of
one slot expecting exactly one 201 and nineteen 409s, and 10 simultaneous cancels
expecting exactly one 200.

`npm run coverage` is a second, smaller check that reads `docs/spec.openapi.json`,
extracts every documented status code and every required response field, and makes a
real request to produce each one — so coverage is derived from the spec rather than
from a hand-written list.

## Notes

- **The API key is visible in the web page's JavaScript.** Unavoidable for a static
  page calling a key-protected API directly, and the assessment asks for the key. In
  production the page would call a small server that holds the key instead.
- **The API is on Render's free tier**, which spins down when idle, so an external
  uptime check pings `/health` every 10 minutes. `/health` sits above the API-key
  middleware for that reason, and queries the database rather than just reporting that
  the process is alive.
- `POST /reset` returns `{"ok": true, "slots": n}`. The spec specifies no body for it.
