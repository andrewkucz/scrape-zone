import type { NetworkRequestInfo } from "../server/scrape.ts";

/** Recomputed by the client, or meaningless outside the original connection. */
const SKIPPED_HEADERS = new Set(["content-length", "host", "connection"]);

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function replayableHeaders(request: NetworkRequestInfo) {
  return Object.entries(request.requestHeaders).filter(([name]) => !SKIPPED_HEADERS.has(name));
}

export function toCurl(request: NetworkRequestInfo): string {
  const parts = [`curl ${shellQuote(request.url)}`];
  if (request.method !== "GET") parts.push(`-X ${request.method}`);
  let compressed = false;
  for (const [name, value] of replayableHeaders(request)) {
    if (name === "accept-encoding") {
      compressed = true;
      continue;
    }
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (request.postData !== null) parts.push(`--data-raw ${shellQuote(request.postData)}`);
  if (compressed) parts.push("--compressed");
  return parts.join(" \\\n  ");
}

export function toFetch(request: NetworkRequestInfo): string {
  const init: Record<string, unknown> = {
    method: request.method,
    headers: Object.fromEntries(replayableHeaders(request)),
  };
  if (request.postData !== null) init.body = request.postData;
  return `await fetch(${JSON.stringify(request.url)}, ${JSON.stringify(init, null, 2)});`;
}

/** scrape-ts code that replays the request and decodes its framework-specific body. */
export function toScrapeTsParse(request: NetworkRequestInfo): string | null {
  const { parser } = request;
  if (!parser) return null;
  // The Remix deferred parser is async; the turbo-stream one is not.
  const call = parser === "parseTextRemixDeferredBody" ? `await ${parser}` : parser;
  return [
    `import { ${parser} } from "scrape-ts";`,
    "",
    `const response = ${toFetch(request)}`,
    `const data = ${call}(await response.text());`,
  ].join("\n");
}
