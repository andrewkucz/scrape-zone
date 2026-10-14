export type ScrapeErrorCode =
  /** The URL could not be parsed. */
  | "INVALID_URL"
  /** The URL used a protocol other than `http:` or `https:`. */
  | "UNSUPPORTED_PROTOCOL"
  /** The request did not complete before `timeoutMs` elapsed. */
  | "TIMEOUT"
  /** The request was aborted by the caller's `signal`. */
  | "ABORTED"
  /** The fetch implementation threw (network error, DNS failure, ...). */
  | "FETCH_FAILED"
  /** The server responded with a non-2xx status. */
  | "HTTP_ERROR"
  /** The server responded with a non-HTML content type. */
  | "NOT_HTML"
  /** No candidate on the page satisfied the provided schema. */
  | "NO_MATCH"
  /** The page does not contain any Next.js Flight data. */
  | "RSC_NOT_FOUND"
  /** Next.js Flight push calls were found but none could be parsed. */
  | "SCRIPT_PARSE_FAILED"
  /** The reconstructed Flight payload could not be decoded. */
  | "RSC_PARSE_FAILED";

export interface ScrapeErrorOptions {
  cause?: unknown;
  url?: string;
  status?: number;
}

export class ScrapeError extends Error {
  public override readonly name = "ScrapeError";
  public readonly code: ScrapeErrorCode;
  /** The URL being scraped (the final URL after redirects when known). */
  public readonly url?: string;
  /** The HTTP status of the response, when one was received. */
  public readonly status?: number;

  constructor(message: string, code: ScrapeErrorCode, options: ScrapeErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.code = code;
    this.url = options.url;
    this.status = options.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isScrapeError(error: unknown, code?: ScrapeErrorCode): error is ScrapeError {
  return error instanceof ScrapeError && (code === undefined || error.code === code);
}
