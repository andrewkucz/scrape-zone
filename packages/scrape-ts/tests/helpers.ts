import type { FetchLike } from "../src/index.ts";

export function htmlResponse(html: string, init: ResponseInit & { url?: string } = {}): Response {
  const response = new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });

  if (init.url) {
    Object.defineProperty(response, "url", { value: init.url });
  }

  return response;
}

export function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };

  return { fetch, calls };
}

export function nextFlightHtml(payload: string): string {
  const push = JSON.stringify([1, payload]);
  return `<!doctype html><html><body>
<script>(self.__next_f=self.__next_f||[]).push([0])</script>
<script>self.__next_f.push(${push})</script>
</body></html>`;
}
