/**
 * Every error the API returns on purpose. The error handler in app.ts is the
 * only place that turns one into a response, so the body shape the spec
 * demands - {"error": "<message>"} - is written exactly once.
 *
 *   throw fail(404, "slot not found");
 *   throw fail(429, "slow down", { "Retry-After": "12" });
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Response headers this error needs - level 5's Retry-After. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const fail = (status: number, message: string, headers?: Record<string, string>) =>
  new ApiError(status, message, headers);
