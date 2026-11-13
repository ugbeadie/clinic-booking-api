/**
 * Every error the API returns on purpose. The error handler in app.ts is the
 * only place that turns one into a response, so the body shape the spec
 * demands - {"error": "<message>"} - is written exactly once.
 *
 *   throw fail(404, "slot not found");
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const fail = (status: number, message: string) => new ApiError(status, message);
