import { describe, expect, test } from "vite-plus/test";
import { fetchHtml, isScrapeError, ScrapeError } from "../src/index.ts";
import { htmlResponse, mockFetch } from "./helpers.ts";

describe("fetchHtml", () => {
  test("uses the provided fetch implementation and merges headers", async () => {
    const { fetch, calls } = mockFetch(() => htmlResponse("<p>hi</p>"));

    const result = await fetchHtml("https://example.com/page", {
      fetch,
      headers: { "User-Agent": "custom-agent", "X-Extra": "1" },
    });

    expect(result.html).toBe("<p>hi</p>");
    expect(result.url).toBe("https://example.com/page");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("user-agent")).toBe("custom-agent");
    expect(headers.get("x-extra")).toBe("1");
    expect(headers.get("accept")).toContain("text/html");
  });

  test("reports the final URL after redirects", async () => {
    const { fetch } = mockFetch(() => htmlResponse("", { url: "https://example.com/final" }));
    const result = await fetchHtml("https://example.com/start", { fetch });
    expect(result.url).toBe("https://example.com/final");
  });

  test.each([
    ["not a url", "INVALID_URL"],
    ["ftp://example.com", "UNSUPPORTED_PROTOCOL"],
  ] as const)("rejects %s with %s", async (url, code) => {
    const { fetch, calls } = mockFetch(() => htmlResponse(""));
    await expect(fetchHtml(url, { fetch })).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(0);
  });

  test("throws HTTP_ERROR for non-2xx responses", async () => {
    const { fetch } = mockFetch(() => htmlResponse("", { status: 404, statusText: "Not Found" }));
    const error = await fetchHtml("https://example.com", { fetch }).catch((e: unknown) => e);

    expect(isScrapeError(error, "HTTP_ERROR")).toBe(true);
    expect(error).toMatchObject({ status: 404, message: "Page fetch returned HTTP 404 Not Found" });
  });

  test("throws NOT_HTML for non-HTML content types", async () => {
    const { fetch } = mockFetch(() =>
      htmlResponse("{}", { headers: { "content-type": "application/json" } }),
    );
    await expect(fetchHtml("https://example.com", { fetch })).rejects.toMatchObject({
      code: "NOT_HTML",
    });
  });

  test("wraps fetch failures in FETCH_FAILED", async () => {
    const cause = new TypeError("network down");
    const { fetch } = mockFetch(() => {
      throw cause;
    });
    const error = await fetchHtml("https://example.com", { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeError);
    expect(error).toMatchObject({ code: "FETCH_FAILED", cause });
  });

  test("throws TIMEOUT when the request exceeds timeoutMs", async () => {
    const { fetch } = mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(fetchHtml("https://example.com", { fetch, timeoutMs: 10 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  test("throws ABORTED when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = mockFetch(() => htmlResponse(""));

    await expect(
      fetchHtml("https://example.com", { fetch, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls).toHaveLength(0);
  });

  test("passes through additional RequestInit options", async () => {
    const { fetch, calls } = mockFetch(() => htmlResponse(""));
    await fetchHtml("https://example.com", { fetch, init: { method: "POST", body: "x" } });
    expect(calls[0]?.init).toMatchObject({ method: "POST", body: "x" });
  });
});
