import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

test("signup enforces USER_EMAILS through the HTTP API without blocking existing logins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scrape-zone-auth-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.sqlite"));
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret-with-at-least-32-characters");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("USER_EMAILS", " Allowed@Example.com, , second@example.com ");
  const { createAuth } = await import("./auth.ts");
  const { db } = await import("./db/index.ts");
  const password = "test-password-123";
  const request = (path: string, email: string) =>
    new Request(`http://localhost:3000/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Test User", email, password }),
    });

  try {
    const auth = createAuth();
    for (const email of ["blocked@example.com", "allowed@example.com.evil", "other@EXAMPLE.com"]) {
      const response = await auth.handler(request("sign-up/email", email));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        message: "Signups are not permitted for this email address.",
      });
    }
    for (const email of ["ALLOWED@example.com", "second@example.com"]) {
      const response = await auth.handler(request("sign-up/email", email));
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("session_token");
    }

    for (const list of [undefined, "", " , , "]) {
      vi.stubEnv("USER_EMAILS", list);
      expect((await createAuth().handler(request("sign-up/email", "new@example.com"))).status).toBe(
        403,
      );
    }
    const response = await createAuth().handler(request("sign-in/email", "allowed@example.com"));
    expect(response.status).toBe(200);
    expect(await db.select().from((await import("./db/schema.ts")).user)).toHaveLength(2);
  } finally {
    db.$client.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
