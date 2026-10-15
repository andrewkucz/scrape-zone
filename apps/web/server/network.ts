import { chromium, type Browser, type Request, type Response } from "playwright";
import {
  parseTextRemixDeferredBody,
  parseTextXScriptTurboStreamBody,
  TEXT_REMIX_DEFERRED_CONTENT_TYPE,
  TEXT_X_SCRIPT_CONTENT_TYPE,
} from "scrape-ts";
import { playwrightProxy } from "./proxy.ts";
import { DEFAULT_REQUEST, type RequestOptions } from "./request.ts";
import {
  describe,
  makeDoc,
  toPrettyJson,
  type BodyParser,
  type NetworkRequestInfo,
  type ScrapedDoc,
} from "./scrape.ts";

const IDLE_MS = 2_000;
const MAX_MS = 10_000;
/** How long to wait for in-flight response bodies once the page is considered done. */
const BODY_GRACE_MS = 2_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** application/json, application/ld+json, application/vnd.api+json, text/json, ... */
const JSON_CONTENT_TYPE = /[/+]json\b/i;
/** Anti-JSON-hijacking prefixes some APIs put in front of the body. */
const XSSI_PREFIX = /^(?:\)\]\}'?,?|for\s*\(;;\);|while\s*\(1\);)\s*/;

/** Framework data formats that need decoding (with the named scrape-ts function) before display. */
const BODY_PARSERS: Array<{
  contentType: RegExp;
  name: BodyParser;
  parse: (body: string) => unknown;
}> = [
  {
    // Remix v1/v2 `defer()` loader responses.
    contentType: TEXT_REMIX_DEFERRED_CONTENT_TYPE,
    name: "parseTextRemixDeferredBody",
    parse: parseTextRemixDeferredBody,
  },
  {
    // React Router 7 / Remix single fetch (turbo-stream) `.data` responses.
    contentType: TEXT_X_SCRIPT_CONTENT_TYPE,
    name: "parseTextXScriptTurboStreamBody",
    parse: parseTextXScriptTurboStreamBody,
  },
];

const parserFor = (contentType: string) =>
  BODY_PARSERS.find((p) => p.contentType.test(contentType)) ?? null;

export type NetworkErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_METHOD"
  | "BROWSER_LAUNCH_FAILED"
  | "NAVIGATION_FAILED";

export class NetworkCaptureError extends Error {
  code: NetworkErrorCode;
  constructor(code: NetworkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export interface NetworkResult {
  url: string;
  durationMs: number;
  /** False when the page was still busy at the MAX_MS cutoff. */
  reachedIdle: boolean;
  totalRequests: number;
  /** Viewport screenshot taken once loading finished, as a `data:image/jpeg` URL. */
  screenshot: string | null;
  docs: ScrapedDoc[];
}

interface Brand {
  brand: string;
  version: string;
}

/** CDP `Emulation.UserAgentMetadata`, which drives the `sec-ch-ua*` client hints. */
interface UserAgentMetadata {
  brands: Brand[];
  fullVersionList: Brand[];
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

interface SharedBrowser {
  browser: Browser;
  /**
   * The browser's real user agent and client hints with the "HeadlessChrome"
   * marker swapped for "Chrome", since many sites block on it.
   */
  userAgent: string;
  userAgentMetadata: UserAgentMetadata | null;
}

// One browser is shared across captures (each gets its own context). It lives on
// globalThis so dev-server module reloads don't leak Chromium processes.
const shared = globalThis as { __scrapeZoneBrowser?: Promise<SharedBrowser> };

const unheadless = (brands: Brand[]) =>
  brands.map((b) => (b.brand === "HeadlessChrome" ? { ...b, brand: "Google Chrome" } : b));

async function launch(): Promise<SharedBrowser> {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  // navigator.userAgentData only exists in secure contexts, so serve a blank https page.
  const probeUrl = "https://scrape-zone.invalid/";
  await page.route(probeUrl, (route) => route.fulfill({ contentType: "text/html", body: "" }));
  await page.goto(probeUrl);
  const { userAgent, metadata } = await page.evaluate(async () => {
    const data = (
      navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
        };
      }
    ).userAgentData;
    const hints = ["platformVersion", "architecture", "model", "fullVersionList"];
    return {
      userAgent: navigator.userAgent,
      metadata: data ? await data.getHighEntropyValues(hints) : null,
    };
  });
  await page.close();

  return {
    browser,
    userAgent: userAgent.replace("HeadlessChrome", "Chrome"),
    userAgentMetadata: metadata && {
      brands: unheadless(metadata.brands as Brand[]),
      fullVersionList: unheadless(metadata.fullVersionList as Brand[]),
      platform: metadata.platform as string,
      platformVersion: metadata.platformVersion as string,
      architecture: metadata.architecture as string,
      model: metadata.model as string,
      mobile: metadata.mobile as boolean,
    },
  };
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (bundledError) {
    // Playwright's bundled Chromium isn't installed; try a locally installed Chrome.
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw new NetworkCaptureError(
        "BROWSER_LAUNCH_FAILED",
        'Could not launch a browser. Run "pnpm exec playwright install chromium".',
        { cause: bundledError },
      );
    }
  }
}

