# Clinic Booking API

Koya Cohort 4 assessment, Task 1. Implements the contract at
https://koyaacademy.com/assessment-api (OpenAPI: /assessment-api/openapi.json).

- `api/` - Node + TypeScript + Postgres. The booking API, levels 1-5.
- `web/` - React + TypeScript + Vite. Page to view slots, book one, see confirmation.

## Levels

| Level | Feature | Where |
|---|---|---|
| 1 | List slots, book, look up a booking, `/reset` | |
| 2 | `X-API-Key` auth, field validation | |
| 3 | No double-booking under concurrency, cancel | |
| 4 | Idempotency-Key, cursor pagination | |
| 5 | Rate limit: 5 attempts per email per minute | |
