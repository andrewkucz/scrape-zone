import { useState, type FormEvent } from "react";
import { authClient } from "./auth.ts";

/** Signing in updates the shared session, which moves the app off this page. */
export function Login({ signup = false }: { signup?: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { error } = signup
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (error) setError(error.message ?? (signup ? "Sign up failed" : "Sign in failed"));
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="login">
      <form className="login-form" onSubmit={submit}>
        <h1>
          scrape<span>zone</span>
        </h1>
        {signup && (
          <>
            <p className="login-note">Create an account with an approved email address.</p>
            <input
              type="text"
              placeholder="Name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              aria-label="Name"
            />
          </>
        )}
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
          autoComplete={signup ? "new-password" : "current-password"}
          minLength={signup ? 8 : undefined}
          maxLength={signup ? 128 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          aria-label="Password"
        />
        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" disabled={pending}>
          {pending
            ? signup
              ? "Creating account…"
              : "Signing in…"
            : signup
              ? "Create account"
              : "Sign in"}
        </button>
        <a
          className="login-link"
          href={`${signup ? "/login" : "/signup"}${window.location.search}`}
        >
          {signup ? "Already have an account? Sign in" : "Create an account"}
        </a>
      </form>
    </div>
  );
}
