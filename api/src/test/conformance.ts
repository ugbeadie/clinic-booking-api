/**
 * Conformance checks, run against a base URL rather than against the code:
 *
 *   npm run conform                                  # localhost:3000
 *   BASE_URL=https://... API_KEY=... npm run conform  # the deployed API
 *
 * The point of testing over HTTP is that "works locally" and "works on the host"
 * differ in exactly the places that matter here - pooling, cold starts, TLS,
 * CORS - and those differences are invisible to a unit test.
 *
 * Destructive: it calls /reset.
 */
import "dotenv/config";

const BASE = (
  process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`
).replace(/\/+$/, "");
const KEY = process.env.API_KEY ?? "";

type Response_ = { status: number; body: any; headers: Headers; text: string };

async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
    /** A different key, or null to send no key header at all. */
    key?: string | null;
  } = {},
): Promise<Response_> {
  const key = opts.key === undefined ? KEY : opts.key;
  const headers: Record<string, string> = { ...opts.headers };
  if (key !== null) headers["X-API-Key"] = key;
  let body: string | undefined;

  if (opts.raw !== undefined) {
    body = opts.raw;
    headers["Content-Type"] ??= "application/json";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, headers: res.headers, text };
}

// --- tiny assertion kit -----------------------------------------------------

let passed = 0;
const failures: string[] = [];

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function expectStatus(res: Response_, want: number) {
  expect(
    res.status === want,
    `expected ${want}, got ${res.status} — ${res.text.slice(0, 200)}`,
  );
}

/** The spec's one global rule: every error body is {"error": "<message>"}. */
function expectErrorShape(res: Response_) {
  expect(
    res.body !== null && typeof res.body === "object" && typeof res.body.error === "string",
    `expected {"error": string}, got ${res.text.slice(0, 200)}`,
  );
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n          ${(err as Error).message}`);
  }
}

// --- fixture ----------------------------------------------------------------

/** Whole-second ISO, so the echo-exactly check below is meaningful. */
const future = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

const SLOTS = [
  { id: "s1", provider: "Dr Ade", start: future(60), end: future(90) },
  { id: "s2", provider: "Dr Ade", start: future(120), end: future(150) },
  { id: "s3", provider: "Dr Bisi", start: future(30), end: future(60) },
];
// By start: s3 (+30), s1 (+60), s2 (+120).
const EXPECTED_ORDER = ["s3", "s1", "s2"];

// --- level 1 ----------------------------------------------------------------

