import express, { type ErrorRequestHandler } from "express";
import { requireApiKey } from "./auth.js";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import { bookingsRouter } from "./routes/bookings.js";
import { resetRouter } from "./routes/reset.js";
import { slotsRouter } from "./routes/slots.js";

export const app = express();

app.disable("x-powered-by");
// Render terminates HTTPS in front of us, so without this Express sees the
// proxy rather than the client.
app.set("trust proxy", true);

/**
 * CORS. The order matters more than the headers do.
 *
 * The web page is on a different origin to the API, so before the browser sends
 * POST /bookings it sends an OPTIONS preflight asking permission - and a
 * preflight never carries custom headers, so it has no X-API-Key. If the
 * API-key check (level 2) ran on OPTIONS it would answer 401, the browser would
 * never send the real request, and the whole page would break while the API
 * still looked perfect from curl. So preflight is answered here, above auth.
 *
 * Retry-After has to be exposed explicitly or the page cannot read it off a
 * 429, which level 5 needs.
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Expose-Headers", "Retry-After");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Idempotency-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }
  next();
});

// Deliberately above the API-key check: an uptime pinger hits this every few
// minutes to keep Render and the Neon compute awake, and should not need a
// secret to do it. It queries the database, because "is the process up" is not
// the useful question.
app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

// Everything below this line needs the API key. Above body parsing on purpose:
// a request we are going to reject should not get its body parsed first.
app.use(requireApiKey);

// `type: () => true` parses the body whatever Content-Type it arrives with. A
// client that posts JSON without the header is common, and the alternative
// failure - seeing an empty body and complaining that slot_id is missing when
// it was not - is much worse to debug. A body that is not JSON becomes a
// SyntaxError, handled as a 400 below.
app.use(express.json({ limit: "256kb", type: () => true }));

app.use(resetRouter);
app.use(slotsRouter);
app.use(bookingsRouter);

// Unknown route. Express's own 404 is HTML, and the spec's error shape has no
// exceptions.
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

/**
 * The only place an error becomes a response. Express 5 forwards rejected
 * promises from async handlers here on its own, which is why the routes can
 * just throw with no try/catch.
 */
const onError: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    for (const [name, value] of Object.entries(err.headers)) {
      res.setHeader(name, value);
    }
    res.status(err.status).json({ error: err.message });
    return;
  }

  // express.json() on a malformed body; its own response would be HTML.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }

  console.error("unhandled error:", err);
  res.status(500).json({ error: "internal error" });
};

app.use(onError);
