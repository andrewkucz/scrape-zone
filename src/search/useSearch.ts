import { useEffect, useRef, useState } from "react";
import type { DocKind, ScrapedDoc } from "../../server/scrape.ts";
import type { SearchResult, WorkerRequest, WorkerResponse } from "./protocol.ts";

const RESULT_LIMIT = 2000;

type SearchRequest = Extract<WorkerRequest, { type: "search" }>;

/**
 * Runs searches in a Web Worker so typing never blocks on scanning megabytes
 * of text. Requests are coalesced: while one search is in flight, only the
 * most recent pending query is kept, so fast typing never builds a backlog.
 */
export function useSearch(docs: ScrapedDoc[] | undefined, query: string, kinds: DocKind[]) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const pendingRef = useRef<SearchRequest | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      busyRef.current = false;
      const next = pendingRef.current;
      if (next) {
        pendingRef.current = null;
        busyRef.current = true;
        worker.postMessage(next);
      } else {
        setSearching(false);
      }
      // Ignore results computed against a previous page's documents.
      if (event.data.result.generation === generationRef.current) setResult(event.data.result);
    });
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!docs) return;
    const generation = ++generationRef.current;
    const msg: WorkerRequest = {
      type: "load",
      generation,
      docs: docs.map(({ id, kind, text }) => ({ id, kind, text })),
    };
    workerRef.current?.postMessage(msg);
    setResult(null);
  }, [docs]);

  const kindsKey = kinds.join(",");
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || !docs) return;
    const msg: SearchRequest = {
      type: "search",
      generation: generationRef.current,
      query,
      kinds: kindsKey ? (kindsKey.split(",") as DocKind[]) : [],
      limit: RESULT_LIMIT,
    };
    setSearching(true);
    if (busyRef.current) {
      pendingRef.current = msg;
    } else {
      busyRef.current = true;
      worker.postMessage(msg);
    }
  }, [docs, query, kindsKey]);

  // While a new search runs, the previous result stays visible to avoid flicker.
  return { result, searching };
}
