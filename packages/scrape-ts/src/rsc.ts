import { type Chunk, createFlightResponse, processBinaryChunk } from "@rsc-parser/react-client";
import { ScrapeError } from "./errors.ts";
import { type FetchOptions, fetchHtml } from "./fetch-html.ts";
import { type HtmlScript, readHtmlScripts } from "./html-scripts.ts";
import { type StandardSchemaV1, validate } from "./standard-schema.ts";

export type { Chunk as RscChunk };

/** Decoded React Server Component chunks, grouped by chunk type. */
export type NextRscChunks = {
  [Type in Chunk["type"]]: Extract<Chunk, { type: Type }>[];
};

export interface ParseNextRscChunksOptions {
  /** Used in error messages. */
  url?: string;
}

export interface FetchFirstMatchingNextRscPropsOptions<
  TSchema extends StandardSchemaV1,
> extends FetchOptions {
  /** Any Standard Schema (Zod, Valibot, ArkType, ...) describing the props to find. */
  schema: TSchema;
}

export interface ParseFirstMatchingNextRscPropsOptions<
  TSchema extends StandardSchemaV1,
> extends ParseNextRscChunksOptions {
  schema: TSchema;
}

const NEXT_FLIGHT_PUSH = "self.__next_f.push";

interface ScriptParseDiagnostic {
  scriptIndex: number;
  callOffset: number;
  message: string;
}

/** Fetches a Next.js App Router page and decodes its inline RSC (Flight) payload. */
export async function fetchNextRscChunks(
  url: string | URL,
  options: FetchOptions = {},
): Promise<NextRscChunks> {
  const page = await fetchHtml(url, options);
  return parseNextRscChunks(page.html, { url: page.url });
}

/**
 * Fetches a Next.js App Router page and returns the props of the first React
 * element in the RSC tree whose props satisfy `schema`.
 */
export async function fetchFirstMatchingNextRscProps<TSchema extends StandardSchemaV1>(
  url: string | URL,
  options: FetchFirstMatchingNextRscPropsOptions<TSchema>,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  const { schema, ...fetchOptions } = options;
  const page = await fetchHtml(url, fetchOptions);
  return parseFirstMatchingNextRscProps(page.html, { schema, url: page.url });
}

/** Parses HTML and returns the first props matching the schema, or throws NO_MATCH. */
export async function parseFirstMatchingNextRscProps<TSchema extends StandardSchemaV1>(
  html: string,
  options: ParseFirstMatchingNextRscPropsOptions<TSchema>,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  const chunks = parseNextRscChunks(html, options);
  const props = await findFirstMatchingNextRscProps(chunks, options.schema);

  if (props === undefined) {
    throw new ScrapeError(
      `No React Server Component props matched the provided schema for ${options.url ?? "the provided HTML"}`,
      "NO_MATCH",
      { url: options.url },
    );
  }

  return props.value;
}

/**
 * Fetches a Next.js App Router page and returns the props of every React
 * element in the RSC tree, unvalidated, in breadth-first order per model chunk.
 */
export async function fetchAllNextRscProps(
  url: string | URL,
  options: FetchOptions = {},
): Promise<unknown[]> {
  const page = await fetchHtml(url, options);
  return parseAllNextRscProps(page.html, { url: page.url });
}

/** Parses HTML and returns all element props, unvalidated, in breadth-first order per chunk. */
export function parseAllNextRscProps(
  html: string,
  options: ParseNextRscChunksOptions = {},
): unknown[] {
  return collectAllNextRscProps(parseNextRscChunks(html, options));
}

/**
 * Searches the model chunks breadth-first for a React element whose `props`
 * satisfy `schema`. Returns `undefined` when nothing matches.
 */
export async function findFirstMatchingNextRscProps<TSchema extends StandardSchemaV1>(
  chunks: Pick<NextRscChunks, "model">,
  schema: TSchema,
): Promise<{ value: StandardSchemaV1.InferOutput<TSchema> } | undefined> {
  for (const props of walkNextRscProps(chunks)) {
    const result = await validate(schema, props);
    if (result.success) {
      return { value: result.value };
    }
  }

  return undefined;
}

