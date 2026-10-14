import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { abridgeUrl, formatBytes, formatNumber, KIND_LABELS } from "../format.ts";
import { findRanges, foldCase } from "../search/fold.ts";
import type { NetworkRequestInfo, ScrapedDoc } from "../../server/scrape.ts";
import { toCurl, toFetch } from "../requestCode.ts";
import { typegenMetaQuery } from "../typegen/client.ts";
import { Highlight } from "./Highlight.tsx";
import type { OpenTarget } from "./ResultsList.tsx";

// quicktype is big, so the panel is code-split and its worker is started on demand. Both are
// preloaded once a dialog that can generate types opens, so the tab is usually ready by the
// time it's clicked.
const loadTypegenPanel = () => import("../typegen/TypegenPanel.tsx");
const TypegenPanel = lazy(loadTypegenPanel);

/** Runs `fn` once the browser is idle so preloading never delays the contents view. */
function whenIdle(fn: () => void): () => void {
  if ("requestIdleCallback" in window) {
    const id = requestIdleCallback(fn, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
}

type Tab = "contents" | "types";

interface DocDialogProps {
  target: OpenTarget;
  query: string;
  sourceUrl: string;
  onClose: () => void;
}

/** Mount with a `key` per target; it opens itself as a modal on mount. */
export function DocDialog({ target, query, sourceUrl, onClose }: DocDialogProps) {
  const { doc } = target;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>("contents");
  // HTML isn't JSON, and neither is a network body that failed to parse.
  const canGenerate = doc.kind !== "html" && (doc.request?.parsed ?? true);

  const needle = foldCase(query);
  const lines = useMemo(() => doc.text.split("\n"), [doc]);

  const { matchLines, occurrences } = useMemo(() => {
    const matchLines: number[] = [];
    let occurrences = 0;
    if (!needle) return { matchLines, occurrences };
    for (let i = 0; i < lines.length; i++) {
      const folded = foldCase(lines[i]!);
      let found = false;
      for (
        let p = folded.indexOf(needle);
        p !== -1;
        p = folded.indexOf(needle, p + needle.length)
      ) {
        occurrences++;
        found = true;
      }
      if (found) matchLines.push(i);
    }
    return { matchLines, occurrences };
  }, [lines, needle]);

  const [current, setCurrent] = useState(() => {
    const i = matchLines.findIndex((l) => l >= target.line);
    return i === -1 ? 0 : i;
  });
  const activeLine = matchLines.length > 0 ? matchLines[current] : target.line;

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const queryClient = useQueryClient();
  useEffect(() => {
    if (!canGenerate) return;
    return whenIdle(() => {
      // The worker loads quicktype off the main thread; failures resurface when the tab opens.
      void loadTypegenPanel().catch(() => {});
      void queryClient.prefetchQuery(typegenMetaQuery);
    });
  }, [canGenerate, queryClient]);

  const { request } = doc;

  return (
    <dialog
      ref={dialogRef}
      className="doc-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) dialogRef.current?.close();
      }}
    >
      <header className="dialog-head">
        <h2 className="label">{doc.label}</h2>
        <button
          type="button"
          className="ghost"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <dl className="info">
        <div>
          <dt>Source</dt>
          <dd>{KIND_LABELS[doc.kind]}</dd>
        </div>
        <div>
          <dt>Index</dt>
          <dd>{doc.index}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(doc.bytes)}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>{formatNumber(doc.lines)}</dd>
        </div>
        <div>
          <dt>Matches</dt>
          <dd>
            {query
              ? `${formatNumber(occurrences)} on ${formatNumber(matchLines.length)} lines`
              : "—"}
          </dd>
        </div>
        {request ? (
          <>
            <div>
              <dt>Status</dt>
              <dd>
                {request.status} {request.statusText}
              </dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{request.resourceType}</dd>
            </div>
            {request.durationMs !== null && (
              <div>
                <dt>Time</dt>
                <dd>{formatNumber(request.durationMs)} ms</dd>
              </div>
            )}
            <div className="info-url">
              <dt>{request.method}</dt>
              <dd title={request.url}>{request.url}</dd>
            </div>
          </>
        ) : (
          <div className="info-url">
            <dt>Page</dt>
            <dd className="info-url-value">
              <span className="info-url-text" title={sourceUrl}>
                {/^https?:\/\//i.test(sourceUrl) ? (
                  <a href={sourceUrl} target="_blank" rel="noreferrer">
                    {abridgeUrl(sourceUrl)}
                  </a>
                ) : (
                  abridgeUrl(sourceUrl)
                )}
              </span>
              <CopyIconButton text={sourceUrl} label="Copy URL" />
            </dd>
          </div>
        )}
      </dl>

      {canGenerate && (
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "contents"}
            className={tab === "contents" ? "tab active" : "tab"}
            onClick={() => setTab("contents")}
          >
            Contents
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "types"}
            className={tab === "types" ? "tab active" : "tab"}
            onClick={() => setTab("types")}
          >
            Generate types
          </button>
        </div>
      )}

      {tab === "contents" ? (
        <ContentsView
          doc={doc}
          lines={lines}
          query={query}
          needle={needle}
          matchLines={matchLines}
          current={current}
          setCurrent={setCurrent}
          activeLine={activeLine}
        />
      ) : (
        <Suspense fallback={<div className="placeholder">Loading quicktype…</div>}>
          <TypegenPanel doc={doc} />
        </Suspense>
      )}
    </dialog>
  );
}

