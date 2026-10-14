import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";

/**
 * Deliberately minimal protection: one shared password (APP_PASSWORD) checked
 * with HTTP Basic auth. The browser shows its own prompt and remembers the
 * credentials for the session; the username is ignored. Use HTTPS in front of
 * it, since Basic auth sends the password with every request.
 */
export const REALM = "scrape zone";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Returns a constant-time password check, or null when no password is configured. */
export function createPasswordCheck(password: string | undefined) {
  if (!password) {
    console.warn("[auth] APP_PASSWORD is not set; scrape zone is NOT password protected.");
    return null;
  }
  const expected = sha256(password);
  return (candidate: string) => timingSafeEqual(sha256(candidate), expected);
}

/** Checks a raw `Authorization: Basic …` header (for non-Hono servers, i.e. Vite dev). */
export function isAuthorizedHeader(
  check: (password: string) => boolean,
  header: string | undefined,
) {
  const match = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  return check(decoded.slice(decoded.indexOf(":") + 1));
}

export function passwordMiddleware(password: string | undefined): MiddlewareHandler {
  const check = createPasswordCheck(password);
  if (!check) return (_c, next) => next();
  return basicAuth({ realm: REALM, verifyUser: (_username, candidate) => check(candidate) });
}
