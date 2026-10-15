/* oxlint-disable no-floating-promises, no-redundant-type-constituents -- copied from Remix */

// Parser for `text/remix-deferred` responses, the streaming format Remix v1/v2
// loaders use when they return `defer()`. The body is a JSON object of critical
// data followed by `data:{...}` / `error:{...}` sections (separated by blank
// lines) that resolve the `__deferred_promise:` placeholders, so it is not
// valid JSON as a whole.
//
// Adapted from Remix Run React and Router v2:
// https://github.com/remix-run/remix/blob/9989381a2c9c188071a08ef1aba4c49ce9db85c8/packages/remix-react/data.ts

/** Matches a `text/remix-deferred` Content-Type header value. */
export const TEXT_REMIX_DEFERRED_CONTENT_TYPE: RegExp = /\btext\/remix-deferred\b/i;

/**
 * Parses a `text/remix-deferred` response body (a Remix v1/v2 `defer()` loader
 * response) into the loader data, with every deferred promise replaced by the
 * value it resolved to.
 *
 * @param body - Response body as a `ReadableStream` or string.
 * @param abort - Optional abort signal used while resolving deferred data.
 * @returns The parsed and unwrapped loader data.
 * @throws If the body is malformed or a deferred value errored.
 */
export const parseTextRemixDeferredBody = async <T = unknown>(
  body: ReadableStream<Uint8Array> | string,
  abort?: AbortSignal,
): Promise<T> => {
  const abortSignal = abort ?? new AbortController().signal;

  const stream =
    typeof body === "string"
      ? new ReadableStream<Uint8Array>({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        })
      : body;

  const deferredData = await parseDeferredReadableStream(stream);
  await deferredData.resolveData(abortSignal);
  return deferredData.unwrappedData as T;
};

// ------ Router ------

function invariant(value: boolean, message?: string): asserts value;
function invariant<T>(value: T | null | undefined, message?: string): asserts value is T;
function invariant(value: any, message?: string) {
  if (value === false || value === null || typeof value === "undefined") {
    throw new Error(message);
  }
}

interface TrackedPromise extends Promise<any> {
  _tracked?: boolean;
  _data?: any;
  _error?: any;
}

function isTrackedPromise(value: any): value is TrackedPromise {
  return value instanceof Promise && (value as TrackedPromise)._tracked === true;
}

function unwrapTrackedPromise(value: any) {
  if (!isTrackedPromise(value)) {
    return value;
  }

  if (value._error) {
    throw value._error;
  }
  return value._data;
}

class AbortedDeferredError extends Error {}

class DeferredData {
  private pendingKeysSet: Set<string> = new Set<string>();
  private controller: AbortController;
  private abortPromise: Promise<void>;
  private unlistenAbortSignal: () => void;
  private subscribers: Set<(aborted: boolean, settledKey?: string) => void> = new Set();
  data: Record<string, unknown>;
  deferredKeys: string[] = [];

  constructor(data: Record<string, unknown>) {
    invariant(
      data && typeof data === "object" && !Array.isArray(data),
      "defer() only accepts plain objects",
    );

    // Set up an AbortController + Promise we can race against to exit early
    // cancellation
    let reject: (e: AbortedDeferredError) => void;
    this.abortPromise = new Promise((_, r) => (reject = r));
    this.controller = new AbortController();
    const onAbort = () => reject(new AbortedDeferredError("Deferred data aborted"));
    this.unlistenAbortSignal = () => this.controller.signal.removeEventListener("abort", onAbort);
    this.controller.signal.addEventListener("abort", onAbort);

    this.data = Object.entries(data).reduce(
      (acc, [key, value]) =>
        Object.assign(acc, {
          [key]: this.trackPromise(key, value),
        }),
      {},
    );

    if (this.done) {
      // All incoming values were resolved
      this.unlistenAbortSignal();
    }
  }

