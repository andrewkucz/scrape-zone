import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import type { DocKind } from "../server/scrape.ts";
import { fetchNetwork, fetchScrape } from "./api.ts";
import { DocDialog } from "./components/DocDialog.tsx";
import { NetworkCapture } from "./components/NetworkCapture.tsx";
import { ResultsList, type OpenTarget } from "./components/ResultsList.tsx";
import { formatNumber, KIND_LABELS } from "./format.ts";
import { useSearch } from "./search/useSearch.ts";

const ALL_KINDS: DocKind[] = ["json", "rsc", "network", "html"];
const EMPTY_COUNTS: Record<DocKind, number> = { json: 0, rsc: 0, network: 0, html: 0 };

function readUrlParam() {
  return new URLSearchParams(window.location.search).get("url") ?? "";
}

export function App() {
  const [input, setInput] = useState(readUrlParam);
  const [url, setUrl] = useState(readUrlParam);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<DocKind[]>(ALL_KINDS);
  const [target, setTarget] = useState<OpenTarget | null>(null);
  /** The URL the user asked to run a network capture for. */
  const [networkUrl, setNetworkUrl] = useState<string | null>(null);

  const scrape = useQuery({
    queryKey: ["scrape", url],
    queryFn: ({ signal }) => fetchScrape(url, signal),
    enabled: url !== "",
    staleTime: Infinity,
    retry: false,
  });

  const network = useQuery({
    queryKey: ["network", url],
    queryFn: ({ signal }) => fetchNetwork(url, signal),
    enabled: url !== "" && networkUrl === url,
    staleTime: Infinity,
    retry: false,
  });

  const captureNetwork = () => {
    if (networkUrl === url) void network.refetch();
    else setNetworkUrl(url);
  };

  // Network docs slot in before the HTML so each kind stays one contiguous section.
  const docs = useMemo(() => {
    const page = scrape.data?.docs;
    const captured = network.data?.docs;
    if (!page || !captured?.length) return page;
    return [
      ...page.filter((d) => d.kind !== "html"),
      ...captured,
      ...page.filter((d) => d.kind === "html"),
    ];
  }, [scrape.data, network.data]);
  const { result, searching } = useSearch(docs, query, kinds);

  const docById = useMemo(() => new Map(docs?.map((d) => [d.id, d])), [docs]);
  const visibleDocs = useMemo(
    () => docs?.filter((d) => kinds.includes(d.kind)) ?? [],
    [docs, kinds],
  );

  const docsByKind = useMemo(() => {
    const counts = { ...EMPTY_COUNTS };
    for (const d of docs ?? []) counts[d.kind]++;
    return counts;
  }, [docs]);

  const matchesByKind = useMemo(() => {
    const counts = { ...EMPTY_COUNTS };
    for (const m of result?.docMatches ?? []) counts[docById.get(m.docId)!.kind] += m.count;
    return counts;
  }, [result, docById]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = input.trim();
    if (!next) return;
    const params = new URLSearchParams({ url: next });
    window.history.replaceState(null, "", `?${params}`);
    if (next === url) void scrape.refetch();
    else setUrl(next);
  };

  const toggleKind = (kind: DocKind) =>
    setKinds((prev) =>
      prev.includes(kind)
        ? prev.filter((k) => k !== kind)
        : ALL_KINDS.filter((k) => k === kind || prev.includes(k)),
    );

  const onOpen = useCallback((t: OpenTarget) => setTarget(t), []);
  const onClose = useCallback(() => setTarget(null), []);

  const hasQuery = query !== "";

  return (
    <div className="app">
      <header className="top">
        <h1>
          scrape<span>zone</span>
        </h1>
        <form className="url-form" onSubmit={submit}>
          <input
            type="text"
            inputMode="url"
            placeholder="https://example.com"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus={!url}
            aria-label="Page URL"
          />
          <button type="submit" disabled={scrape.isFetching}>
            {scrape.isFetching ? "Scraping…" : "Scrape"}
          </button>
        </form>
      </header>

      {scrape.isError && (
        <div className="error">
          <strong>{"code" in scrape.error ? String(scrape.error.code) : "Error"}</strong>{" "}
          {scrape.error.message}
        </div>
      )}

      {scrape.data && (
        <>
          <section className="toolbar">
            <input
              type="search"
              className="search"
              placeholder="Filter payloads and HTML…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              aria-label="Search"
            />
            <div className="chips">
              {ALL_KINDS.filter((kind) => kind !== "network" || network.data).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={kinds.includes(kind) ? "chip active" : "chip"}
                  aria-pressed={kinds.includes(kind)}
                  onClick={() => toggleKind(kind)}
                >
                  <span className={`dot dot-${kind}`} />
                  {KIND_LABELS[kind]}
                  <span className="chip-count">
                    {hasQuery ? formatNumber(matchesByKind[kind]) : formatNumber(docsByKind[kind])}
                  </span>
                </button>
              ))}
            </div>
            <div className="status">
              <span>
                {hasQuery && result ? (
                  <>
                    {formatNumber(result.totalMatches)} matches in{" "}
                    {formatNumber(result.docMatches.length)} payloads · {result.ms.toFixed(1)} ms
                    {result.truncated && (
                      <> · showing first {formatNumber(result.snippets.length)} lines</>
                    )}
                    {searching && " · searching…"}
                  </>
                ) : (
                  <>
                    {formatNumber(visibleDocs.length)} payloads · fetched in{" "}
                    {formatNumber(scrape.data.fetchMs)} ms · formatted in{" "}
                    {formatNumber(scrape.data.formatMs)} ms
                  </>
                )}
              </span>
              <NetworkCapture network={network} onCapture={captureNetwork} />
            </div>
          </section>

          <ResultsList
            docs={visibleDocs}
            docById={docById}
            result={hasQuery ? result : null}
            onOpen={onOpen}
          />
        </>
      )}

      {!scrape.data && !scrape.isError && (
        <div className="placeholder">
          {scrape.isFetching
            ? "Fetching and parsing page…"
            : "Enter a URL to extract JSON script tags, Next.js RSC props and the remaining HTML."}
        </div>
      )}

      {target && scrape.data && (
        <DocDialog
          key={`${target.doc.id}:${target.line}`}
          target={target}
          query={query}
          sourceUrl={scrape.data.url}
          onClose={onClose}
        />
      )}
    </div>
  );
}
