import type { DocKind } from "../../server/scrape.ts";

export interface SnippetLine {
  /** 0-based line number within the document. */
  no: number;
  text: string;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Highlight ranges within `text` (match line only). */
  ranges?: Array<[number, number]>;
}

export interface Snippet {
  docId: string;
  line: number;
  before: SnippetLine | null;
  match: SnippetLine;
  after: SnippetLine | null;
}

export interface SearchResult {
  generation: number;
  query: string;
  snippets: Snippet[];
  /** Match count per document, in document order. Only documents with matches. */
  docMatches: Array<{ docId: string; count: number }>;
  totalMatches: number;
  /** True when more matching lines exist than `snippets` holds. */
  truncated: boolean;
  ms: number;
}

export type WorkerRequest =
  | {
      type: "load";
      generation: number;
      docs: Array<{ id: string; kind: DocKind; text: string }>;
    }
  | {
      type: "search";
      generation: number;
      query: string;
      kinds: DocKind[];
      limit: number;
    };

export type WorkerResponse = { type: "result"; result: SearchResult };
