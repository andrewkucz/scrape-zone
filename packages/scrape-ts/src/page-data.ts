import { type FetchOptions, fetchHtml } from "./fetch-html.ts";
import { readHtmlScripts, removeHtmlScripts } from "./html-scripts.ts";
import { parseJsonScriptPayloads } from "./json-script.ts";
import {
  collectAllNextRscProps,
  type ParseNextRscChunksOptions,
  parseNextRscScriptPayloads,
} from "./rsc.ts";

export interface PageData {
  /** All successfully parsed JSON / JSON-LD script values, in document order. */
  jsonScripts: unknown[];
  /** All RSC element props, in breadth-first order per model chunk. */
  nextRscProps: unknown[];
  /** Original HTML with successfully consumed data scripts removed. */
  html: string;
}

/**
 * Parses all JSON scripts and Next.js RSC props without schema validation.
 * Removes parsed JSON scripts and scripts supplying type-1 Flight fragments;
 * all other HTML is preserved verbatim. Missing RSC data yields an empty array.
 * Malformed JSON is skipped and retained; Flight parsing errors are thrown.
 */
export function parseAllPageData(html: string, options: ParseNextRscChunksOptions = {}): PageData {
  const scripts = readHtmlScripts(html);
  const json = parseJsonScriptPayloads(scripts);
  const rsc = parseNextRscScriptPayloads(scripts, options, true);
  return {
    jsonScripts: json.values,
    nextRscProps: collectAllNextRscProps(rsc.chunks),
    html: removeHtmlScripts(html, new Set([...json.scripts, ...rsc.scripts])),
  };
}

/** Fetches one page and parses all data payloads plus the remaining HTML. */
export async function fetchAllPageData(
  url: string | URL,
  options: FetchOptions = {},
): Promise<PageData> {
  const page = await fetchHtml(url, options);
  return parseAllPageData(page.html, { url: page.url });
}
