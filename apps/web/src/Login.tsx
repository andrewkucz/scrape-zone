import { useState, type FormEvent } from "react";
import { authClient } from "./auth.ts";

/** Signing in updates the shared session, which moves the app off this page. */
export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    if (error) {
      setPending(false);
      setError(error.message ?? "Sign in failed");
    }
  };

  return (
    <div className="login">
      <form className="login-form" onSubmit={submit}>
        <h1>
          scrape<span>zone</span>
        </h1>
        <input
          type="email"
          placeholder="Email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          aria-label="Email"
        />
        <input
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          aria-label="Password"
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