async function level1() {
  console.log("\nLevel 1 — list slots, book one, look up a booking");

  await check("GET /health reaches the database", async () => {
    const res = await call("GET", "/health");
    expectStatus(res, 200);
    expect(res.body?.ok === true, `expected {ok:true}, got ${res.text.slice(0, 120)}`);
  });

  await check("POST /reset replaces all slots", async () => {
    const res = await call("POST", "/reset", { body: { slots: SLOTS } });
    expectStatus(res, 200);
  });

  await check("GET /slots returns every slot, earliest start first", async () => {
    const res = await call("GET", "/slots");
    expectStatus(res, 200);
    expect(Array.isArray(res.body?.slots), "expected a slots array");
    const ids = res.body.slots.map((s: any) => s.id);
    expect(
      JSON.stringify(ids) === JSON.stringify(EXPECTED_ORDER),
      `expected ${JSON.stringify(EXPECTED_ORDER)}, got ${JSON.stringify(ids)}`,
    );
  });

  await check("slots echo the timestamps they were created with", async () => {
    const res = await call("GET", "/slots");
    const s1 = res.body.slots.find((s: any) => s.id === "s1");
    expect(s1, "s1 missing");
    expect(s1.start === SLOTS[0]!.start, `start: sent ${SLOTS[0]!.start}, got ${s1.start}`);
    expect(s1.end === SLOTS[0]!.end, `end: sent ${SLOTS[0]!.end}, got ${s1.end}`);
  });

  await check("every unbooked slot is available", async () => {
    const res = await call("GET", "/slots");
    for (const s of res.body.slots) {
      expect(s.available === true, `${s.id} should be available, got ${s.available}`);
    }
  });

  await check("GET /slots?provider= filters on an exact match", async () => {
    const res = await call("GET", "/slots?provider=Dr%20Ade");
    expectStatus(res, 200);
    const ids = res.body.slots.map((s: any) => s.id).sort();
    expect(
      JSON.stringify(ids) === JSON.stringify(["s1", "s2"]),
      `expected ["s1","s2"], got ${JSON.stringify(ids)}`,
    );
  });

  await check("GET /slots?provider= with no match is an empty list", async () => {
    const res = await call("GET", "/slots?provider=Nobody");
    expectStatus(res, 200);
    expect(res.body.slots.length === 0, `expected 0 slots, got ${res.body.slots.length}`);
  });

  let bookingId = "";

  await check("POST /bookings returns 201 and a confirmed booking", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" },
    });
    expectStatus(res, 201);
    const b = res.body;
    expect(typeof b?.id === "string" && b.id.length > 0, "booking needs an id");
    expect(b.slot_id === "s1", `slot_id: ${b.slot_id}`);
    expect(b.status === "confirmed", `status: ${b.status}`);
    expect(
      typeof b.created_at === "string" && !Number.isNaN(Date.parse(b.created_at)),
      `created_at not a date-time: ${b.created_at}`,
    );
    expect(/Z$/.test(b.created_at), `created_at should be UTC with Z: ${b.created_at}`);
    bookingId = b.id;
  });

  await check("the booked slot is no longer available", async () => {
    const res = await call("GET", "/slots");
    const s1 = res.body.slots.find((s: any) => s.id === "s1");
    expect(s1.available === false, "s1 should be unavailable");
    const s2 = res.body.slots.find((s: any) => s.id === "s2");
    expect(s2.available === true, "s2 should still be available");
  });

  await check("GET /bookings/{id} returns that booking", async () => {
    const res = await call("GET", `/bookings/${bookingId}`);
    expectStatus(res, 200);
    expect(res.body.id === bookingId, `id: ${res.body.id}`);
    expect(res.body.email === "ada@example.com", `email: ${res.body.email}`);
  });

  await check("GET /bookings/{unknown} is a 404 with the error shape", async () => {
    const res = await call("GET", "/bookings/does-not-exist");
    expectStatus(res, 404);
    expectErrorShape(res);
  });

  await check("POST /bookings for a missing slot is a 404", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "nope", name: "Ada Obi", email: "ada@example.com" },
    });
    expectStatus(res, 404);
    expectErrorShape(res);
  });

  await check("booking a taken slot is a 409 (level 3, free from the index)", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "s1", name: "Bola Eze", email: "bola@example.com" },
    });
    expectStatus(res, 409);
    expectErrorShape(res);
  });

  await check("/reset clears bookings as well as slots", async () => {
    await call("POST", "/reset", { body: { slots: SLOTS } });
    const slots = await call("GET", "/slots");
    for (const s of slots.body.slots) {
      expect(s.available === true, `${s.id} should be available after reset`);
    }
    const gone = await call("GET", `/bookings/${bookingId}`);
    expectStatus(gone, 404);
  });
}

// --- level 2 ----------------------------------------------------------------

/** A slot in the past and one in the future, for the "already started" rule. */
const L2_SLOTS = [
  { id: "past", provider: "Dr Ade", start: future(-120), end: future(-90) },
  { id: "soon", provider: "Dr Ade", start: future(60), end: future(90) },
  { id: "later", provider: "Dr Ade", start: future(180), end: future(210) },
];