/**
 * Returns the props of every React element in the model chunks, unvalidated,
 * in breadth-first order per chunk.
 */
export function collectAllNextRscProps(chunks: Pick<NextRscChunks, "model">): unknown[] {
  return [...walkNextRscProps(chunks)];
}

function* walkNextRscProps(
  chunks: Pick<NextRscChunks, "model">,
): Generator<Record<string, unknown>> {
  for (const chunk of chunks.model) {
    const queue: unknown[] = [chunk.value];
    const seen = new WeakSet<object>();

    for (let index = 0; index < queue.length; index++) {
      const node = queue[index];

      if (!isObjectRecord(node) || seen.has(node)) {
        continue;
      }

      seen.add(node);

      if (isObjectRecord(node.props)) {
        yield node.props;
      }

      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }

      if ("children" in node) {
        queue.push(node.children);
      }

      if (isObjectRecord(node.props) && "children" in node.props) {
        queue.push(node.props.children);
      }
    }
  }
}

/** Decodes the inline `self.__next_f.push(...)` RSC payload from Next.js page HTML. */
export function parseNextRscChunks(
  html: string,
  options: ParseNextRscChunksOptions = {},
): NextRscChunks {
  return parseNextRscScriptPayloads(readHtmlScripts(html), options).chunks;
}

/** Internal decoder retaining the scripts that supplied type-1 payload fragments. */
export function parseNextRscScriptPayloads(
  scripts: HtmlScript[],
  options: ParseNextRscChunksOptions = {},
  allowMissing = false,
): { chunks: NextRscChunks; scripts: HtmlScript[] } {
  const location = options.url ?? "the provided HTML";
  const { pushes, foundPushReference, diagnostics, payloadScripts } =
    extractPushesFromScripts(scripts);

  if (pushes.length === 0) {
    if (foundPushReference) {
      throw new ScrapeError(
        `Found Next.js Flight push calls, but none could be parsed: ${formatDiagnostics(diagnostics)}`,
        "SCRIPT_PARSE_FAILED",
        { url: options.url },
      );
    }

    if (allowMissing) return { chunks: groupChunks([]), scripts: [] };
    throw new ScrapeError(
      `No Next.js Flight data was found in inline script tags for ${location}`,
      "RSC_NOT_FOUND",
      { url: options.url },
    );
  }

  const payloadChunks = pushes
    .filter(
      (entry): entry is [1, string, ...unknown[]] => entry[0] === 1 && typeof entry[1] === "string",
    )
    .map((entry) => entry[1]);

  if (payloadChunks.length === 0) {
    if (allowMissing && diagnostics.length === 0) return { chunks: groupChunks([]), scripts: [] };
    const diagnosticSuffix =
      diagnostics.length > 0 ? ` Script diagnostics: ${formatDiagnostics(diagnostics)}` : "";
    throw new ScrapeError(
      `Found ${pushes.length} Next.js Flight push call(s), but no type-1 string payload chunks.${diagnosticSuffix}`,
      "RSC_NOT_FOUND",
      { url: options.url },
    );
  }

  return {
    chunks: groupChunks(decodeFlightPayload(payloadChunks.join(""), location, options.url)),
    scripts: [...payloadScripts],
  };
}

function decodeFlightPayload(flightPayload: string, location: string, url?: string): Chunk[] {
  try {
    const response = createFlightResponse(false);
    response._currentTimestamp = 0;
    processBinaryChunk(response, new TextEncoder().encode(flightPayload));
    return response._chunks;
  } catch (cause) {
    throw new ScrapeError(
      `Failed to parse reconstructed Next.js Flight payload from ${location}: ${getErrorMessage(cause)}`,
      "RSC_PARSE_FAILED",
      { cause, url },
    );
  }
}

