import { useEffect, useRef, useState } from "react";
import { ApiError, cancelBooking, createBooking, listSlots, type Booking, type Slot } from "./api";

/** "Tue 10 Dec, 09:00 - 09:30" in the visitor's own timezone. */
function formatSlot(slot: Slot) {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const day = start.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time(start)} - ${time(end)}`;
}

export function App() {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [chosen, setChosen] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const [booking, setBooking] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * One Idempotency-Key per booking attempt, kept across retries. If the first
   * request times out and the visitor presses Book again, the API recognises
   * the key and returns the original booking instead of making a second one.
   */
  const attemptKey = useRef<string | null>(null);

  async function refreshSlots() {
    setLoadError(null);
    try {
      setSlots(await listSlots());
    } catch (err) {
      setSlots([]);
      setLoadError(err instanceof Error ? err.message : "Could not load slots");
    }
  }

  useEffect(() => {
    void refreshSlots();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen || busy) return;

    attemptKey.current ??= crypto.randomUUID();
    setBusy(true);
    setFormError(null);

    try {
      const created = await createBooking(
        { slot_id: chosen.id, name, email },
        attemptKey.current,
      );
      setBooking(created);
      attemptKey.current = null;
      await refreshSlots();
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(
          err.retryAfter
            ? `${err.message}. Try again in ${err.retryAfter} seconds.`
            : err.message,
        );
        // The slot was taken while the form was open: show the new state.
        if (err.status === 409 || err.status === 404) {
          setChosen(null);
          attemptKey.current = null;
          await refreshSlots();
        }
      } else {
        setFormError("Could not reach the booking service.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!booking || busy) return;
    setBusy(true);
    try {
      setBooking(await cancelBooking(booking.id));
      await refreshSlots();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not cancel");
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setBooking(null);
    setChosen(null);
    setName("");
    setEmail("");
    setFormError(null);
    attemptKey.current = null;
  }

  // --- the confirmation, once a booking exists ---

  if (booking) {
    const cancelled = booking.status === "cancelled";
    const slot = slots?.find((s) => s.id === booking.slot_id);

    return (
      <main>
        <h1>Riverside Clinic</h1>
        <section className={cancelled ? "card muted" : "card good"}>
          <h2>{cancelled ? "Booking cancelled" : "You're booked in"}</h2>
          <dl>
            <dt>Reference</dt>
            <dd className="mono">{booking.id}</dd>
            <dt>Name</dt>
            <dd>{booking.name}</dd>
            <dt>Email</dt>
            <dd>{booking.email}</dd>
            {slot && (
              <>
                <dt>With</dt>
                <dd>{slot.provider}</dd>
                <dt>When</dt>
                <dd>{formatSlot(slot)}</dd>
              </>
            )}
            <dt>Status</dt>
            <dd>{booking.status}</dd>
          </dl>

          {formError && <p className="error">{formError}</p>}

          <div className="actions">
            {!cancelled && (
              <button type="button" onClick={cancel} disabled={busy} className="secondary">
                {busy ? "Cancelling..." : "Cancel this booking"}
              </button>
            )}
            <button type="button" onClick={startOver}>
              Book another appointment
            </button>
          </div>
        </section>
      </main>
    );
  }

  // --- choosing a slot and filling in the form ---

  return (
    <main>
      <h1>Riverside Clinic</h1>
      <p className="lead">Choose an appointment time.</p>

      {loadError && (
        <section className="card bad">
          <p className="error">{loadError}</p>
          <button type="button" onClick={refreshSlots}>
            Try again
          </button>
        </section>
      )}

      {slots === null && <p className="lead">Loading appointments...</p>}

      {slots && slots.length === 0 && !loadError && (
        <p className="lead">No appointments are listed right now.</p>
      )}

      {slots && slots.length > 0 && (
        <ul className="slots">
          {slots.map((slot) => {
            const past = new Date(slot.start).getTime() <= Date.now();
            const bookable = slot.available && !past;
            return (
              <li key={slot.id}>
                <button
                  type="button"
                  onClick={() => {
                    setChosen(slot);
                    setFormError(null);
                    attemptKey.current = null;
                  }}
                  disabled={!bookable}
                  aria-pressed={chosen?.id === slot.id}
                  className={chosen?.id === slot.id ? "slot chosen" : "slot"}
                >
                  <span className="when">{formatSlot(slot)}</span>
                  <span className="who">{slot.provider}</span>
                  <span className="tag">
                    {past ? "Past" : slot.available ? "Available" : "Taken"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {chosen && (
        <form className="card" onSubmit={submit}>
          <h2>{formatSlot(chosen)}</h2>
          <p className="lead">with {chosen.provider}</p>

          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>

          <label>
            Your email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>

          {formError && <p className="error">{formError}</p>}

          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? "Booking..." : "Book this appointment"}
            </button>
            <button type="button" className="secondary" onClick={() => setChosen(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