async function level2() {
  console.log("\nLevel 2 — the API key, and turning away bad details");

  await check("no API key is a 401", async () => {
    const res = await call("GET", "/slots", { key: null });
    expectStatus(res, 401);
    expectErrorShape(res);
  });

  await check("a wrong API key is a 401", async () => {
    const res = await call("GET", "/slots", { key: "not-the-key" });
    expectStatus(res, 401);
    expectErrorShape(res);
  });

  await check("/reset needs the key too", async () => {
    const res = await call("POST", "/reset", { key: null, body: { slots: [] } });
    expectStatus(res, 401);
  });

  await check("/health works without a key, so a pinger can keep us warm", async () => {
    const res = await call("GET", "/health", { key: null });
    expectStatus(res, 200);
  });

  await check("POST /reset installs the level 2 fixture", async () => {
    const res = await call("POST", "/reset", { body: { slots: L2_SLOTS } });
    expectStatus(res, 200);
  });

  const missing: Array<[string, Record<string, unknown>]> = [
    ["slot_id missing", { name: "Ada Obi", email: "ada@example.com" }],
    ["slot_id empty", { slot_id: "   ", name: "Ada Obi", email: "ada@example.com" }],
    ["name missing", { slot_id: "soon", email: "ada@example.com" }],
    ["name empty", { slot_id: "soon", name: "   ", email: "ada@example.com" }],
    ["email missing", { slot_id: "soon", name: "Ada Obi" }],
    ["email empty", { slot_id: "soon", name: "Ada Obi", email: "  " }],
    ["email has no @", { slot_id: "soon", name: "Ada Obi", email: "not-an-email" }],
    ["email has no domain", { slot_id: "soon", name: "Ada Obi", email: "ada@" }],
    ["email has no dot", { slot_id: "soon", name: "Ada Obi", email: "ada@example" }],
    ["email has a space", { slot_id: "soon", name: "Ada Obi", email: "a b@example.com" }],
    ["name is not a string", { slot_id: "soon", name: 42, email: "ada@example.com" }],
  ];

  for (const [label, body] of missing) {
    await check(`400 when ${label}`, async () => {
      const res = await call("POST", "/bookings", { body });
      expectStatus(res, 400);
      expectErrorShape(res);
    });
  }

  await check("400 when the slot has already started", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "past", name: "Ada Obi", email: "ada@example.com" },
    });
    expectStatus(res, 400);
    expectErrorShape(res);
  });

  await check("404 beats nothing: a valid body for a slot that does not exist", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "nope", name: "Ada Obi", email: "ada@example.com" },
    });
    expectStatus(res, 404);
    expectErrorShape(res);
  });

  await check("name is trimmed and email is stored lower case", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "soon", name: "  Ada Obi  ", email: "  ADA@Example.COM " },
    });
    expectStatus(res, 201);
    expect(res.body.name === "Ada Obi", `name: ${JSON.stringify(res.body.name)}`);
    expect(res.body.email === "ada@example.com", `email: ${JSON.stringify(res.body.email)}`);

    // and it is stored that way, not just echoed that way
    const again = await call("GET", `/bookings/${res.body.id}`);
    expect(again.body.email === "ada@example.com", `stored email: ${again.body.email}`);
  });
}

// --- level 3 ----------------------------------------------------------------

const L3_SLOTS = [
  { id: "c1", provider: "Dr Ade", start: future(60), end: future(90) },
  { id: "c2", provider: "Dr Ade", start: future(120), end: future(150) },
];

