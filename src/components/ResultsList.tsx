import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type { DocKind, ScrapedDoc } from "../../server/scrape.ts";
import { formatBytes, formatNumber } from "../format.ts";
import type { SearchResult, Snippet, SnippetLine } from "../search/protocol.ts";
import { Highlight } from "./Highlight.tsx";

export interface OpenTarget {
  doc: ScrapedDoc;
  line: number;
}

type Row =
  | { type: "section"; key: string; kind: DocKind; payloads: number; matches: number | null }
  | { type: "doc"; key: string; doc: ScrapedDoc }
  | { type: "header"; key: string; doc: ScrapedDoc; count: number }
  | { type: "snippet"; key: string; doc: ScrapedDoc; snippet: Snippet };

interface ResultsListProps {
  docs: ScrapedDoc[];
  docById: Map<string, ScrapedDoc>;
  /** null when there is no query: every document is listed instead. */
  result: SearchResult | null;
  onOpen: (target: OpenTarget) => void;
}

const PREVIEW_LINES = 4;
const PREVIEW_WIDTH = 240;

const SECTION_LABELS: Record<DocKind, string> = {
  json: "JSON scripts",
  rsc: "RSC props",
  network: "Network requests",
  html: "HTML",
};

function onActivate(handler: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: handler,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    },
  };
}

/**
 * Inserts a section row whenever the document kind changes. Docs (and the
 * snippets the worker returns) are already in kind order, so each kind forms
 * one contiguous section.
 */
function buildRows(
  docs: ScrapedDoc[],
  docById: Map<string, ScrapedDoc>,
  result: SearchResult | null,
) {
  const rows: Row[] = [];
  let section: Extract<Row, { type: "section" }> | null = null;
  const enterSection = (kind: DocKind) => {
    if (section?.kind === kind) return section;
    section = { type: "section", key: `k:${kind}`, kind, payloads: 0, matches: result ? 0 : null };
    rows.push(section);
    return section;
  };

  if (!result) {
    for (const doc of docs) {
      enterSection(doc.kind).payloads++;
      rows.push({ type: "doc", key: doc.id, doc });
    }
    return rows;
  }

  const counts = new Map(result.docMatches.map((m) => [m.docId, m.count]));
  let lastDoc = "";
  for (const snippet of result.snippets) {
    const doc = docById.get(snippet.docId)!;
    const current = enterSection(doc.kind);
    if (snippet.docId !== lastDoc) {
      const count = counts.get(doc.id) ?? 0;
      current.payloads++;
      current.matches! += count;
      rows.push({ type: "header", key: `h:${doc.id}`, doc, count });
      lastDoc = snippet.docId;
    }
    rows.push({ type: "snippet", key: `s:${doc.id}:${snippet.line}`, doc, snippet });
  }
  return rows;
}