  private trackPromise(key: string, value: Promise<unknown> | unknown): TrackedPromise | unknown {
    if (!(value instanceof Promise)) {
      return value;
    }

    this.deferredKeys.push(key);
    this.pendingKeysSet.add(key);

    // We store a little wrapper promise that will be extended with
    // _data/_error props upon resolve/reject
    const promise: TrackedPromise = Promise.race([value, this.abortPromise]).then(
      (data) => this.onSettle(promise, key, undefined, data as unknown),
      (error) => this.onSettle(promise, key, error as unknown),
    );

    // Register rejection listeners to avoid uncaught promise rejections on
    // errors or aborted deferred values
    promise.catch(() => {});

    Object.defineProperty(promise, "_tracked", { get: () => true });
    return promise;
  }

  private onSettle(promise: TrackedPromise, key: string, error: unknown, data?: unknown): unknown {
    if (this.controller.signal.aborted && error instanceof AbortedDeferredError) {
      this.unlistenAbortSignal();
      Object.defineProperty(promise, "_error", { get: () => error });
      return Promise.reject(error);
    }

    this.pendingKeysSet.delete(key);

    if (this.done) {
      // Nothing left to abort!
      this.unlistenAbortSignal();
    }

    // If the promise was resolved/rejected with undefined, we'll throw an error as you
    // should always resolve with a value or null
    if (error === undefined && data === undefined) {
      const undefinedError = new Error(
        `Deferred data for key "${key}" resolved/rejected with \`undefined\`, ` +
          `you must resolve/reject with a value or \`null\`.`,
      );
      Object.defineProperty(promise, "_error", { get: () => undefinedError });
      this.emit(false, key);
      return Promise.reject(undefinedError);
    }

    if (data === undefined) {
      Object.defineProperty(promise, "_error", { get: () => error });
      this.emit(false, key);
      return Promise.reject(error);
    }

    Object.defineProperty(promise, "_data", { get: () => data });
    this.emit(false, key);
    return data;
  }

  private emit(aborted: boolean, settledKey?: string) {
    this.subscribers.forEach((subscriber) => subscriber(aborted, settledKey));
  }

  subscribe(fn: (aborted: boolean, settledKey?: string) => void) {
    this.subscribers.add(fn);
    return (): boolean => this.subscribers.delete(fn);
  }

  cancel(): void {
    this.controller.abort();
    this.pendingKeysSet.forEach((_v, k) => this.pendingKeysSet.delete(k));
    this.emit(true);
  }

  async resolveData(signal: AbortSignal): Promise<boolean> {
    let aborted = false;
    if (!this.done) {
      const onAbort = () => this.cancel();
      signal.addEventListener("abort", onAbort);
      aborted = await new Promise((resolve) => {
        this.subscribe((aborted) => {
          signal.removeEventListener("abort", onAbort);
          if (aborted || this.done) {
            resolve(aborted);
          }
        });
      });
    }
    return aborted;
  }

  get done(): boolean {
    return this.pendingKeysSet.size === 0;
  }

  get unwrappedData(): {} {
    invariant(
      this.data !== null && this.done,
      "Can only unwrap data on initialized and settled deferreds",
    );

    return Object.entries(this.data).reduce(
      (acc, [key, value]) =>
        Object.assign(acc, {
          [key]: unwrapTrackedPromise(value),
        }),
      {},
    );
  }
}

// ------ React ------

const DEFERRED_VALUE_PLACEHOLDER_PREFIX = "__deferred_promise:";

