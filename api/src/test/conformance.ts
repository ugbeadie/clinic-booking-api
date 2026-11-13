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
