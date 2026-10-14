/**
 * Creates an account for an email listed in USER_EMAILS:
 *   node --env-file-if-exists=.env server/create-user.ts <email> <password> [name]
 */
import { createAuth } from "./auth.ts";

const [email, password, name = email?.split("@")[0]] = process.argv.slice(2);
if (!email || !password || !name) {
  console.error("Usage: create-user <email> <password> [name]");
  process.exit(1);
}

try {
  const { user } = await createAuth().api.signUpEmail({
    body: { email, password, name },
  });
  console.log(`Created ${user.email} (${user.id})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
