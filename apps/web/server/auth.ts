import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createMiddleware } from "hono/factory";
import { db } from "./db/index.ts";
import * as schema from "./db/schema.ts";

/**
 * Email + password accounts (better-auth), stored through Drizzle.
 * Public sign-up is disabled: accounts are created with `server/create-user.ts`.
 * BETTER_AUTH_SECRET (required in production) and BETTER_AUTH_URL are read from
 * the environment by better-auth itself.
 */
export function createAuth({ allowSignUp = false } = {}) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true, disableSignUp: !allowSignUp },
  });
}

export const auth = createAuth();

export type AuthEnv = { Variables: { session: typeof auth.$Infer.Session } };

/** Rejects requests without a valid session cookie. */
export const requireSession = createMiddleware<AuthEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in required" } }, 401);
  }
  c.set("session", session);
  await next();
});
