import { ScrapeError } from "./errors.ts";
import { type FetchOptions, fetchHtml } from "./fetch-html.ts";
import { type HtmlScript, readHtmlScripts } from "./html-scripts.ts";
import { type StandardSchemaV1, validate } from "./standard-schema.ts";

export interface ParseFirstMatchingJsonScriptOptions<TSchema extends StandardSchemaV1> {
  /** Any Standard Schema (Zod, Valibot, ArkType, ...). The first script that validates is returned. */
  schema: TSchema;
  /** Used in error messages. */
  url?: string;
}

export interface FetchFirstMatchingJsonScriptOptions<TSchema extends StandardSchemaV1>
  extends FetchOptions, Omit<ParseFirstMatchingJsonScriptOptions<TSchema>, "url"> {}

/**
 * Fetches a page and returns the first `application/json` or
 * `application/ld+json` script block that satisfies `schema`.
 */
export async function fetchFirstMatchingJsonScript<TSchema extends StandardSchemaV1>(
  url: string | URL,
  options: FetchFirstMatchingJsonScriptOptions<TSchema>,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  const { schema, ...fetchOptions } = options;
  const page = await fetchHtml(url, fetchOptions);

  return parseFirstMatchingJsonScript(page.html, { schema, url: page.url });
}

/**
 * Returns the first `application/json` or `application/ld+json` script block in
 * `html` (in document order) that satisfies `schema`. Malformed JSON blocks are
 * skipped.
 */
export async function parseFirstMatchingJsonScript<TSchema extends StandardSchemaV1>(
  html: string,
  options: ParseFirstMatchingJsonScriptOptions<TSchema>,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  const { schema, url } = options;
  const scripts = readHtmlScripts(html).filter((script) => script.isJson && script.content.trim());

  for (const script of scripts) {
    let data: unknown;

    try {
      data = parseJsonValue(script.content);
    } catch {
      // A malformed JSON block should not prevent checking the others.
      continue;
    }

    const result = await validate(schema, data);
    if (result.success) {
      return result.value;
    }
  }

  const location = url ? ` for ${url}` : "";
  throw new ScrapeError(
    `No JSON script data matched the provided schema${location} (${scripts.length} candidate script(s) checked)`,
    "NO_MATCH",
    { url },
  );
}

/**
 * Fetches a page and returns the parsed contents of every `application/json`
 * and `application/ld+json` script block, unvalidated, in document order.
 */
export async function fetchAllJsonScripts(
  url: string | URL,
  options: FetchOptions = {},
): Promise<unknown[]> {
  const page = await fetchHtml(url, options);
  return parseAllJsonScripts(page.html);
}

/**
 * Returns the parsed contents of every `application/json` and
 * `application/ld+json` script block in `html`, unvalidated, in document order.
 * Malformed blocks are skipped.
 */
export function parseAllJsonScripts(html: string): unknown[] {
  return parseJsonScriptPayloads(readHtmlScripts(html)).values;
}

/** Internal parser that retains the source scripts for successful payloads. */
export function parseJsonScriptPayloads(scripts: HtmlScript[]): {
  values: unknown[];
  scripts: HtmlScript[];
} {
  const results: unknown[] = [];
  const parsedScripts: HtmlScript[] = [];

  for (const script of scripts) {
    if (!script.isJson) continue;
    try {
      results.push(parseJsonValue(script.content));
      parsedScripts.push(script);
    } catch {
      // Skip malformed blocks.
    }
  }

  return { values: results, scripts: parsedScripts };
}

/**
 * Parses JSON, retrying with raw control characters inside string literals
 * escaped — a common defect in hand-rolled JSON-LD.
 */
export function parseJsonValue(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (cause) {
    try {
      return JSON.parse(escapeControlCharactersInStrings(json));
    } catch {
      throw cause;
    }
  }
}

function escapeControlCharactersInStrings(json: string): string {
  let result = "";
  let insideString = false;
  let escaped = false;

  for (const character of json) {
    if (!insideString) {
      result += character;
      if (character === '"') {
        insideString = true;
      }
      continue;
    }

    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      result += character;
      escaped = true;
      continue;
    }

    if (character === '"') {
      result += character;
      insideString = false;
      continue;
    }

    const codePoint = character.codePointAt(0);
    result +=
      codePoint !== undefined && codePoint <= 0x1f
        ? `\\u${codePoint.toString(16).padStart(4, "0")}`
        : character;
  }

  return result;
}
