import { chromium, type Browser, type Request, type Response } from "playwright";
import {
  describe,
  makeDoc,
  toPrettyJson,
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

export type NetworkErrorCode = "INVALID_URL" | "BROWSER_LAUNCH_FAILED" | "NAVIGATION_FAILED";

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

interface Captured {
  order: number;
  info: NetworkRequestInfo;
  label: string;
  text: string;
}

function withoutPseudoHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(":")));
}

function shouldCapture(response: Response): boolean {
  const status = response.status();
  if (status === 204 || (status >= 300 && status < 400)) return false;
  if (response.request().method() === "OPTIONS") return false;
  return JSON_CONTENT_TYPE.test(response.headers()["content-type"] ?? "");
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
    let text = raw;
    let parsed = false;
    let summary = "";
    try {
      const value: unknown = JSON.parse(raw.replace(XSSI_PREFIX, ""));
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
 * Loads `url` in headless Chromium and records every JSON response the page
 * receives until the network has been idle for IDLE_MS (or MAX_MS elapses).
 */
export async function captureNetwork(url: string): Promise<NetworkResult> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(url);
  } catch {
    throw new NetworkCaptureError("INVALID_URL", `Invalid URL: ${url}`);
  }
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
    throw new NetworkCaptureError("INVALID_URL", `Unsupported protocol "${pageUrl.protocol}"`);
  }

  const { browser, userAgent, userAgentMetadata } = await getBrowser();
  const context = await browser.newContext({ userAgent, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  if (userAgentMetadata) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent, userAgentMetadata });
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
