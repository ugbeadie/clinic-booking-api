import "dotenv/config";
import type { RequestHandler } from "express";
import { fail } from "./errors.js";

const API_KEY = process.env.API_KEY;

// Fail at startup, not on the first request. A server that is up but rejects
// everything is harder to notice than one that refuses to boot.
if (!API_KEY) {
  throw new Error("API_KEY is not set. Copy api/.env.example to api/.env and fill it in.");
}

/**
 * Level 2 - only requests with the API key get in.
 *
 * Mounted in app.ts above every route, so no endpoint can forget to check.
 */
export const requireApiKey: RequestHandler = (req, _res, next) => {
  if (req.header("X-API-Key") !== API_KEY) {
    throw fail(401, "invalid or missing API key");
  }
  next();
};
