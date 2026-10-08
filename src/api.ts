import { hc, type InferResponseType } from "hono/client";
import type { AppType } from "../server/app.ts";

const client = hc<AppType>("/");

export type ScrapeResponse = InferResponseType<typeof client.api.scrape.$get, 200>;
export type NetworkResponse = InferResponseType<typeof client.api.network.$get, 200>;

export class ScrapeRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function toError(res: { status: number; json(): Promise<unknown> }) {
  const body: unknown = await res.json().catch(() => null);
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
  return new ScrapeRequestError(
    error?.code ?? `HTTP_${res.status}`,
    error?.message ?? `Request failed with status ${res.status}`,
  );
}

export async function fetchScrape(url: string, signal?: AbortSignal): Promise<ScrapeResponse> {
  const res = await client.api.scrape.$get({ query: { url } }, { init: { signal } });
  if (res.status === 200) return res.json();
  throw await toError(res);
}

export async function fetchNetwork(url: string, signal?: AbortSignal): Promise<NetworkResponse> {
  const res = await client.api.network.$get({ query: { url } }, { init: { signal } });
  if (res.status === 200) return res.json();
  throw await toError(res);
}
