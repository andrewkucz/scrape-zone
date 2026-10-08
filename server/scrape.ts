import beautify from "js-beautify";
import { fetchAllPageData } from "scrape-ts";

export type DocKind = "json" | "rsc" | "network" | "html";

/** Everything needed to re-create a captured network request. */
export interface NetworkRequestInfo {
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  postData: string | null;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  durationMs: number | null;
  /** False when the response claimed to be JSON but did not parse; `text` is then the raw body. */
  parsed: boolean;
}

export interface ScrapedDoc {
  id: string;
  kind: DocKind;
  /** Position within its kind (document order for JSON, BFS order for RSC). */
  index: number;
  /** Short human-readable description, e.g. `@type: Product` or `{ className, children }`. */
  label: string;
  /** Pretty-printed contents. Searching and display both operate on this. */
  text: string;
  bytes: number;
  lines: number;
  /** Present for `network` docs. */
  request?: NetworkRequestInfo;
}

export interface ScrapeResult {
  url: string;
  fetchMs: number;
  formatMs: number;
  docs: ScrapedDoc[];
}

/**
 * JSON.stringify that survives what RSC props can contain: symbols
 * (`$$typeof`), bigints, functions and circular references.
 */
export function toPrettyJson(value: unknown): string {
  const ancestors: unknown[] = [];
  const out = JSON.stringify(
    value,
    function (this: unknown, _key, v: unknown) {
      switch (typeof v) {
        case "symbol":
          return v.toString();
        case "bigint":
          return `${v}n`;
        case "function":
          return `[Function ${v.name || "anonymous"}]`;
        case "object":
          if (v === null) return v;
          // `this` is the object holding the current key; trim the stack back to it.
          while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
          if (ancestors.includes(v)) return "[Circular]";
          ancestors.push(v);
          return v;
        default:
          return v;
      }
    },
    2,
  );
  return out ?? String(value);
}

function previewKeys(keys: string[], max = 4): string {
  const shown = keys.slice(0, max).join(", ");
  return keys.length > max ? `{ ${shown}, … }` : `{ ${shown} }`;
}

export function describe(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "string") return `string (${value.length} chars)`;
  if (value === null || typeof value !== "object") return String(value);
  const obj = value as Record<string, unknown>;
  const type = obj["@type"];
  if (typeof type === "string" || Array.isArray(type)) {
    return `@type: ${Array.isArray(type) ? type.join(", ") : type}`;
  }
  if (Array.isArray(obj["@graph"])) return `@graph (${obj["@graph"].length} items)`;
  const keys = Object.keys(obj);
  return keys.length === 0 ? "{}" : previewKeys(keys);
}

function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

export function makeDoc(kind: DocKind, index: number, label: string, text: string): ScrapedDoc {
  return {
    id: `${kind}-${index}`,
    kind,
    index,
    label,
    text,
    bytes: Buffer.byteLength(text),
    lines: countLines(text),
  };
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function scrape(url: string): Promise<ScrapeResult> {
  const fetchStart = performance.now();
  const { jsonScripts, nextRscProps, html } = await fetchAllPageData(url, { timeoutMs: 20_000 });
  const formatStart = performance.now();

  const docs: ScrapedDoc[] = [
    ...jsonScripts.map((v, i) => makeDoc("json", i, describe(v), toPrettyJson(v))),
    ...nextRscProps.map((v, i) => makeDoc("rsc", i, describe(v), toPrettyJson(v))),
    makeDoc(
      "html",
      0,
      "Remaining HTML",
      beautify.html(html, {
        indent_size: 2,
        wrap_line_length: 0,
        max_preserve_newlines: 1,
        indent_scripts: "keep",
      }),
    ),
  ];

  return {
    url,
    fetchMs: Math.round(formatStart - fetchStart),
    formatMs: Math.round(performance.now() - formatStart),
    docs,
  };
}
