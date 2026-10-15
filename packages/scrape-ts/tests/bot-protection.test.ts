import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BotProtectionError,
  detectBotProtection,
  fetchHtml,
  isScrapeError,
  type BotProtectionProvider,
} from "../src/index.ts";
import { htmlResponse, mockFetch } from "./helpers.ts";

const cloudflareBlockedHtml = readFileSync(
  new URL("./fixtures/cloudflare-blocked.html", import.meta.url),
  "utf8",
);

/** Headers from a real Cloudflare "Sorry, you have been blocked" response. */
const cloudflareBlockedHeaders = {
  "content-type": "text/html; charset=UTF-8",
  "cache-control":
    "private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
  expires: "Thu, 01 Jan 1970 00:00:01 GMT",
  "referrer-policy": "same-origin",
  "x-frame-options": "SAMEORIGIN",
  server: "cloudflare",
  "cf-ray": "a4ab007b2a72e43e-OTP",
};

/** Cloudflare's error template as served for an origin failure (not a block). */
function cloudflareOriginErrorHtml(code: string, title: string) {
  return `<!DOCTYPE html><html><head><title>${title}</title>
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css" /></head>
<body><div id="cf-wrapper"><div id="cf-error-details" class="cf-error-details-wrapper">
<h1><span class="inline-block">${title}</span><span class="code-label">Error code ${code}</span></h1>
<span class="cf-footer-item">Cloudflare Ray ID: <strong>a4ab007b2a72e43e</strong></span>
<script>var a='/cdn-cgi/challenge-platform/scripts/jsd/main.js'</script>
</div></div></body></html>`;
}

function detect(status: number, headers: Record<string, string>, body = "") {
  return detectBotProtection({ status, headers: new Headers(headers), body });
}

describe("detectBotProtection", () => {
  test.each<[BotProtectionProvider, number, Record<string, string>, string]>([
    ["cloudflare", 403, { "cf-mitigated": "challenge" }, ""],
    ["cloudflare", 503, {}, "<script>window._cf_chl_opt={cvId:'3'}</script>"],
    [
      "cloudflare",
      403,
      { server: "cloudflare", "cf-ray": "a4aae97d0a5e6250-OTP" },
      "<title>Attention Required! | Cloudflare</title><div id='cf-error-details'>",
    ],
    ["cloudflare", 403, { server: "cloudflare" }, "error code: 1020"],
    ["cloudflare", 403, { server: "cloudflare" }, "<title>Just a moment...</title>"],
    ["akamai", 403, { server: "AkamaiGHost" }, "<H1>Access Denied</H1> errors.edgesuite.net"],
    ["akamai", 200, {}, '<div id="sec-if-cpt-container"></div>'],
    ["datadome", 403, {}, "<script src='https://ct.captcha-delivery.com/c.js'></script>"],
    ["datadome", 403, { "x-datadome": "protected" }, ""],
    ["perimeterx", 403, {}, '<div id="px-captcha"></div>'],
    ["perimeterx", 403, {}, "window._pxAppId = 'PXabc';"],
    ["imperva", 200, {}, '<iframe src="/_Incapsula_Resource?SWUDNSAI=31"></iframe>'],
    ["imperva", 403, { "x-iinfo": "1-2-3" }, ""],
    ["aws-waf", 202, { "x-amzn-waf-action": "challenge" }, ""],
    ["aws-waf", 405, {}, "<script>window.gokuProps = {}</script>"],
    [
      "aws-waf",
      403,
      { "x-cache": "Error from cloudfront" },
      "<H1>403 ERROR</H1><H2>The request could not be satisfied.</H2>Request blocked.",
    ],
    ["kasada", 429, { "x-kpsdk-ct": "abc" }, ""],
    ["sucuri", 403, { "x-sucuri-block": "BLK" }, ""],
    ["f5", 200, {}, "The requested URL was rejected. Please consult with your administrator."],
    ["vercel", 403, { "x-vercel-mitigated": "challenge" }, ""],
    ["anubis", 200, {}, '<script id="anubis_challenge" type="application/json">{}</script>'],
    ["wordfence", 503, {}, "Your access to this site has been limited by the site owner"],
    ["unknown", 403, {}, "<script src='https://js.hcaptcha.com/1/api.js'></script>"],
    ["unknown", 429, {}, "Please verify you are a human"],
  ])("detects %s (HTTP %i)", (provider, status, headers, body) => {
    expect(detect(status, headers, body)).toMatchObject({ provider });
  });

  test.each<[string, number, Record<string, string>, string]>([
    ["a normal Cloudflare-served page", 200, { server: "cloudflare", "cf-ray": "x" }, "<p>hi</p>"],
    ["an origin 404 behind Cloudflare", 404, { server: "cloudflare" }, "<h1>Not Found</h1>"],
    ["an allowed DataDome request", 200, { "x-datadome": "protected" }, "<p>hi</p>"],
    ["an Imperva-served 404", 404, { "x-iinfo": "1-2-3" }, "<h1>Not Found</h1>"],
    ["a plain 403", 403, {}, "<h1>Forbidden</h1>"],
    [
      "a large page mentioning a vendor domain",
      200,
      {},
      `${"<p>article</p>".repeat(10_000)} captcha-delivery.com`,
    ],
  ])("ignores %s", (_name, status, headers, body) => {
    expect(detect(status, headers, body)).toBeUndefined();
  });
});