interface ContentsViewProps {
  doc: ScrapedDoc;
  lines: string[];
  query: string;
  needle: string;
  matchLines: number[];
  current: number;
  setCurrent: (update: (current: number) => number) => void;
  activeLine: number | undefined;
}

function ContentsView({
  doc,
  lines,
  query,
  needle,
  matchLines,
  current,
  setCurrent,
  activeLine,
}: ContentsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 20,
  });

  useEffect(() => {
    if (activeLine !== undefined && activeLine > 0)
      virtualizer.scrollToIndex(activeLine, { align: "center" });
  }, [activeLine, virtualizer]);

  const step = (delta: number) => {
    if (matchLines.length === 0) return;
    setCurrent((c) => (c + delta + matchLines.length) % matchLines.length);
  };
  const { request } = doc;

  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
  };
  const copyButton = (what: string, label: string, text: () => string) => (
    <button type="button" onClick={() => void copy(what, text())}>
      {copied === what ? "Copied!" : label}
    </button>
  );

  return (
    <>
      {request && <RequestDetails request={request} />}

      <div className="dialog-toolbar">
        {query && (
          <>
            <span className="meta">
              {matchLines.length > 0
                ? `Line ${formatNumber(current + 1)} of ${formatNumber(matchLines.length)} matching “${query}”`
                : `No matches for “${query}”`}
            </span>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={matchLines.length === 0}
              aria-label="Previous match"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={matchLines.length === 0}
              aria-label="Next match"
            >
              ↓
            </button>
          </>
        )}
        <span className="spacer" />
        {request && copyButton("curl", "Copy as cURL", () => toCurl(request))}
        {request && copyButton("fetch", "Copy as fetch", () => toFetch(request))}
        {copyButton("contents", request ? "Copy response" : "Copy contents", () => doc.text)}
      </div>

      <div ref={scrollRef} className="dialog-code code">
        <div className="results-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const text = lines[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={
                  item.index === activeLine && query
                    ? "code-line virtual-row is-match"
                    : "code-line virtual-row"
                }
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <span className="gutter">{item.index + 1}</span>
                <span className="text">
                  <Highlight text={text} ranges={findRanges(text, needle)} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  return (
    <table className="headers">
      <tbody>
        {Object.entries(headers).map(([name, value]) => (
          <tr key={name}>
            <th>{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RequestDetails({ request }: { request: NetworkRequestInfo }) {
  const requestCount = Object.keys(request.requestHeaders).length;
  const responseCount = Object.keys(request.responseHeaders).length;
  return (
    <div className="request-details">
      {!request.parsed && (
        <p className="warning">
          Response was labelled JSON but did not parse; showing the raw body.
        </p>
      )}
      <details>
        <summary>Request headers ({requestCount})</summary>
        <HeaderTable headers={request.requestHeaders} />
      </details>
      {request.postData !== null && (
        <details>
          <summary>Request body ({formatBytes(new Blob([request.postData]).size)})</summary>
          <pre className="code request-body">{request.postData}</pre>
        </details>
      )}
      <details>
        <summary>Response headers ({responseCount})</summary>
        <HeaderTable headers={request.responseHeaders} />
      </details>
    </div>
  );
}

/** Tiny icon button that copies `text`, briefly showing a check mark. */
function CopyIconButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      className="icon-button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied!" : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {copied ? (
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        ) : (
          <g fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
          </g>
        )}
      </svg>
    </button>
  );
}
