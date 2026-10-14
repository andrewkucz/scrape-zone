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
        <a
          className="github-link"
          href="https://github.com/andrewkucz/scrape-zone"
          target="_blank"
          rel="noreferrer"
          aria-label="scrape zone on GitHub"
          title="View source on GitHub"
        >
          <svg viewBox="0 0 19 19" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
              d="M9.356 1.85C5.05 1.85 1.57 5.356 1.57 9.694a7.84 7.84 0 0 0 5.324 7.44c.387.079.528-.168.528-.376 0-.182-.013-.805-.013-1.454-2.165.467-2.616-.935-2.616-.935-.349-.91-.864-1.143-.864-1.143-.71-.48.051-.48.051-.48.787.051 1.2.805 1.2.805.695 1.194 1.817.857 2.268.649.064-.507.27-.857.49-1.052-1.728-.182-3.545-.857-3.545-3.87 0-.857.31-1.558.8-2.104-.078-.195-.349-1 .077-2.078 0 0 .657-.208 2.14.805a7.5 7.5 0 0 1 1.946-.26c.657 0 1.328.092 1.946.26 1.483-1.013 2.14-.805 2.14-.805.426 1.078.155 1.883.078 2.078.502.546.799 1.247.799 2.104 0 3.013-1.818 3.675-3.558 3.87.284.247.528.714.528 1.454 0 1.052-.012 1.896-.012 2.156 0 .208.142.455.528.377a7.84 7.84 0 0 0 5.324-7.441c.013-4.338-3.48-7.844-7.773-7.844"
            />
          </svg>
        </a>
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
