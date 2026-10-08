import type { DocKind } from "../../server/scrape.ts";
import { foldCase } from "./fold.ts";
import type { Snippet, SnippetLine, WorkerRequest, WorkerResponse } from "./protocol.ts";

/**
 * Search index. Each document is case-folded once up front and gets a table of
 * line start offsets, so a query is a native `indexOf` scan over one flat
 * string (very fast, no per-line allocation) plus a binary search to turn a
 * match offset into a line number. Only lines that make it into the result
 * set are ever sliced out of the source text.
 */
interface IndexedDoc {
  id: string;
  kind: DocKind;
  text: string;
  folded: string;
  lineStarts: Uint32Array;
}

const MAX_LINE = 400;
const LEAD = 120;

let generation = 0;
let docs: IndexedDoc[] = [];

function buildLineStarts(text: string): Uint32Array {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  const starts = new Uint32Array(count);
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts[n++] = i + 1;
  return starts;
}

/** Index of the last line start <= pos, searching from `lo` upward. */
function lineOf(starts: Uint32Array, pos: number, lo: number): number {
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lineBounds(doc: IndexedDoc, line: number): [number, number] {
  const start = doc.lineStarts[line]!;
  const next = doc.lineStarts[line + 1];
  return [start, next === undefined ? doc.text.length : next - 1];
}

function contextLine(doc: IndexedDoc, line: number, from: number): SnippetLine | null {
  if (line < 0 || line >= doc.lineStarts.length) return null;
  const [start, end] = lineBounds(doc, line);
  const offset = end - start > MAX_LINE ? Math.min(from, end - start) : 0;
  const sliceEnd = Math.min(end, start + offset + MAX_LINE);
  return {
    no: line,
    text: doc.text.slice(start + offset, sliceEnd),
    clippedStart: offset > 0,
    clippedEnd: sliceEnd < end,
  };
}

function buildSnippet(doc: IndexedDoc, line: number, needle: string): Snippet {
  const [start, end] = lineBounds(doc, line);
  const ranges: Array<[number, number]> = [];
  for (
    let i = doc.folded.indexOf(needle, start);
    i !== -1 && i + needle.length <= end;
    i = doc.folded.indexOf(needle, i + needle.length)
  ) {
    ranges.push([i - start, i - start + needle.length]);
  }

  // Long (often minified) lines are windowed around the first match.
  const length = end - start;
  const offset =
    length > MAX_LINE ? Math.max(0, Math.min(ranges[0]![0] - LEAD, length - MAX_LINE)) : 0;
  const windowEnd = Math.min(length, offset + MAX_LINE);
  const visible = ranges
    .filter(([a, b]) => b > offset && a < windowEnd)
    .map(([a, b]): [number, number] => [
      Math.max(a, offset) - offset,
      Math.min(b, windowEnd) - offset,
    ]);

  return {
    docId: doc.id,
    line,
    before: contextLine(doc, line - 1, offset),
    match: {
      no: line,
      text: doc.text.slice(start + offset, start + windowEnd),
      clippedStart: offset > 0,
      clippedEnd: windowEnd < length,
      ranges: visible,
    },
    after: contextLine(doc, line + 1, offset),
  };
}

function search(query: string, kinds: DocKind[], limit: number) {
  const needle = foldCase(query);
  const allowed = new Set(kinds);
  const snippets: Snippet[] = [];
  const docMatches: Array<{ docId: string; count: number }> = [];
  let totalMatches = 0;
  let truncated = false;

  for (const doc of docs) {
    if (!allowed.has(doc.kind)) continue;
    const { folded, lineStarts } = doc;
    let count = 0;
    let lastLine = -1;
    for (
      let pos = folded.indexOf(needle);
      pos !== -1;
      pos = folded.indexOf(needle, pos + needle.length)
    ) {
      count++;
      if (truncated) continue; // keep counting, stop building snippets
      const line = lineOf(lineStarts, pos, Math.max(lastLine, 0));
      if (line === lastLine) continue;
      if (snippets.length >= limit) {
        truncated = true;
        continue;
      }
      snippets.push(buildSnippet(doc, line, needle));
      lastLine = line;
    }
    if (count > 0) {
      docMatches.push({ docId: doc.id, count });
      totalMatches += count;
    }
  }

  return { snippets, docMatches, totalMatches, truncated };
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "load") {
    generation = msg.generation;
    docs = msg.docs.map((d) => ({
      ...d,
      folded: foldCase(d.text),
      lineStarts: buildLineStarts(d.text),
    }));
    return;
  }

  const start = performance.now();
  const found = msg.query
    ? search(msg.query, msg.kinds, msg.limit)
    : { snippets: [], docMatches: [], totalMatches: 0, truncated: false };
  const response: WorkerResponse = {
    type: "result",
    result: {
      generation,
      query: msg.query,
      ...found,
      ms: performance.now() - start,
    },
  };
  self.postMessage(response);
});