function getBrowser(): Promise<SharedBrowser> {
  let browser = shared.__scrapeZoneBrowser;
  if (!browser) {
    const launching = launch();
    shared.__scrapeZoneBrowser = browser = launching;
    const forget = () => {
      if (shared.__scrapeZoneBrowser === launching) shared.__scrapeZoneBrowser = undefined;
    };
    launching.then(({ browser }) => browser.on("disconnected", forget), forget);
  }
  return browser;
}

/** Closes the shared browser, if one was launched. */
export async function closeBrowser(): Promise<void> {
  const launching = shared.__scrapeZoneBrowser;
  shared.__scrapeZoneBrowser = undefined;
  await launching?.then(({ browser }) => browser.close()).catch(() => {});
}

interface Captured {
  order: number;
  info: NetworkRequestInfo;
  label: string;
  text: string;
}

function withoutPseudoHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(":")));
}

/**
 * Splits a `Cookie` request header into cookies for `pageUrl`. Playwright ignores a Cookie
 * header set via `route.continue()`, so these go into the browser's cookie store instead
 * (which also sends them on the page's own same-site requests, as a real browser would).
 */
function cookiesFromHeader(header: string, pageUrl: URL) {
  return header.split(";").flatMap((pair) => {
    const eq = pair.indexOf("=");
    const name = (eq === -1 ? "" : pair.slice(0, eq)).trim();
    if (!name) return [];
    // `url` (rather than `domain`) makes them host-only cookies with path "/", like the
    // server would most likely have set them, and keeps `__Host-` cookies valid.
    return [{ name, value: pair.slice(eq + 1).trim(), url: `${pageUrl.origin}/` }];
  });
}

function shouldCapture(response: Response): boolean {
  const status = response.status();
  if (status === 204 || (status >= 300 && status < 400)) return false;
  if (response.request().method() === "OPTIONS") return false;
  const contentType = response.headers()["content-type"] ?? "";
  return JSON_CONTENT_TYPE.test(contentType) || parserFor(contentType) !== null;
}

function labelFor(request: Request, pageUrl: URL): string {
  const url = new URL(request.url());
  const target = url.host === pageUrl.host ? `${url.pathname}${url.search}` : url.href;
  return `${request.method()} ${target}`;
}

async function collect(response: Response, order: number, pageUrl: URL): Promise<Captured | null> {
  const request = response.request();
  try {
    const [requestHeaders, responseHeaders, body] = await Promise.all([
      request.allHeaders(),
      response.allHeaders(),
      response.body(),
    ]);
    if (body.byteLength > MAX_BODY_BYTES) return null;

    const raw = body.toString("utf8");
    const contentType = (responseHeaders["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const parser = parserFor(contentType);
    let text = raw;
    let parsed = false;
    let summary = "";
    try {
      const value: unknown = parser
        ? await parser.parse(raw)
        : JSON.parse(raw.replace(XSSI_PREFIX, ""));
      text = toPrettyJson(value);
      parsed = true;
      summary = describe(value);
    } catch {
      // Keep the raw body so it is still searchable.
    }

    const { responseEnd } = request.timing();
    return {
      order,
      label: summary ? `${labelFor(request, pageUrl)}  ${summary}` : labelFor(request, pageUrl),
      text,
      info: {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        requestHeaders: withoutPseudoHeaders(requestHeaders),
        postData: request.postData(),
        status: response.status(),
        statusText: response.statusText(),
        responseHeaders: withoutPseudoHeaders(responseHeaders),
        contentType,
        parser: parser?.name ?? null,
        rawBody: parser && parsed ? raw : null,
        durationMs: responseEnd >= 0 ? Math.round(responseEnd) : null,
        parsed,
      },
    };
  } catch {
    // Body unavailable (page navigated away, request aborted, ...).
    return null;
  }
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, ms, value));
}