async function parseDeferredReadableStream(
  stream: ReadableStream<Uint8Array>,
): Promise<DeferredData> {
  if (!stream) {
    throw new Error("parseDeferredReadableStream requires stream argument");
  }

  let deferredData: Record<string, Promise<unknown>> | undefined;
  const deferredResolvers: Record<
    string,
    { resolve: (data: unknown) => void; reject: (error: unknown) => void }
  > = {};

  try {
    const sectionReader = readStreamSections(stream);

    // Read the first section to get the critical data
    const initialSectionResult = await sectionReader.next();
    const initialSection = initialSectionResult.value;
    if (!initialSection) throw new Error("no critical data");
    const criticalData = JSON.parse(initialSection);

    // Setup deferred data and resolvers for later based on the critical data
    if (typeof criticalData === "object" && criticalData !== null) {
      for (const [eventKey, value] of Object.entries(criticalData)) {
        if (typeof value !== "string" || !value.startsWith(DEFERRED_VALUE_PLACEHOLDER_PREFIX)) {
          continue;
        }

        deferredData = deferredData || {};

        deferredData[eventKey] = new Promise((resolve, reject) => {
          deferredResolvers[eventKey] = {
            resolve: (value: unknown) => {
              resolve(value);
              delete deferredResolvers[eventKey];
            },
            reject: (error: unknown) => {
              reject(error);
              delete deferredResolvers[eventKey];
            },
          };
        });
      }
    }

    // Read the rest of the stream and resolve deferred promises
    void (async () => {
      try {
        for await (const section of sectionReader) {
          // Determine event type and data
          const [event, ...sectionDataStrings] = section.split(":");
          const sectionDataString = sectionDataStrings.join(":");
          const data = JSON.parse(sectionDataString);

          if (event === "data") {
            for (const [key, value] of Object.entries(data)) {
              if (deferredResolvers[key]) {
                deferredResolvers[key].resolve(value);
              }
            }
          } else if (event === "error") {
            for (const [key, value] of Object.entries(data) as Iterable<
              [string, { message: string; stack?: string }]
            >) {
              const err = new Error(value.message);
              err.stack = value.stack;
              if (deferredResolvers[key]) {
                deferredResolvers[key].reject(err);
              }
            }
          }
        }

        for (const [key, resolver] of Object.entries(deferredResolvers)) {
          resolver.reject(new AbortedDeferredError(`Deferred ${key} will never be resolved`));
        }
      } catch (error) {
        // Reject any existing deferred promises if something blows up
        for (const resolver of Object.values(deferredResolvers)) {
          resolver.reject(error);
        }
      }
    })();

    return new DeferredData({ ...criticalData, ...deferredData });
  } catch (error) {
    for (const resolver of Object.values(deferredResolvers)) {
      resolver.reject(error);
    }

    throw error;
  }
}

async function* readStreamSections(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();

  let buffer: Uint8Array[] = [];
  let sections: string[] = [];
  let closed = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const readStreamSection = async () => {
    if (sections.length > 0) return sections.shift();

    // Read from the stream until we have at least one complete section to process
    while (!closed && sections.length === 0) {
      const chunk = await reader.read();
      if (chunk.done) {
        closed = true;
        break;
      }
      // Buffer the raw chunks
      buffer.push(chunk.value);

      try {
        // Attempt to split off a section from the buffer
        const bufferedString = decoder.decode(mergeArrays(...buffer));
        const splitSections = bufferedString.split("\n\n");
        if (splitSections.length >= 2) {
          // We have a complete section, so add it to the sections array
          sections.push(...splitSections.slice(0, -1));
          // Remove the section from the buffer and store the rest for future processing
          buffer = [encoder.encode(splitSections.slice(-1).join("\n\n"))];
        }

        // If we successfully parsed at least one section, break out of reading the stream
        // to allow upstream processing of the processable sections
        if (sections.length > 0) {
          break;
        }
      } catch {}
    }

    // If we have a complete section, return it
    if (sections.length > 0) {
      return sections.shift();
    }

    // If we have no complete section, but we have no more chunks to process,
    // split those sections and clear out the buffer as there is no more data
    // to process. If this errors, let it bubble up as the stream ended
    // without valid data
    if (buffer.length > 0) {
      const bufferedString = decoder.decode(mergeArrays(...buffer));
      sections = bufferedString.split("\n\n").filter((s) => s);
      buffer = [];
    }

    // Return any remaining sections that have been processed
    return sections.shift();
  };

  let section = await readStreamSection();
  while (section) {
    yield section;
    section = await readStreamSection();
  }
}

function mergeArrays(...arrays: Uint8Array[]) {
  const out = new Uint8Array(arrays.reduce((total, arr) => total + arr.length, 0));
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}
