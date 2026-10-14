import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  fetchFirstMatchingJsonScript,
  fetchAllJsonScripts,
  parseFirstMatchingJsonScript,
  parseAllJsonScripts,
  type StandardSchemaV1,
} from "../src/index.ts";
import { htmlResponse, mockFetch } from "./helpers.ts";

const page = `<html><head>
<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
<script type="application/ld+json">{ not json </script>
<script type="application/ld+json">{"@type":"VideoObject","name":"Line one
line two","duration":42}</script>
<script type="application/json" id="__DATA__">{"video":{"id":"abc"}}</script>
<script type="text/javascript">{"video":{"id":"ignored"}}</script>
</head></html>`;

const schemas: [string, StandardSchemaV1<unknown, { name: string; duration: number }>][] = [
  ["zod", z.object({ "@type": z.literal("VideoObject"), name: z.string(), duration: z.number() })],
  [
    "valibot",
    v.object({ "@type": v.literal("VideoObject"), name: v.string(), duration: v.number() }),
  ],
];

describe.each(schemas)("with %s", (_name, schema) => {
  test("returns the first JSON script block matching the schema", async () => {
    const data = await parseFirstMatchingJsonScript(page, { schema });
    expect(data).toMatchObject({ name: "Line one\nline two", duration: 42 });
  });

  test("fetchFirstMatchingJsonScript fetches and parses", async () => {
    const { fetch, calls } = mockFetch(() => htmlResponse(page));
    const data = await fetchFirstMatchingJsonScript("https://example.com/video", { schema, fetch });

    expect(data.duration).toBe(42);
    expect(calls[0]?.url).toBe("https://example.com/video");
  });
});

test("searches application/json scripts too", async () => {
  const { fetch } = mockFetch(() => htmlResponse(page));
  const data = await fetchFirstMatchingJsonScript("https://example.com", {
    fetch,
    schema: z.object({ video: z.object({ id: z.string() }) }),
  });

  expect(data.video.id).toBe("abc");
});

test("supports async schemas", async () => {
  const schema = z.object({ name: z.string() }).refine(async (value) => value.name === "Acme");
  await expect(parseFirstMatchingJsonScript(page, { schema })).resolves.toMatchObject({
    name: "Acme",
  });
});

test("throws NO_MATCH when nothing validates", async () => {
  const error = await parseFirstMatchingJsonScript(page, {
    schema: z.object({ missing: z.string() }),
    url: "https://example.com",
  }).catch((e: unknown) => e);

  expect(error).toMatchObject({ code: "NO_MATCH", url: "https://example.com" });
});

test("fetchAllJsonScripts fetches and returns every parseable block", async () => {
  const { fetch } = mockFetch(() => htmlResponse(page));
  await expect(fetchAllJsonScripts("https://example.com", { fetch })).resolves.toHaveLength(3);
});

test("parseAllJsonScripts returns every parseable block", () => {
  expect(parseAllJsonScripts(page)).toEqual([
    { "@type": "Organization", name: "Acme" },
    { "@type": "VideoObject", name: "Line one\nline two", duration: 42 },
    { video: { id: "abc" } },
  ]);
});