export function ResultsList({ docs, docById, result, onOpen }: ResultsListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildRows(docs, docById, result), [docs, docById, result]);
  const sectionIndexes = useMemo(
    () => rows.flatMap((row, i) => (row.type === "section" ? [i] : [])),
    [rows],
  );

  // The section containing the first visible row is always rendered (even when
  // scrolled out of the virtual range) so it can stick to the top.
  const activeSectionRef = useRef(0);
  const rangeExtractor = useCallback(
    (range: Range) => {
      activeSectionRef.current = sectionIndexes.findLast((i) => i <= range.startIndex) ?? 0;
      const indexes = defaultRangeExtractor(range);
      return indexes.includes(activeSectionRef.current)
        ? indexes
        : [activeSectionRef.current, ...indexes];
    },
    [sectionIndexes],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ESTIMATED_SIZES[rows[i]!.type],
    getItemKey: (i) => rows[i]!.key,
    rangeExtractor,
    overscan: 8,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [result?.query]);

  return (
    <div ref={scrollRef} className="results">
      {rows.length === 0 && result && <div className="empty">No matches for “{result.query}”</div>}
      <div className="results-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const sticky = row.type === "section" && item.index === activeSectionRef.current;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={sticky ? "results-row is-sticky" : "results-row"}
              style={sticky ? undefined : { transform: `translateY(${item.start}px)` }}
            >
              {row.type === "section" && <SectionHeader row={row} />}
              {row.type === "doc" && <DocCard doc={row.doc} onOpen={onOpen} />}
              {row.type === "header" && (
                <GroupHeader doc={row.doc} count={row.count} onOpen={onOpen} />
              )}
              {row.type === "snippet" && (
                <SnippetView doc={row.doc} snippet={row.snippet} onOpen={onOpen} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ESTIMATED_SIZES: Record<Row["type"], number> = {
  section: 40,
  doc: 130,
  header: 40,
  snippet: 76,
};

function SectionHeader({ row }: { row: Extract<Row, { type: "section" }> }) {
  return (
    <div className="section-header">
      <span className={`dot dot-${row.kind}`} />
      <span className="section-title">{SECTION_LABELS[row.kind]}</span>
      <span className="meta">
        {row.matches === null
          ? `${formatNumber(row.payloads)} ${row.payloads === 1 ? "payload" : "payloads"}`
          : `${formatNumber(row.matches)} ${row.matches === 1 ? "match" : "matches"} in ${formatNumber(row.payloads)} ${row.payloads === 1 ? "payload" : "payloads"}`}
      </span>
    </div>
  );
}

function DocIndex({ doc }: { doc: ScrapedDoc }) {
  return doc.kind === "html" ? null : <span className="doc-index">#{doc.index}</span>;
}

const DocCard = memo(function DocCard({
  doc,
  onOpen,
}: {
  doc: ScrapedDoc;
  onOpen: ResultsListProps["onOpen"];
}) {
  const preview = useMemo(() => {
    const lines: string[] = [];
    let start = 0;
    while (lines.length < PREVIEW_LINES && start <= doc.text.length) {
      const nl = doc.text.indexOf("\n", start);
      const end = nl === -1 ? doc.text.length : nl;
      lines.push(
        end - start > PREVIEW_WIDTH
          ? `${doc.text.slice(start, start + PREVIEW_WIDTH)}…`
          : doc.text.slice(start, end),
      );
      if (nl === -1) break;
      start = nl + 1;
    }
    return lines;
  }, [doc]);

  return (
    <div className="card doc-card" {...onActivate(() => onOpen({ doc, line: 0 }))}>
      <div className="card-head">
        <DocIndex doc={doc} />
        <span className="label">{doc.label}</span>
        <span className="meta">
          {formatBytes(doc.bytes)} · {formatNumber(doc.lines)} lines
        </span>
      </div>
      <pre className="code">
        {preview.map((line, i) => (
          <div key={i} className="code-line">
            <span className="gutter">{i + 1}</span>
            <span className="text">{line}</span>
          </div>
        ))}
        {doc.lines > PREVIEW_LINES && (
          <div className="code-more">… {formatNumber(doc.lines - PREVIEW_LINES)} more lines</div>
        )}
      </pre>
    </div>
  );
});

function GroupHeader({
  doc,
  count,
  onOpen,
}: {
  doc: ScrapedDoc;
  count: number;
  onOpen: ResultsListProps["onOpen"];
}) {
  return (
    <div className="group-header" {...onActivate(() => onOpen({ doc, line: 0 }))}>
      <DocIndex doc={doc} />
      <span className="label">{doc.label}</span>
      <span className="meta">
        {formatNumber(count)} {count === 1 ? "match" : "matches"} · {formatBytes(doc.bytes)}
      </span>
    </div>
  );
}

function CodeLine({ line, isMatch }: { line: SnippetLine; isMatch?: boolean }) {
  return (
    <div className={isMatch ? "code-line is-match" : "code-line"}>
      <span className="gutter">{line.no + 1}</span>
      <span className="text">
        {line.clippedStart && <span className="clip">…</span>}
        <Highlight text={line.text} ranges={line.ranges ?? []} />
        {line.clippedEnd && <span className="clip">…</span>}
      </span>
    </div>
  );
}

const SnippetView = memo(function SnippetView({
  doc,
  snippet,
  onOpen,
}: {
  doc: ScrapedDoc;
  snippet: Snippet;
  onOpen: ResultsListProps["onOpen"];
}) {
  return (
    <pre className="code snippet" {...onActivate(() => onOpen({ doc, line: snippet.line }))}>
      {snippet.before && <CodeLine line={snippet.before} />}
      <CodeLine line={snippet.match} isMatch />
      {snippet.after && <CodeLine line={snippet.after} />}
    </pre>
  );
});