function groupChunks(chunks: Chunk[]): NextRscChunks {
  const grouped: NextRscChunks = {
    buffer: [],
    console: [],
    debugInfo: [],
    errorDev: [],
    errorProd: [],
    hint: [],
    model: [],
    module: [],
    postponeDev: [],
    postponeProd: [],
    startAsyncIterable: [],
    startReadableStream: [],
    stopStream: [],
    text: [],
  };

  for (const chunk of chunks) {
    (grouped[chunk.type] as Chunk[]).push(chunk);
  }

  return grouped;
}

function extractPushesFromScripts(scripts: HtmlScript[]): {
  pushes: unknown[][];
  foundPushReference: boolean;
  diagnostics: ScriptParseDiagnostic[];
  payloadScripts: Set<HtmlScript>;
} {
  const payloadScripts = new Set<HtmlScript>();
  const pushes: unknown[][] = [];
  const diagnostics: ScriptParseDiagnostic[] = [];
  let foundPushReference = false;

  scripts.forEach((script, scriptIndex) => {
    if (script.isJson) return;
    const scriptContent = script.content;
    let searchFrom = 0;

    while (searchFrom < scriptContent.length) {
      const callOffset = scriptContent.indexOf(NEXT_FLIGHT_PUSH, searchFrom);

      if (callOffset === -1) {
        break;
      }

      foundPushReference = true;

      const openingParenIndex = findOpeningParenthesis(
        scriptContent,
        callOffset + NEXT_FLIGHT_PUSH.length,
      );

      if (openingParenIndex === -1) {
        diagnostics.push({
          scriptIndex,
          callOffset,
          message: "Could not find opening parenthesis for push call",
        });
        searchFrom = callOffset + NEXT_FLIGHT_PUSH.length;
        continue;
      }

      const scanResult = scanCallArgument(scriptContent, openingParenIndex);

      if (!scanResult.ok) {
        diagnostics.push({ scriptIndex, callOffset, message: scanResult.message });
        searchFrom = callOffset + NEXT_FLIGHT_PUSH.length;
        continue;
      }

      try {
        const parsedArgument: unknown = JSON.parse(scanResult.argument);

        if (Array.isArray(parsedArgument)) {
          pushes.push(parsedArgument);
          if (parsedArgument[0] === 1 && typeof parsedArgument[1] === "string") {
            payloadScripts.add(script);
          }
        } else {
          diagnostics.push({
            scriptIndex,
            callOffset,
            message: "Push call argument was not a JSON array",
          });
        }
      } catch (cause) {
        diagnostics.push({
          scriptIndex,
          callOffset,
          message: `Push call argument was not valid JSON: ${getErrorMessage(cause)}`,
        });
      }

      searchFrom = scanResult.closingParenIndex + 1;
    }
  });

  return { pushes, foundPushReference, diagnostics, payloadScripts };
}

function findOpeningParenthesis(source: string, startIndex: number): number {
  for (let index = startIndex; index < source.length; index++) {
    const character = source[index];

    if (isWhitespace(character)) {
      continue;
    }

    return character === "(" ? index : -1;
  }

  return -1;
}

function scanCallArgument(
  source: string,
  openingParenIndex: number,
): { ok: true; argument: string; closingParenIndex: number } | { ok: false; message: string } {
  let depth = 1;
  let quote: string | undefined;
  let escaped = false;

  for (let index = openingParenIndex + 1; index < source.length; index++) {
    const character = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "(") {
      depth++;
      continue;
    }

    if (character === ")") {
      depth--;

      if (depth === 0) {
        return {
          ok: true,
          argument: source.slice(openingParenIndex + 1, index),
          closingParenIndex: index,
        };
      }
    }
  }

  return { ok: false, message: "Could not find closing parenthesis for push call" };
}

function formatDiagnostics(diagnostics: ScriptParseDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "no parser diagnostics were recorded";
  }

  return diagnostics
    .map(
      (diagnostic) =>
        `script ${diagnostic.scriptIndex}, offset ${diagnostic.callOffset}: ${diagnostic.message}`,
    )
    .join("; ");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\n" ||
    character === "\r" ||
    character === "\t" ||
    character === "\v" ||
    character === "\f"
  );
}
