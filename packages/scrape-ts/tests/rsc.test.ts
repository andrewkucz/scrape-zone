import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  fetchRscData,
  fetchNextRscChunks,
  fetchFirstMatchingNextRscProps,
  collectAllNextRscProps,
  parseFirstMatchingNextRscProps,
  parseNextRscChunks,
  parseRscData,
} from "../src/index.ts";
import { htmlResponse, mockFetch, nextFlightHtml } from "./helpers.ts";

const jsonLd = JSON.stringify({ "@type": "Product", name: "Widget" });
const payload = [
  '1:{"meta":"value"}',
  '2:I["123",[],"StorePage"]',
  `0:["$","div",null,{"className":"root","children":[["$","header",null,{"title":"Hi"}],["$","script",null,{"type":"application/ld+json","dangerouslySetInnerHTML":{"__html":${JSON.stringify(jsonLd)}}}],["$","$L2",null,{"initialData":{"store":{"name":"Acme"},"handle":"acme"},"children":"content"}]]}]`,
  "",
].join("\n");

const html = nextFlightHtml(payload);

describe("parseNextRscChunks", () => {
  test("decodes model chunks grouped by type", () => {
    const chunks = parseNextRscChunks(html);

    expect(chunks.model).toHaveLength(2);
    expect(chunks.module).toHaveLength(1);
    expect(chunks.model.find((chunk) => chunk.id === "1")?.value).toEqual({ meta: "value" });
  });

  test("throws RSC_NOT_FOUND when the page has no flight data", () => {
    expect(() => parseNextRscChunks("<html><script>var x = 1</script></html>")).toThrow(
      expect.objectContaining({ code: "RSC_NOT_FOUND" }),
    );
  });

  test("throws SCRIPT_PARSE_FAILED when push calls are malformed", () => {
    expect(() => parseNextRscChunks("<script>self.__next_f.push([1, notJson])</script>")).toThrow(
      expect.objectContaining({ code: "SCRIPT_PARSE_FAILED" }),
    );
  });
});

describe.each([
  ["zod", z.object({ initialData: z.object({ store: z.object({ name: z.string() }) }) })],
  ["valibot", v.object({ initialData: v.object({ store: v.object({ name: v.string() }) }) })],
])("prop search with %s", (_name, schema) => {
  test("parseFirstMatchingNextRscProps searches client component props", async () => {
    const props = await parseFirstMatchingNextRscProps(html, { schema });
    expect(props.initialData.store.name).toBe("Acme");
  });

  test("fetchFirstMatchingNextRscProps fetches and searches", async () => {
    const { fetch } = mockFetch(() => htmlResponse(html));
    const props = await fetchFirstMatchingNextRscProps("https://example.com/acme", {
      fetch,
      schema,
    });
    expect(props.initialData.store.name).toBe("Acme");
  });
});

test("parseFirstMatchingNextRscProps searches JSON-LD blocks", async () => {
  const product = await parseFirstMatchingNextRscProps(html, {
    schema: z.object({ "@type": z.literal("Product"), name: z.string() }),
  });
  expect(product).toEqual({ "@type": "Product", name: "Widget" });
});

test("parseFirstMatchingNextRscProps searches host element props", async () => {
  await expect(
    parseFirstMatchingNextRscProps(html, { schema: z.object({ title: z.string() }) }),
  ).resolves.toEqual({ title: "Hi" });
});

test("parseFirstMatchingNextRscProps searches anonymous client component props", async () => {
  const anonymous = nextFlightHtml(
    '1:I["9",[],"default"]\n0:["$","main",null,{"children":["$","$L1",null,{"id":7}]}]\n',
  );
  await expect(
    parseFirstMatchingNextRscProps(anonymous, { schema: z.object({ id: z.number() }) }),
  ).resolves.toEqual({ id: 7 });
  expect(parseRscData(anonymous).other).toEqual([
    { type: 'default@"9"', route: "", props: { id: 7 } },
  ]);
});

test("parseFirstMatchingNextRscProps prefers named components over host elements", async () => {
  const props = await parseFirstMatchingNextRscProps(html, {
    schema: z.object({}).passthrough(),
  });
  expect(props).toEqual({ initialData: { store: { name: "Acme" }, handle: "acme" } });
});

test("fetchFirstMatchingNextRscProps throws NO_MATCH when nothing matches", async () => {
  const { fetch } = mockFetch(() => htmlResponse(html));
  await expect(
    fetchFirstMatchingNextRscProps("https://example.com", {
      fetch,
      schema: z.object({ nope: z.string() }),
    }),
  ).rejects.toMatchObject({ code: "NO_MATCH" });
});

test("fetchNextRscChunks fetches and decodes", async () => {
  const { fetch } = mockFetch(() => htmlResponse(html));
  const chunks = await fetchNextRscChunks("https://example.com", { fetch });
  expect(chunks.model).toHaveLength(2);
});

test("collectAllNextRscProps returns every element's props in breadth-first order", () => {
  const props = collectAllNextRscProps(parseNextRscChunks(html));
  expect(props).toHaveLength(4);
  expect(props[0]).toMatchObject({ className: "root" });
  expect(props[1]).toEqual({ title: "Hi" });
  expect(props[2]).toMatchObject({ type: "application/ld+json" });
  expect(props[3]).toMatchObject({ initialData: { handle: "acme" }, children: "content" });
});

test("parseRscData returns client components and JSON-LD", () => {
  const data = parseRscData(html);
  expect(data.components).toEqual({
    StorePage: {
      component: "StorePage",
      route: "",
      props: { initialData: { store: { name: "Acme" }, handle: "acme" } },
    },
  });
  expect(data.jsonLd).toEqual([{ "@type": "Product", name: "Widget" }]);
  // className is in the default dropProps, so the root div has no props of its own.
  expect(data.other).toEqual([{ type: "header", route: "", props: { title: "Hi" } }]);
  expect(data.detached).toHaveLength(1);
});

test("fetchRscData fetches and parses", async () => {
  const { fetch } = mockFetch(() => htmlResponse(html));
  const data = await fetchRscData("https://example.com", { fetch });
  expect(data).toEqual(parseRscData(html));
});