describe("Cloudflare detection", () => {
  test("identifies a real security block page and its Ray ID", () => {
    expect(detect(403, cloudflareBlockedHeaders, cloudflareBlockedHtml)).toEqual({
      provider: "cloudflare",
      reason:
        'Cloudflare security block page (data-translate="block_headline"), Ray ID a4ab007b2a72e43e',
    });
  });

  test("identifies the block page from its body alone when headers are stripped", () => {
    expect(detect(403, {}, cloudflareBlockedHtml)).toEqual({
      provider: "cloudflare",
      reason:
        'Cloudflare security block page (data-translate="block_headline"), Ray ID a4ab007b2a72e43e',
    });
  });

  test.each([
    ["1020", "access denied by a firewall rule"],
    ["1015", "you are being rate limited"],
    ["1010", "the site owner has banned your browser signature"],
  ])("identifies access error %s", (code, description) => {
    expect(detect(403, { server: "cloudflare" }, `error code: ${code}`)).toMatchObject({
      reason: `Cloudflare error ${code}: ${description}`,
    });
  });

  test.each([
    ["522", "Connection timed out", 522],
    ["521", "Web server is down", 521],
    ["1016", "Origin DNS error", 530],
  ])("ignores origin error %s", (code, title, status) => {
    const html = cloudflareOriginErrorHtml(code, title);
    expect(detect(status, cloudflareBlockedHeaders, html)).toBeUndefined();
  });
});

describe("fetchHtml bot protection", () => {
  test("throws BotProtectionError for blocked error responses", async () => {
    const { fetch } = mockFetch(() =>
      htmlResponse(cloudflareBlockedHtml, {
        status: 403,
        statusText: "Forbidden",
        headers: cloudflareBlockedHeaders,
      }),
    );
    const error = await fetchHtml("https://example.com", { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BotProtectionError);
    expect(isScrapeError(error, "BOT_PROTECTION")).toBe(true);
    expect(error).toMatchObject({
      provider: "cloudflare",
      status: 403,
      url: "https://example.com/",
    });
  });

  test("throws BotProtectionError for challenge pages served with HTTP 200", async () => {
    const { fetch } = mockFetch(() => htmlResponse('<div id="sec-if-cpt-container"></div>'));
    await expect(fetchHtml("https://example.com", { fetch })).rejects.toMatchObject({
      code: "BOT_PROTECTION",
      provider: "akamai",
    });
  });

  test("detects plain-text block responses before the content type check", async () => {
    const { fetch } = mockFetch(() =>
      htmlResponse("error code: 1020", {
        status: 403,
        headers: { "content-type": "text/plain", server: "cloudflare" },
      }),
    );
    await expect(fetchHtml("https://example.com", { fetch })).rejects.toMatchObject({
      code: "BOT_PROTECTION",
    });
  });

  test("falls back to HTTP_ERROR when detection is disabled", async () => {
    const { fetch } = mockFetch(() =>
      htmlResponse("", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    );
    await expect(
      fetchHtml("https://example.com", { fetch, detectBotProtection: false }),
    ).rejects.toMatchObject({ code: "HTTP_ERROR" });
  });
});
