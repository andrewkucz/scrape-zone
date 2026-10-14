import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { authClient, loginPath, nextPath } from "./auth.ts";
import { Login } from "./Login.tsx";
import "./style.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

/** Shows the login page at /login and gates everything else behind a session. */
function Root() {
  const session = authClient.useSession();
  const [path, setPath] = useState(window.location.pathname);
  const signedIn = session.data != null;
  const onLogin = path === "/login";

  const navigate = (to: string) => {
    window.history.replaceState(null, "", to);
    setPath(window.location.pathname);
  };

  // Signed out (or the session expired) anywhere but the login page: go log in.
  useEffect(() => {
    if (!session.isPending && !signedIn && !onLogin) navigate(loginPath());
  }, [session.isPending, signedIn, onLogin]);

  // Just signed in (or already was): continue to the page that sent us here.
  useEffect(() => {
    if (signedIn && onLogin) navigate(nextPath());
  }, [signedIn, onLogin]);

  if (session.isPending) return null;
  if (onLogin) return signedIn ? null : <Login />;
  return signedIn ? <App /> : null;
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
);
