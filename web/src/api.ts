/**
 * The only place this app talks to the API. Every call sends the API key and
 * turns an error response into an ApiError carrying the message the API sent.
 */

const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const KEY = import.meta.env.VITE_API_KEY ?? "";

export type Slot = {
  id: string;
  provider: string;
  start: string;
  end: string;
  available: boolean;
};

export type Booking = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds to wait, when the API rate-limited us (level 5). */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": KEY,
      ...init.headers,
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    // Every error the API sends looks like {"error": "..."}, so there is one
    // way to read a failure rather than one per call.
    const retryAfter = response.headers.get("Retry-After");
    throw new ApiError(
      response.status,
      body?.error ?? `Request failed (${response.status})`,
      retryAfter ? Number(retryAfter) : null,
    );
  }

  return body as T;
}

export const listSlots = () =>
  request<{ slots: Slot[] }>("/slots").then((result) => result.slots);

/**
 * The Idempotency-Key is the caller's job, not the API's. The page generates one
 * per booking attempt and reuses it if the request has to be retried, so a
 * flaky connection or an impatient second click cannot produce two bookings.
 */
export const createBooking = (
  input: { slot_id: string; name: string; email: string },
  idempotencyKey: string,
) =>
  request<Booking>("/bookings", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "Idempotency-Key": idempotencyKey },
  });

export const cancelBooking = (id: string) =>
  request<Booking>(`/bookings/${id}`, { method: "DELETE" });