async function level3() {
  console.log("\nLevel 3 — one booking per slot under load, and cancelling");

  await check("POST /reset installs the level 3 fixture", async () => {
    expectStatus(await call("POST", "/reset", { body: { slots: L3_SLOTS } }), 200);
  });

  /**
   * The check this whole design exists for. Twenty requests for one slot, all
   * in flight at once - not twenty one after another, which any implementation
   * passes.
   */
  await check("20 simultaneous bookings of one slot: exactly one wins", async () => {
    const attempts = Array.from({ length: 20 }, (_, i) =>
      call("POST", "/bookings", {
        body: { slot_id: "c1", name: `Racer ${i}`, email: `racer${i}@example.com` },
      }),
    );
    const results = await Promise.all(attempts);

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    const other = results.filter((r) => r.status !== 201 && r.status !== 409);

    expect(
      created.length === 1,
      `expected exactly 1 booking, got ${created.length} (409s: ${refused.length})`,
    );
    expect(
      other.length === 0,
      `every other request should be 409, got ${other.map((r) => r.status).join(", ")}`,
    );
  });

  await check("and the database really holds one confirmed booking", async () => {
    const res = await call("GET", "/slots");
    const c1 = res.body.slots.find((s: any) => s.id === "c1");
    expect(c1.available === false, "c1 should be unavailable");
  });

  let bookingId = "";

  await check("a fresh booking can be made on the other slot", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "c2", name: "Ada Obi", email: "ada@example.com" },
    });
    expectStatus(res, 201);
    bookingId = res.body.id;
  });

  await check("DELETE /bookings/{id} returns the cancelled booking", async () => {
    const res = await call("DELETE", `/bookings/${bookingId}`);
    expectStatus(res, 200);
    expect(res.body.status === "cancelled", `status: ${res.body.status}`);
    expect(res.body.id === bookingId, `id: ${res.body.id}`);
  });

  await check("cancelling frees the slot", async () => {
    const res = await call("GET", "/slots");
    const c2 = res.body.slots.find((s: any) => s.id === "c2");
    expect(c2.available === true, "c2 should be available again");
  });

  await check("and the freed slot can be booked again", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "c2", name: "Bola Eze", email: "bola@example.com" },
    });
    expectStatus(res, 201);
  });

  await check("a cancelled booking is still readable, as cancelled", async () => {
    const res = await call("GET", `/bookings/${bookingId}`);
    expectStatus(res, 200);
    expect(res.body.status === "cancelled", `status: ${res.body.status}`);
  });

  await check("cancelling twice is a 409", async () => {
    const res = await call("DELETE", `/bookings/${bookingId}`);
    expectStatus(res, 409);
    expectErrorShape(res);
  });

  await check("cancelling a booking that does not exist is a 404", async () => {
    const res = await call("DELETE", "/bookings/does-not-exist");
    expectStatus(res, 404);
    expectErrorShape(res);
  });

  // The same race, the other way round: cancelling is a conditional update, so
  // only one of ten simultaneous cancels should find the row confirmed.
  await check("10 simultaneous cancels: exactly one succeeds", async () => {
    await call("POST", "/reset", { body: { slots: L3_SLOTS } });
    const made = await call("POST", "/bookings", {
      body: { slot_id: "c1", name: "Ada Obi", email: "ada@example.com" },
    });
    expectStatus(made, 201);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => call("DELETE", `/bookings/${made.body.id}`)),
    );
    const ok = results.filter((r) => r.status === 200);
    const already = results.filter((r) => r.status === 409);

    expect(ok.length === 1, `expected exactly 1 success, got ${ok.length}`);
    expect(already.length === 9, `expected 9 conflicts, got ${already.length}`);
  });
}

// --- level 4 ----------------------------------------------------------------

const L4_SLOTS = Array.from({ length: 6 }, (_, i) => ({
  id: `k${i + 1}`,
  provider: "Dr Ade",
  start: future(60 * (i + 1)),
  end: future(60 * (i + 1) + 30),
}));

