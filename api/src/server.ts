import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

/**
 * Listen first, ask the database nothing.
 *
 * Neon suspends an idle compute, so the first query after a quiet spell can
 * take seconds. If this waited on a connection before opening the port, Render
 * would see a server that never came up and kill the deploy. This way a cold
 * database costs one slow request instead of a failed deployment.
 */
app.listen(port, () => {
  console.log(`clinic-booking-api listening on :${port}`);
});
