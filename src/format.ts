import type { DocKind } from "../server/scrape.ts";

const numberFormat = new Intl.NumberFormat();

export const formatNumber = (n: number) => numberFormat.format(n);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export const KIND_LABELS: Record<DocKind, string> = {
  json: "JSON script",
  rsc: "RSC props",
  network: "Network",
  html: "HTML",
};

/** Shortens `s` to `max` characters by eliding its middle. */
function elideMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/**
 * Compact display form of a URL: no protocol or `www.`, host plus the first and last path
 * segments, and the query (abridged when long). Show the full URL in a tooltip alongside it.
 */
export function abridgeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.host.replace(/^www\./, "");
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => elideMiddle(segment, 32));
  const path =
    segments.length > 2
      ? `/${segments[0]}/…/${segments.at(-1)}`
      : segments.map((segment) => `/${segment}`).join("");
  // Raw query text, so escapes and `+` show as they appear in the URL.
  const params = parsed.search.slice(1).split("&").filter(Boolean);
  const query =
    parsed.search.length <= 40
      ? parsed.search
      : `?${elideMiddle(params[0]!, 32)}${params.length > 1 ? "&…" : ""}`;
  return host + path + query;
}
