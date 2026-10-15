import { hc, type InferResponseType } from "hono/client";
import type { AppType } from "../server/app.ts";
import type { RequestOptions } from "../server/request.ts";
import { authClient } from "./auth.ts";

const client = hc<AppType>("/");

export type ScrapeResponse = InferResponseType<typeof client.api.scrape.$post, 200>;
export type NetworkResponse = InferResponseType<typeof client.api.network.$post, 200>;

/** A page URL plus the request options to fetch it with. */
export interface ScrapeRequest extends RequestOptions {
  url: string;
}
export type HistoryEntry = InferResponseType<
  typeof client.api.history.$get,
  200
>["entries"][number];

export class ScrapeRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function toError(res: { status: number; json(): Promise<unknown> }) {
  // The session expired or was revoked: re-check it so the app sends us to the login page.
  if (res.status === 401) authClient.$store.notify("$sessionSignal");
  const body: unknown = await res.json().catch(() => null);
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
  return new ScrapeRequestError(
    error?.code ?? `HTTP_${res.status}`,
    error?.message ?? `Request failed with status ${res.status}`,
  );
}

export async function fetchScrape(
  request: ScrapeRequest,
  signal?: AbortSignal,
): Promise<ScrapeResponse> {
  const res = await client.api.scrape.$post({ json: request }, { init: { signal } });
  if (res.status === 200) return res.json();
  throw await toError(res);
}

export async function fetchNetwork(
  request: ScrapeRequest,
  signal?: AbortSignal,
): Promise<NetworkResponse> {
  const res = await client.api.network.$post({ json: request }, { init: { signal } });
  if (res.status === 200) return res.json();
  throw await toError(res);
}

export async function fetchHistory(signal?: AbortSignal): Promise<HistoryEntry[]> {
  const res = await client.api.history.$get({}, { init: { signal } });
  if (res.status === 200) return (await res.json()).entries;
  throw await toError(res);
}

export async function deleteHistoryEntry(id: number): Promise<void> {
  const res = await client.api.history[":id"].$delete({ param: { id: String(id) } });
  if (!res.ok) throw await toError(res);
}
