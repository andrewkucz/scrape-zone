import { ScrapeError } from "./errors.ts";

/**
 * Any function with the shape of the global `fetch`. Custom implementations
 * (proxies, retries, undici dispatchers, test doubles, ...) only need to accept
 * a URL string and an optional `RequestInit`.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  /** Fetch implementation to use. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Headers merged over (and overriding) the default browser-like headers. */
  headers?: RequestInit["headers"];
  /** Aborts the request when signalled. */
  signal?: AbortSignal;
  /** Request timeout in milliseconds, or `false` to disable. Defaults to 15000. */
  timeoutMs?: number | false;
  /** Additional `RequestInit` options passed through to `fetch`. */
  init?: Omit<RequestInit, "headers" | "signal">;
}

export interface FetchHtmlResult {
  html: string;
  /** The final URL after redirects. */
  url: string;
  response: Response;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

/**
 * Fetches a page and returns its HTML, normalising every failure into a
 * {@link ScrapeError}.
 */
export async function fetchHtml(
  url: string | URL,
  options: FetchOptions = {},
): Promise<FetchHtmlResult> {
  const requestedUrl = parseRequestedUrl(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = timeoutMs === false ? undefined : AbortSignal.timeout(timeoutMs);
  const signals = [options.signal, timeoutSignal].filter((signal) => signal !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  try {
    signal?.throwIfAborted();

    const response = await fetchImpl(requestedUrl, {
      redirect: "follow",
      ...options.init,
      headers: createRequestHeaders(options.headers),
      signal,
    });
    const finalUrl = response.url || requestedUrl;

    if (!response.ok) {
      throw new ScrapeError(
        `Page fetch returned HTTP ${response.status} ${response.statusText}`.trim(),
        "HTTP_ERROR",
        { url: finalUrl, status: response.status },
      );
    }

    const contentType = response.headers.get("content-type");
    if (contentType && !isHtmlContentType(contentType)) {
      throw new ScrapeError(
        `Expected an HTML response from ${finalUrl}, received ${contentType}`,
        "NOT_HTML",
        { url: finalUrl, status: response.status },
      );
    }

    return { html: await response.text(), url: finalUrl, response };
  } catch (cause) {
    if (cause instanceof ScrapeError) {
      throw cause;
    }

    if (timeoutSignal?.aborted && !options.signal?.aborted) {
      throw new ScrapeError(
        `Timed out fetching page after ${timeoutMs}ms: ${requestedUrl}`,
        "TIMEOUT",
        { cause, url: requestedUrl },
      );
    }

    if (options.signal?.aborted) {
      throw new ScrapeError(`Fetch was aborted: ${requestedUrl}`, "ABORTED", {
        cause: options.signal.reason ?? cause,
        url: requestedUrl,
      });
    }

    throw new ScrapeError(`Failed to fetch page: ${requestedUrl}`, "FETCH_FAILED", {
      cause,
      url: requestedUrl,
    });
  }
}

function parseRequestedUrl(rawUrl: string | URL): string {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch (cause) {
    throw new ScrapeError(`Invalid URL: ${String(rawUrl)}`, "INVALID_URL", {
      cause,
      url: String(rawUrl),
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScrapeError(
      `Unsupported URL protocol "${parsed.protocol}" for ${parsed.href}`,
      "UNSUPPORTED_PROTOCOL",
      { url: parsed.href },
    );
  }

  return parsed.href;
}

function createRequestHeaders(callerHeaders: RequestInit["headers"]): Headers {
  const headers = new Headers(DEFAULT_HEADERS);

  if (callerHeaders) {
    for (const [key, value] of new Headers(callerHeaders)) {
      headers.set(key, value);
    }
  }

  return headers;
}

function isHtmlContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}
