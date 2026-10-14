import { createAuthClient } from "better-auth/react";

// Same origin as the app, so the default /api/auth base path applies.
export const authClient = createAuthClient();

/** Where to land after signing in: the page the user was sent away from. */
export function loginPath() {
  const next = window.location.pathname + window.location.search;
  return next === "/" ? "/login" : `/login?${new URLSearchParams({ next })}`;
}

/** The `next` path from the login page's URL, restricted to this origin. */
export function nextPath() {
  const next = new URLSearchParams(window.location.search).get("next");
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}