/**
 * Loads `url` in headless Chromium and records every JSON (or Remix / React Router data) response the page
 * receives until the network has been idle for IDLE_MS (or MAX_MS elapses).
 */
export async function captureNetwork(
  url: string,
  options: RequestOptions = DEFAULT_REQUEST,
): Promise<NetworkResult> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(url);
  } catch {
    throw new NetworkCaptureError("INVALID_URL", `Invalid URL: ${url}`);
  }
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
    throw new NetworkCaptureError("INVALID_URL", `Unsupported protocol "${pageUrl.protocol}"`);
  }
  // A browser navigation is always a GET; replaying another method would also resend its
  // body to whatever the page loads, so the client disables capture for non-GET requests.
  if (options.method !== "GET") {
    throw new NetworkCaptureError(
      "UNSUPPORTED_METHOD",
      `Network capture only supports GET requests, not ${options.method}`,
    );
  }

  const proxy = options.proxy ? playwrightProxy() : undefined;
  const { browser, userAgent, userAgentMetadata } = await getBrowser();
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1366, height: 900 },
    proxy,
  });
  const page = await context.newPage();
  if (userAgentMetadata) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent, userAgentMetadata });
  }

  const customHeaders = Object.entries(options.headers).map(
    ([name, value]) => [name.toLowerCase(), value] as const,
  );
  const cookies = customHeaders
    .filter(([name]) => name === "cookie")
    .flatMap(([, value]) => cookiesFromHeader(value, pageUrl));
  // One at a time: Chromium rejects the whole batch if any cookie is invalid (e.g. a
  // `__Host-` cookie on plain http), and the rest should still be sent.
  await Promise.all(cookies.map((cookie) => context.addCookies([cookie]).catch(() => {})));

  // The other custom headers only go on the page request, so e.g. an Authorization
  // header isn't leaked to third-party subresources.
  const pageHeaders = customHeaders.filter(([name]) => name !== "cookie");
  if (pageHeaders.length > 0) {
    await page.route(
      (u) => u.href === pageUrl.href,
      async (route) => {
        const headers = { ...(await route.request().allHeaders()) };
        for (const [name, value] of pageHeaders) headers[name] = value;
        await route.continue({ headers: withoutPseudoHeaders(headers) });
      },
      { times: 1 },
    );
  }

  const started = performance.now();
  const inflight = new Set<Request>();
  const order = new Map<Request, number>();
  const pending: Array<Promise<Captured | null>> = [];
  let lastActivity = started;

  page.on("request", (request) => {
    order.set(request, order.size);
    inflight.add(request);
    lastActivity = performance.now();
  });
  const settle = (request: Request) => {
    inflight.delete(request);
    lastActivity = performance.now();
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  page.on("response", (response) => {
    if (shouldCapture(response)) {
      pending.push(collect(response, order.get(response.request()) ?? order.size, pageUrl));
    }
  });

  try {
    try {
      await page.goto(pageUrl.href, { waitUntil: "commit", timeout: MAX_MS });
    } catch (error) {
      throw new NetworkCaptureError(
        "NAVIGATION_FAILED",
        error instanceof Error ? error.message.split("\n")[0]! : String(error),
        { cause: error },
      );
    }

    let reachedIdle = false;
    while (performance.now() - started < MAX_MS) {
      const now = performance.now();
      if (inflight.size === 0 && now - lastActivity >= IDLE_MS) {
        reachedIdle = true;
        break;
      }
      await timeout(100, undefined);
    }
    const durationMs = Math.round(performance.now() - started);

    const [screenshot, settled] = await Promise.all([
      page
        .screenshot({ type: "jpeg", quality: 70, timeout: BODY_GRACE_MS })
        .then((buf) => `data:image/jpeg;base64,${buf.toString("base64")}`)
        .catch(() => null),
      // Responses still streaming (long-polling, SSE, ...) shouldn't hold up the result.
      Promise.all(pending.map((p) => Promise.race([p, timeout(BODY_GRACE_MS, null)]))),
    ]);
    const captured = settled
      .filter((c): c is Captured => c !== null)
      .sort((a, b) => a.order - b.order);

    return {
      url: pageUrl.href,
      durationMs,
      reachedIdle,
      totalRequests: order.size,
      screenshot,
      docs: captured.map((c, i) => ({
        ...makeDoc("network", i, c.label, c.text),
        request: c.info,
      })),
    };
  } finally {
    await context.close().catch(() => {});
  }
}
