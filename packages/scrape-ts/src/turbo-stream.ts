// Decoder for `text/x-script` responses: React Router 7 (and Remix v2 with
// single fetch) `.data` requests encoded with turbo-stream v2.
// https://github.com/jacob-ebey/turbo-stream
//
// The first line is a JSON array of every value in the payload. Objects
// reference their keys and values by index into that array (`{"_1":2}` means
// key `values[1]`, value `values[2]`), so it is valid JSON but hard to read.
// Each following line settles a streamed promise: `P<id>:<json>` resolves it
// and `E<id>:<json>` rejects it, appending more values to the same array.

/** Matches a `text/x-script` Content-Type header value. */
export const TEXT_X_SCRIPT_CONTENT_TYPE: RegExp = /\btext\/x-script\b/i;

const HOLE = -1;
const NAN = -2;
const NEGATIVE_INFINITY = -3;
const NEGATIVE_ZERO = -4;
const NULL = -5;
const POSITIVE_INFINITY = -6;
const UNDEFINED = -7;

const SPECIAL_VALUES = new Map<number, unknown>([
  [NAN, Number.NaN],
  [NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  [NEGATIVE_ZERO, -0],
  [NULL, null],
  [POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  [UNDEFINED, undefined],
]);

interface Settled {
  rejected: boolean;
  index: number;
}

/**
 * Decodes a `text/x-script` response body (React Router 7 / Remix single
 * fetch turbo-stream) into plain, JSON-friendly data.
 *
 * The whole body must already be available, so streamed promises are replaced
 * by the value they settled with (a rejection by its reason). Promises the
 * stream never settled become `undefined`. Other rich types are flattened for
 * readability: `Map` becomes an object (or an array of `[key, value]` entries
 * when a key is not a string or number), `Set` an array, `URL` and `RegExp`
 * strings, and errors `{ name, message, stack? }`. React Router's
 * `ErrorResponse` becomes `{ status, statusText, data }`. Dates, bigints and
 * symbols are kept as is.
 *
 * @throws SyntaxError when the body is not a valid turbo-stream payload.
 */
export function parseTextXScriptTurboStreamBody<T = unknown>(body: string): T {
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new SyntaxError("Empty turbo-stream body");

  const values: unknown[] = [];
  const settled = new Map<number, Settled>();

  /** Mirrors turbo-stream's `unflatten`: a number refers to an existing value. */
  const append = (parsed: unknown): number => {
    if (typeof parsed === "number") return parsed;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new SyntaxError("Invalid turbo-stream line");
    }
    const start = values.length;
    values.push(...parsed);
    return start;
  };

  const root = append(JSON.parse(lines[0]!));
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    const kind = line[0];
    const id = Number(line.slice(1, colon));
    if ((kind !== "P" && kind !== "E") || colon === -1 || !Number.isInteger(id)) {
      throw new SyntaxError(`Invalid turbo-stream line: ${line.slice(0, 40)}`);
    }
    settled.set(id, { rejected: kind === "E", index: append(JSON.parse(line.slice(colon + 1))) });
  }

  const hydrated = new Map<number, unknown>();

  const hydrate = (index: number): unknown => {
    if (SPECIAL_VALUES.has(index)) return SPECIAL_VALUES.get(index);
    if (hydrated.has(index)) return hydrated.get(index);
    if (index < 0 || index >= values.length) {
      throw new SyntaxError(`Invalid turbo-stream reference: ${index}`);
    }

    const value = values[index];
    if (!value || typeof value !== "object") {
      hydrated.set(index, value);
      return value;
    }

    if (!Array.isArray(value)) {
      const object: Record<string, unknown> = {};
      hydrated.set(index, object);
      assignEntries(object, value as Record<string, number>);
      return object;
    }

    if (typeof value[0] !== "string") {
      const array: unknown[] = [];
      hydrated.set(index, array);
      value.forEach((n: number, i) => {
        if (n !== HOLE) array[i] = hydrate(n);
      });
      return array;
    }

    const [type, b, c] = value as [string, unknown, unknown];
    const rest = value.slice(1) as number[];
    switch (type) {
      case "D":
        return memo(index, new Date(b as number));
      case "U":
        return memo(index, String(b));
      case "B":
        return memo(index, BigInt(b as string));
      case "R":
        return memo(index, String(new RegExp(b as string, c as string)));
      case "Y":
        return memo(index, Symbol.for(b as string));
      case "S": {
        const array: unknown[] = [];
        hydrated.set(index, array);
        for (const n of rest) array.push(hydrate(n));
        return array;
      }
      case "M": {
        const keys = rest.filter((_, i) => i % 2 === 0).map(hydrate);
        const stringKeys = keys.every((k) => typeof k === "string" || typeof k === "number");
        const result: Record<string, unknown> | unknown[] = stringKeys ? {} : [];
        hydrated.set(index, result);
        keys.forEach((key, i) => {
          const entry = hydrate(rest[i * 2 + 1]!);
          if (Array.isArray(result)) result.push([key, entry]);
          else result[String(key)] = entry;
        });
        return result;
      }
      case "N": {
        const object: Record<string, unknown> = {};
        hydrated.set(index, object);
        assignEntries(object, b as Record<string, number>);
        return object;
      }
      case "P": {
        const result = settled.get(b as number);
        return memo(index, result ? hydrate(result.index) : undefined);
      }
      case "E":
        return memo(index, { name: (c as string | undefined) || "Error", message: b });
      case "Z":
        return memo(index, hydrate(b as number));
      // React Router single-fetch plugins
      case "SanitizedError": {
        const [name, message, stack] = rest.map(hydrate);
        return memo(index, stack ? { name, message, stack } : { name, message });
      }
      case "ErrorResponse": {
        const [data, status, statusText] = rest.map(hydrate);
        return memo(index, { status, statusText, data });
      }
      case "SingleFetchRedirect":
      case "SingleFetchClassInstance":
        return memo(index, hydrate(rest[0]!));
      case "SingleFetchFallback":
        return memo(index, undefined);
      default:
        // An unknown plugin: keep its type tag and decoded arguments.
        return memo(index, { $type: type, values: rest.map(hydrate) });
    }
  };

  const memo = (index: number, value: unknown) => {
    hydrated.set(index, value);
    return value;
  };

  const assignEntries = (target: Record<string, unknown>, refs: Record<string, number>) => {
    for (const [key, ref] of Object.entries(refs)) {
      target[String(hydrate(Number(key.slice(1))))] = hydrate(ref);
    }
  };

  return hydrate(root) as T;
}
