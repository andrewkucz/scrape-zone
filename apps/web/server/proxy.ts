import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { FetchLike } from "scrape-ts";

// Not secrets; only the password comes from the environment.
const PROXY_URL = "http://iriguchi.proxy.rlwy.net:40387";
const PROXY_USERNAME = "akucz";

export class ProxyNotConfiguredError extends Error {
  code = "PROXY_NOT_CONFIGURED" as const;
  constructor() {
    super("The EU proxy is unavailable: PROXY_PASSWORD is not set on the server.");
  }
}

function proxyPassword(): string {
  const password = process.env.PROXY_PASSWORD;
  if (!password) throw new ProxyNotConfiguredError();
  return password;
}

/** Credentials for Playwright's per-context `proxy` option. */
export function playwrightProxy() {
  return { server: PROXY_URL, username: PROXY_USERNAME, password: proxyPassword() };
}

let agent: ProxyAgent | undefined;

/**
 * A fetch that goes through the EU proxy, reusing its connection pool across
 * requests. Throws {@link ProxyNotConfiguredError} up front when there is no password.
 */
export function getProxyFetch(): FetchLike {
  agent ??= new ProxyAgent({
    uri: PROXY_URL,
    token: `Basic ${Buffer.from(`${PROXY_USERNAME}:${proxyPassword()}`).toString("base64")}`,
  });
  const dispatcher = agent;
  // undici's own fetch, so the dispatcher always matches its undici version.
  return (url, init) =>
    undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>;
}
