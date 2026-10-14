import { expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  fetchAllPageData,
  parseAllJsonScripts,
  parseAllNextRscProps,
  parseAllPageData,
  parseFirstMatchingNextRscProps,
} from "../src/index.ts";
import { htmlResponse, mockFetch, nextFlightHtml } from "./helpers.ts";

const payload = '0:["$","div",null,{"title":"Hello","children":["$","span",null,{"id":7}]}]\n';
const flightScript = (text: string) =>
  `<script>self.__next_f.push(${JSON.stringify([1, text])})</script>`;

test("combines all payloads and preserves remaining HTML exactly", () => {
  const before = "<!DOCTYPE html>\r\n<HTML lang='en'><body>🦊 &amp; &#65;\n";
  const after = "<p class='foo' >Text</p></body></HTML>";
  const retained = [
    '<script src="/app.js"></script>',
    '<script type="application/json">broken</script>',
    '<script type="application/json"> </script>',
    '<script type="text/javascript">window.ready = true</script>',
    "<script>self.__next_f.push([0])</script>",
  ].join("\n");
  const html =
    before +
    '<script type="application/json">{"count":1}</script>' +
    '<script type="application/ld+json">{"name":"line one\nline two"}</script>' +
    retained +
    flightScript(payload) +
    after;
  const result = parseAllPageData(html);
  expect(result.jsonScripts).toEqual([{ count: 1 }, { name: "line one\nline two" }]);
  expect(result.jsonScripts).toEqual(parseAllJsonScripts(html));
  expect(result.nextRscProps).toEqual(parseAllNextRscProps(html));
  expect(result.nextRscProps).toHaveLength(2);
  expect(result.html).toBe(before + retained + after);
});

test("reconstructs split Flight payloads and removes every contributing script", () => {
  const html =
    "<main>Keep</main>" +
    flightScript(payload.slice(0, 20)) +
    "<script>window.keep = 1</script>" +
    flightScript(payload.slice(20));
  expect(parseAllPageData(html)).toMatchObject({
    nextRscProps: [{ title: "Hello" }, { id: 7 }],
    html: "<main>Keep</main><script>window.keep = 1</script>",
  });
});

test.each(["", "  <p>No data &amp; no wrappers</p>\n", "<script>self.__next_f.push([0])</script>"])(
  "returns empty collections and unchanged HTML without payloads: %s",
  (html) => {
    expect(parseAllPageData(html)).toEqual({ jsonScripts: [], nextRscProps: [], html });
  },
);

test("keeps JSON primitives and arrays as individual payloads", () => {
  const html = [null, false, 0, "", [1, 2]]
    .map((value) => `<script type="application/json">${JSON.stringify(value)}</script>`)
    .join("");
  expect(parseAllPageData(html)).toEqual({
    jsonScripts: [null, false, 0, "", [1, 2]],
    nextRscProps: [],
    html: "",
  });
});

test("does not interpret Flight references inside JSON data as push calls", () => {
  const value = { text: "self.__next_f.push([1, notJson])" };
  expect(
    parseAllPageData(`<script type="application/json">${JSON.stringify(value)}</script>`),
  ).toEqual({ jsonScripts: [value], nextRscProps: [], html: "" });
});

test("ignores script-looking markup in comments and text areas", () => {
  const html =
    '<!-- <script type="application/json">1</script> -->' +
    '<textarea><script type="application/json">2</script></textarea>';
  expect(parseAllPageData(html)).toEqual({ jsonScripts: [], nextRscProps: [], html });
});

test("reports malformed Flight data with URL context", () => {
  expect(() =>
    parseAllPageData("<script>self.__next_f.push([1, invalid])</script>", {
      url: "https://example.com",
    }),
  ).toThrow(expect.objectContaining({ code: "SCRIPT_PARSE_FAILED", url: "https://example.com" }));
});

test("fetches the combined data in a single request", async () => {
  const { fetch, calls } = mockFetch(() => htmlResponse(nextFlightHtml(payload)));
  const result = await fetchAllPageData("https://example.com", { fetch });
  expect(calls).toHaveLength(1);
  expect(result).toEqual(parseAllPageData(nextFlightHtml(payload)));
});

test("parses the first matching RSC props directly from HTML", async () => {
  const schema = z.object({ id: z.number() }).transform(({ id }) => String(id));
  await expect(parseFirstMatchingNextRscProps(nextFlightHtml(payload), { schema })).resolves.toBe(
    "7",
  );
  await expect(
    parseFirstMatchingNextRscProps(nextFlightHtml(payload), {
      schema: z.object({ missing: z.string() }),
      url: "https://example.com",
    }),
  ).rejects.toMatchObject({ code: "NO_MATCH", url: "https://example.com" });
});