async function level4() {
  console.log("\nLevel 4 — retries never duplicate, and paging through bookings");

  await check("POST /reset installs the level 4 fixture", async () => {
    expectStatus(await call("POST", "/reset", { body: { slots: L4_SLOTS } }), 200);
  });

  const body = { slot_id: "k1", name: "Ada Obi", email: "ada@example.com" };
  let firstId = "";

  await check("a booking with an Idempotency-Key is created normally", async () => {
    const res = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": "key-1" } });
    expectStatus(res, 201);
    firstId = res.body.id;
  });

  await check("the same key with the same body replays the same response", async () => {
    const res = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": "key-1" } });
    expectStatus(res, 201);
    expect(res.body.id === firstId, `expected id ${firstId}, got ${res.body.id}`);
  });

  await check("...and a third time, still the same", async () => {
    const res = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": "key-1" } });
    expectStatus(res, 201);
    expect(res.body.id === firstId, `expected id ${firstId}, got ${res.body.id}`);
  });

  await check("only one booking exists for that person", async () => {
    const res = await call("GET", "/bookings?email=ada@example.com");
    expectStatus(res, 200);
    expect(res.body.bookings.length === 1, `expected 1 booking, got ${res.body.bookings.length}`);
  });

  await check("key order and stray spaces still count as the same request", async () => {
    const res = await call("POST", "/bookings", {
      body: { email: " ADA@example.com ", name: " Ada Obi ", slot_id: "k1" },
      headers: { "Idempotency-Key": "key-1" },
    });
    expectStatus(res, 201);
    expect(res.body.id === firstId, `expected id ${firstId}, got ${res.body.id}`);
  });

  await check("the same key with a different body is a 422", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "k2", name: "Ada Obi", email: "ada@example.com" },
      headers: { "Idempotency-Key": "key-1" },
    });
    expectStatus(res, 422);
    expectErrorShape(res);
  });

  await check("a different key is a different request", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "k2", name: "Ada Obi", email: "ada@example.com" },
      headers: { "Idempotency-Key": "key-2" },
    });
    expectStatus(res, 201);
    expect(res.body.id !== firstId, "should be a new booking");
  });

  await check("two retries arriving at once still make one booking", async () => {
    const both = await Promise.all([
      call("POST", "/bookings", {
        body: { slot_id: "k3", name: "Bola Eze", email: "bola@example.com" },
        headers: { "Idempotency-Key": "key-3" },
      }),
      call("POST", "/bookings", {
        body: { slot_id: "k3", name: "Bola Eze", email: "bola@example.com" },
        headers: { "Idempotency-Key": "key-3" },
      }),
    ]);
    expect(
      both[0]!.status === 201 && both[1]!.status === 201,
      `both should be 201, got ${both.map((r) => r.status).join(" and ")}`,
    );
    expect(
      both[0]!.body.id === both[1]!.body.id,
      `both should be the same booking, got ${both[0]!.body.id} and ${both[1]!.body.id}`,
    );

    const list = await call("GET", "/bookings?email=bola@example.com");
    expect(list.body.bookings.length === 1, `expected 1 booking, got ${list.body.bookings.length}`);
  });

  await check("without a key, a repeat is just a 409", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "k1", name: "Someone Else", email: "else@example.com" },
    });
    expectStatus(res, 409);
  });

  // --- paging ---

  console.log("  paging:");

  /**
   * Five bookings for one person, made one after another so the order is known.
   * Five and not six: level 5 allows five attempts per email per minute, so a
   * sixth would be a 429. That is the rate limit working, not a paging bug.
   */
  const madeIds: string[] = [];

  await check("set up five bookings for one email", async () => {
    expectStatus(await call("POST", "/reset", { body: { slots: L4_SLOTS } }), 200);
    for (const slot of L4_SLOTS.slice(0, 5)) {
      const res = await call("POST", "/bookings", {
        body: { slot_id: slot.id, name: "Ada Obi", email: "ada@example.com" },
      });
      expectStatus(res, 201);
      madeIds.push(res.body.id);
    }
    expect(madeIds.length === 5, `expected 5 bookings, got ${madeIds.length}`);
  });

  await check("email is required", async () => {
    const res = await call("GET", "/bookings");
    expectStatus(res, 400);
    expectErrorShape(res);
  });

  for (const bad of ["0", "51", "-1", "1.5", "abc", ""]) {
    await check(`limit=${JSON.stringify(bad)} is a 400`, async () => {
      const res = await call("GET", `/bookings?email=ada@example.com&limit=${bad}`);
      expectStatus(res, 400);
      expectErrorShape(res);
    });
  }

  await check("a garbage cursor is a 400", async () => {
    const res = await call("GET", "/bookings?email=ada@example.com&cursor=not-a-cursor");
    expectStatus(res, 400);
    expectErrorShape(res);
  });

  await check("the default page holds everything here, oldest first", async () => {
    const res = await call("GET", "/bookings?email=ada@example.com");
    expectStatus(res, 200);
    const ids = res.body.bookings.map((b: any) => b.id);
    expect(
      JSON.stringify(ids) === JSON.stringify(madeIds),
      "bookings should come back in the order they were made",
    );
    expect(res.body.next_cursor === null, `next_cursor should be null, got ${res.body.next_cursor}`);
  });

  await check("limit=2 pages through all five without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query = `email=ada@example.com&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await call("GET", `/bookings?${query}`);
      expectStatus(res, 200);
      expect(res.body.bookings.length <= 2, `page too big: ${res.body.bookings.length}`);
      seen.push(...res.body.bookings.map((b: any) => b.id));
      cursor = res.body.next_cursor;
      pages++;
      expect(pages <= 10, "too many pages - the cursor is probably not advancing");
    } while (cursor !== null);

    expect(pages === 3, `expected 3 pages (2+2+1), got ${pages}`);
    expect(
      JSON.stringify(seen) === JSON.stringify(madeIds),
      `paged ids do not match: ${JSON.stringify(seen)}`,
    );
    expect(new Set(seen).size === seen.length, "a booking appeared on two pages");
  });

  await check("the last page says next_cursor: null", async () => {
    const first = await call("GET", "/bookings?email=ada@example.com&limit=3");
    expect(first.body.next_cursor !== null, "page 1 of 2 should have a cursor");
    const last = await call(
      "GET",
      `/bookings?email=ada@example.com&limit=3&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(last.body.bookings.length === 2, `expected 2 left over, got ${last.body.bookings.length}`);
    expect(last.body.next_cursor === null, "the last page should have no cursor");
  });

  await check("the email match ignores case", async () => {
    const res = await call("GET", "/bookings?email=ADA@Example.COM");
    expectStatus(res, 200);
    expect(res.body.bookings.length === 5, `expected 5 bookings, got ${res.body.bookings.length}`);
  });

  await check("someone with no bookings gets an empty page, not a 404", async () => {
    const res = await call("GET", "/bookings?email=nobody@example.com");
    expectStatus(res, 200);
    expect(res.body.bookings.length === 0, "expected no bookings");
    expect(res.body.next_cursor === null, "expected no cursor");
  });

  await check("cancelled bookings are still listed", async () => {
    expectStatus(await call("DELETE", `/bookings/${madeIds[0]}`), 200);
    const res = await call("GET", "/bookings?email=ada@example.com");
    expect(res.body.bookings.length === 5, `expected 5 bookings, got ${res.body.bookings.length}`);
    const cancelled = res.body.bookings.find((b: any) => b.id === madeIds[0]);
    expect(cancelled?.status === "cancelled", `status: ${cancelled?.status}`);
  });
}

// --- level 5 ----------------------------------------------------------------

const L5_SLOTS = Array.from({ length: 8 }, (_, i) => ({
  id: `r${i + 1}`,
  provider: "Dr Ade",
  start: future(60 * (i + 1)),
  end: future(60 * (i + 1) + 30),
}));

async function level5() {
  console.log("\nLevel 5 — five booking attempts per email per minute");

  await check("POST /reset installs the level 5 fixture", async () => {
    expectStatus(await call("POST", "/reset", { body: { slots: L5_SLOTS } }), 200);
  });

  await check("five succeed, the sixth is a 429 with Retry-After", async () => {
    const email = "spammer@example.com";
    for (let i = 0; i < 5; i++) {
      const res = await call("POST", "/bookings", {
        body: { slot_id: `r${i + 1}`, name: "Spammer", email },
      });
      expectStatus(res, 201);
    }

    const sixth = await call("POST", "/bookings", {
      body: { slot_id: "r6", name: "Spammer", email },
    });
    expectStatus(sixth, 429);
    expectErrorShape(sixth);

    const retryAfter = sixth.headers.get("retry-after");
    expect(retryAfter !== null, "Retry-After header is missing");
    expect(/^\d+$/.test(retryAfter!), `Retry-After must be whole seconds, got "${retryAfter}"`);
    const seconds = Number(retryAfter);
    expect(seconds >= 1 && seconds <= 60, `Retry-After out of range: ${seconds}`);
  });

  await check("another email is unaffected", async () => {
    const res = await call("POST", "/bookings", {
      body: { slot_id: "r6", name: "Someone Else", email: "other@example.com" },
    });
    expectStatus(res, 201);
  });

  await check("failed attempts count too: five 404s, then a 429", async () => {
    const email = "failer@example.com";
    for (let i = 0; i < 5; i++) {
      const res = await call("POST", "/bookings", {
        body: { slot_id: "no-such-slot", name: "Failer", email },
      });
      expectStatus(res, 404);
    }
    const sixth = await call("POST", "/bookings", {
      body: { slot_id: "r7", name: "Failer", email },
    });
    expectStatus(sixth, 429);
  });

  await check("requests rejected as invalid spend nothing", async () => {
    const email = "careless@example.com";
    for (let i = 0; i < 8; i++) {
      const res = await call("POST", "/bookings", { body: { slot_id: "r7", name: "", email } });
      expectStatus(res, 400);
    }
    // Still has its whole budget, because none of those got as far as booking.
    const real = await call("POST", "/bookings", {
      body: { slot_id: "r7", name: "Careless", email },
    });
    expectStatus(real, 201);
  });

  /**
   * The check that justifies the ordering decision: replaying a stored answer
   * creates nothing, so it must not spend the budget - otherwise a client that
   * retries a few times could not book again for a minute.
   */
  await check("replaying an Idempotency-Key spends nothing", async () => {
    expectStatus(await call("POST", "/reset", { body: { slots: L5_SLOTS } }), 200);

    const email = "retrier@example.com";
    const body = { slot_id: "r1", name: "Retrier", email };
    const headers = { "Idempotency-Key": "retry-key" };

    const first = await call("POST", "/bookings", { body, headers });
    expectStatus(first, 201);

    // Nine more retries - far past the limit of five.
    for (let i = 0; i < 9; i++) {
      const res = await call("POST", "/bookings", { body, headers });
      expectStatus(res, 201);
      expect(res.body.id === first.body.id, "every retry should be the same booking");
    }

    // And the email can still do real work.
    const another = await call("POST", "/bookings", {
      body: { slot_id: "r2", name: "Retrier", email },
    });
    expectStatus(another, 201);
  });

  await check("a blocked email recovers: Retry-After does not keep growing", async () => {
    expectStatus(await call("POST", "/reset", { body: { slots: L5_SLOTS } }), 200);
    const email = "patient@example.com";

    for (let i = 0; i < 5; i++) {
      expectStatus(
        await call("POST", "/bookings", { body: { slot_id: `r${i + 1}`, name: "P", email } }),
        201,
      );
    }

    const blocked = await call("POST", "/bookings", {
      body: { slot_id: "r6", name: "P", email },
    });
    expectStatus(blocked, 429);
    const firstWait = Number(blocked.headers.get("retry-after"));

    // Being refused must not extend the window. Ask again and the wait should
    // be the same or shorter, never longer.
    const again = await call("POST", "/bookings", { body: { slot_id: "r6", name: "P", email } });
    expectStatus(again, 429);
    const secondWait = Number(again.headers.get("retry-after"));
    expect(
      secondWait <= firstWait,
      `refusals are extending the window: ${firstWait}s then ${secondWait}s`,
    );
  });
}

// --- cross-cutting: the error shape has no exceptions -----------------------

async function errorShape() {
  console.log("\nError shape — every failure is {\"error\": \"...\"}");

  await check("an unknown route is JSON, not an HTML 404", async () => {
    const res = await call("GET", "/no-such-route");
    expectStatus(res, 404);
    expectErrorShape(res);
  });

  await check("malformed JSON is a 400, not an HTML error page", async () => {
    const res = await call("POST", "/bookings", { raw: "{ this is not json" });
    expectStatus(res, 400);
    expectErrorShape(res);
  });

  await check("a CORS preflight is answered without an API key", async () => {
    const res = await fetch(`${BASE}/bookings`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-api-key",
      },
    });
    expect(res.status < 300, `preflight should succeed, got ${res.status}`);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed.includes("x-api-key"), `preflight must allow X-API-Key, got "${allowed}"`);
  });
}

// --- run --------------------------------------------------------------------

async function main() {
  console.log(`Conformance run against ${BASE}`);
  if (!KEY) console.log("note: no API_KEY set — fine until level 2");

  await level1();
  await level2();
  await level3();
  await level4();
  await level5();
  await errorShape();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nharness crashed: ${(err as Error).message}`);
  process.exit(1);
});
