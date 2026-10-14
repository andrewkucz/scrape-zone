import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  fetchAllNextRscProps,
  fetchNextRscChunks,
  fetchFirstMatchingNextRscProps,
  collectAllNextRscProps,
  findFirstMatchingNextRscProps,
  parseNextRscChunks,
} from "../src/index.ts";
import { htmlResponse, mockFetch, nextFlightHtml } from "./helpers.ts";

const payload = [
  '1:{"meta":"value"}',
  '0:["$","div",null,{"className":"root","children":[["$","header",null,{"title":"Hi"}],["$","section",null,{"initialData":{"store":{"name":"Acme"},"handle":"acme"},"children":"content"}]]}]',
  "",
].join("\n");

const html = nextFlightHtml(payload);

describe("parseNextRscChunks", () => {
  test("decodes model chunks grouped by type", () => {
    const chunks = parseNextRscChunks(html);

    expect(chunks.model).toHaveLength(2);
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
  test("findFirstMatchingNextRscProps locates nested element props", async () => {
    const result = await findFirstMatchingNextRscProps(parseNextRscChunks(html), schema);
    expect(result?.value.initialData.store.name).toBe("Acme");
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

test("findFirstMatchingNextRscProps returns undefined when nothing matches", async () => {
  const result = await findFirstMatchingNextRscProps(
    parseNextRscChunks(html),
    z.object({ nope: z.string() }),
  );
  expect(result).toBeUndefined();
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
  expect(props).toHaveLength(3);
  expect(props[0]).toMatchObject({ className: "root" });
  expect(props[1]).toEqual({ title: "Hi" });
  expect(props[2]).toMatchObject({ initialData: { handle: "acme" }, children: "content" });
});

test("fetchAllNextRscProps fetches and collects props", async () => {
  const { fetch } = mockFetch(() => htmlResponse(html));
  const props = await fetchAllNextRscProps("https://example.com", { fetch });
  expect(props).toHaveLength(3);
});
