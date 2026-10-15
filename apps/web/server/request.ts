// Shared with the client, so this module must stay free of server-only imports.

export const REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RequestMethod = (typeof REQUEST_METHODS)[number];

/** User-specified overrides for the page request. */
export interface RequestOptions {
  method: RequestMethod;
  /** Merged over the default browser-like headers. */
  headers: Record<string, string>;
  /** Ignored for GET requests. */
  body?: string;
  /** Route the request through the EU proxy. */
  proxy: boolean;
}

export const DEFAULT_REQUEST: RequestOptions = { method: "GET", headers: {}, proxy: false };
