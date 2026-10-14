# scrape-ts

Typed helpers for scraping structured data out of web pages:

- **JSON / JSON-LD `<script>` tags**: return the first `application/json` or `application/ld+json` block that matches your schema.
- **Next.js App Router (RSC / Flight) payloads**: decode the inline `self.__next_f.push(...)` data and search the React tree for props that match your schema.

Validation works with any [Standard Schema](https://standardschema.dev) library, including Zod, Valibot, ArkType and Effect Schema. Requests go through `fetch` by default, and you can pass in your own implementation.

```bash
npm install scrape-ts
```

Requires Node.js 20.3+ (or any runtime with `fetch`, `AbortSignal.any` and `AbortSignal.timeout`).

## All payloads and remaining HTML

```ts
import { parseAllPageData, fetchAllPageData } from "scrape-ts";

const { jsonScripts, nextRscProps, html } = parseAllPageData(originalHtml);
// jsonScripts: unknown[] — JSON / JSON-LD values in document order
// nextRscProps: unknown[] — element props in breadth-first order per model chunk
// html: string — the original HTML with consumed data scripts removed

const page = await fetchAllPageData("https://example.com");
```

`parseAllPageData` parses the HTML once and does not fetch or validate against a schema. It removes whole script tags containing successfully parsed JSON or type-1 Flight fragments. This includes every contributing script when a Flight payload spans multiple tags. The rest of the HTML is preserved exactly, including whitespace, entities, and attribute formatting; no minification or DOM reserialization occurs.

Malformed or empty JSON scripts, unrelated scripts, and Flight bootstrap-only scripts remain in the HTML. Missing JSON or RSC data produces empty arrays. Flight parsing follows the standalone decoder: malformed calls are skipped if usable payloads exist; otherwise parsing errors are reported, and decoding failures throw `ScrapeError`.

## API naming

- `fetch…` takes a URL and makes a request; `parse…` takes existing HTML, except `parseJsonValue`, which takes a JSON string.
- `All…` returns every payload without schema validation; `FirstMatching…` requires a schema and returns the first validated output.
- `…NextRscChunks` returns all decoded Flight chunks grouped by type.
- `collectAllNextRscProps(chunks)` and `findFirstMatchingNextRscProps(chunks, schema)` operate on already decoded chunks. The latter returns `{ value }` or `undefined`; HTML and URL schema helpers throw `NO_MATCH` when nothing matches.

## JSON / JSON-LD script tags

```ts
import { fetchFirstMatchingJsonScript } from "scrape-ts";
import { z } from "zod";

const video = await fetchFirstMatchingJsonScript("https://example.com/videos/123", {
  schema: z.object({
    "@type": z.literal("VideoObject"),
    name: z.string(),
    duration: z.string(),
  }),
});
// ^? { "@type": "VideoObject"; name: string; duration: string }
```

The function checks every `<script type="application/json">` and `<script type="application/ld+json">` block in document order and returns the first one that passes validation. It skips malformed blocks. If a block fails to parse because a string literal contains raw control characters, such as unescaped newlines in hand-written JSON-LD, it escapes them and tries again.

To get every JSON block on the page without validating any of them, use `fetchAllJsonScripts`:

```ts
import { fetchAllJsonScripts } from "scrape-ts";

const blocks = await fetchAllJsonScripts("https://example.com"); // unknown[]
```

## Next.js React Server Components

```ts
import { fetchFirstMatchingNextRscProps } from "scrape-ts";
import { type } from "arktype";

const { initialData } = await fetchFirstMatchingNextRscProps("https://example.com/store/acme", {
  schema: type({ initialData: { store: { name: "string" } } }),
});
```

This decodes the page's Flight payload and does a breadth-first walk of every model chunk. It returns the props of the first React element whose `props` pass validation.

To get the props of every React element in the tree without validating any of them, use `fetchAllNextRscProps`:

```ts
import { fetchAllNextRscProps } from "scrape-ts";

const allProps = await fetchAllNextRscProps("https://example.com"); // unknown[]
```

To get the raw decoded chunks, grouped by chunk type (`model`, `text`, `hint`, `module`, ...), use `fetchNextRscChunks`:

```ts
import { fetchNextRscChunks } from "scrape-ts";

const chunks = await fetchNextRscChunks("https://example.com");
for (const chunk of chunks.model) console.log(chunk.id, chunk.value);
```

## Working with HTML you already have

Each fetching helper has a pure counterpart that takes an HTML string and makes no network request:

| Fetches a URL                    | Parses HTML                                        |
| -------------------------------- | -------------------------------------------------- |
| `fetchFirstMatchingJsonScript`   | `parseFirstMatchingJsonScript(html, { schema })`   |
| `fetchAllJsonScripts`            | `parseAllJsonScripts(html)`                        |
| `fetchNextRscChunks`             | `parseNextRscChunks(html)`                         |
| `fetchFirstMatchingNextRscProps` | `parseFirstMatchingNextRscProps(html, { schema })` |
| `fetchAllNextRscProps`           | `parseAllNextRscProps(html)`                       |
| `fetchAllPageData`               | `parseAllPageData(html)`                           |
| `fetchHtml`                      | n/a                                                |

## Fetch options

All fetching helpers accept these options:

```ts
interface FetchOptions {
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Merged over the default browser-like headers (Accept, Accept-Language, User-Agent). */
  headers?: RequestInit["headers"];
  /** Abort the request. */
  signal?: AbortSignal;
  /** Request timeout in ms, or false to disable. Default: 15000. */
  timeoutMs?: number | false;
  /** Extra RequestInit fields (method, redirect, dispatcher, ...). */
  init?: Omit<RequestInit, "headers" | "signal">;
}
```

For example, to route requests through a proxy or a retrying client:

```ts
import { fetchFirstMatchingJsonScript } from "scrape-ts";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const dispatcher = new ProxyAgent("http://proxy:8080");

await fetchFirstMatchingJsonScript(url, {
  schema,
  fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }) as Promise<Response>,
});
```

## Errors

Every failure throws a `ScrapeError`, which has a `code` and, where available, the `url`, the HTTP `status`, and the underlying `cause`:

| Code                   | Meaning                                                |
| ---------------------- | ------------------------------------------------------ |
| `INVALID_URL`          | The URL could not be parsed                            |
| `UNSUPPORTED_PROTOCOL` | The URL was not `http:` or `https:`                    |
| `TIMEOUT`              | The request took longer than `timeoutMs`               |
| `ABORTED`              | The caller's `signal` aborted the request              |
| `FETCH_FAILED`         | The fetch implementation threw                         |
| `HTTP_ERROR`           | The response status was not 2xx                        |
| `NOT_HTML`             | The response `content-type` was not HTML               |
| `NO_MATCH`             | No candidate matched the schema                        |
| `RSC_NOT_FOUND`        | The page has no Next.js Flight data                    |
| `SCRIPT_PARSE_FAILED`  | Flight push calls were found, but none could be parsed |
| `RSC_PARSE_FAILED`     | The Flight payload could not be decoded                |

```ts
import { isScrapeError } from "scrape-ts";

try {
  await fetchFirstMatchingJsonScript(url, { schema });
} catch (error) {
  if (isScrapeError(error, "HTTP_ERROR") && error.status === 404) return null;
  throw error;
}
```

## Migration from 0.2

These are breaking export renames; the previous names are no longer exported. Update imports and calls using this table:

| Previous name                  | New name                                |
| ------------------------------ | --------------------------------------- |
| `extractJsonScriptData`        | `fetchFirstMatchingJsonScript`          |
| `parseJsonScriptData`          | `parseFirstMatchingJsonScript`          |
| `extractJsonScripts`           | `fetchAllJsonScripts`                   |
| `parseJsonScripts`             | `parseAllJsonScripts`                   |
| `parseJsonScript`              | `parseJsonValue`                        |
| `extractNextRscData`           | `fetchNextRscChunks`                    |
| `parseNextRscData`             | `parseNextRscChunks`                    |
| `extractNextRscProps`          | `fetchFirstMatchingNextRscProps`        |
| `extractAllNextRscProps`       | `fetchAllNextRscProps`                  |
| `findNextRscProps`             | `findFirstMatchingNextRscProps`         |
| `findAllNextRscProps`          | `collectAllNextRscProps`                |
| `ExtractJsonScriptDataOptions` | `FetchFirstMatchingJsonScriptOptions`   |
| `ParseJsonScriptDataOptions`   | `ParseFirstMatchingJsonScriptOptions`   |
| `ExtractNextRscPropsOptions`   | `FetchFirstMatchingNextRscPropsOptions` |
| `ParseNextRscDataOptions`      | `ParseNextRscChunksOptions`             |

`fetchHtml`, `isScrapeError`, the error class, and other types/constants keep their names. The new `parseAllNextRscProps` and `parseFirstMatchingNextRscProps` helpers accept HTML directly. Standalone RSC parsers still throw `RSC_NOT_FOUND` when no Flight payload exists; the combined page helper allows pages without RSC data.

## Development

```bash
vp install   # install dependencies
vp check     # format, lint, type check
vp test      # run tests
vp pack      # build to dist/
pnpm release # bump version and publish
```

## License

MIT
