import type { NextRscChunks, RscChunk } from "./rsc.ts";

// ---------------------------------------------------------------------------
// Stage 1: decode Flight rows into one fully-resolved tree
// ---------------------------------------------------------------------------

export type DecodedElement = { $type: unknown; key?: unknown; props: Record<string, unknown> };

export interface DecodedRsc {
  /** Root row "0", every reference inlined. Elements are `{ $type, key?, props }`. */
  root: unknown;
  hints: { code: string; value: unknown }[];
}

/**
 * Resolves the flat, id-addressed Flight rows into one tree starting at root row "0".
 *
 * Decodes each row's raw JSON (`originalValue`) rather than the parser's `value`, because the
 * parser drops the path from deduplication references like `"$0:t:t:d:r:props:style"`.
 */
export function decodeRscChunks(chunks: NextRscChunks): DecodedRsc {
  const rows = new Map<string, RscChunk>();
  for (const list of Object.values(chunks) as RscChunk[][]) {
    for (const chunk of list) {
      // Hints all share id "0" with the root model, so they are not addressable.
      if (chunk.type !== "hint" && "id" in chunk) rows.set(chunk.id, chunk);
    }
  }

  const rawCache = new Map<string, unknown>();
  const rawRow = (id: string): unknown => {
    if (!rawCache.has(id)) {
      const row = rows.get(id);
      const raw =
        row &&
        (row.type === "model" || row.type === "module") &&
        typeof row.originalValue === "string"
          ? JSON.parse(row.originalValue)
          : undefined;
      rawCache.set(id, raw);
    }
    return rawCache.get(id);
  };

  const isElementTuple = (v: unknown): v is ["$", unknown, unknown, unknown] =>
    Array.isArray(v) && v[0] === "$" && v.length >= 4;
  const ELEMENT_FIELDS: Record<string, number> = { type: 1, key: 2, props: 3 };

  const moduleName = (raw: unknown, stack: string[]) => {
    const [moduleId, , exportName] = decode(raw, stack) as [unknown, unknown, unknown];
    const id = JSON.stringify(moduleId);
    if (typeof exportName !== "string" || exportName === "" || exportName === "*") {
      return `client:module-${id}`;
    }
    return exportName === "default" ? `client:default@${id}` : `client:${exportName}`;
  };

  /** Resolves `<id>[:path]` to a decoded value. */
  const resolveRef = (ref: string, stack: string[]): unknown => {
    if (stack.includes(ref)) return { $cycle: ref };
    const [id = "", ...path] = ref.split(":");
    const row = rows.get(id);
    if (!row) return { $unresolved: ref };
    const next = [...stack, ref];

    if (row.type === "text") return row.value;
    if (row.type === "module") return moduleName(rawRow(id), next);
    if (row.type === "startAsyncIterable" || row.type === "startReadableStream") {
      return { $stream: id, kind: row.type };
    }
    if (row.type !== "model") return { $chunk: id, kind: row.type };

    // Walk the path through the raw JSON, following references and element tuples.
    let raw = rawRow(id);
    for (const segment of path) {
      while (typeof raw === "string" && /^\$[L@]?[0-9a-f]+(:|$)/.test(raw)) {
        const target = raw.replace(/^\$[L@]?/, "");
        const [targetId = "", ...targetPath] = target.split(":");
        raw = targetPath.reduce<unknown>(
          (acc, s) => (acc as Record<string, unknown> | undefined)?.[s],
          rawRow(targetId),
        );
      }
      if (isElementTuple(raw) && segment in ELEMENT_FIELDS) raw = raw[ELEMENT_FIELDS[segment]!];
      else raw = (raw as Record<string, unknown> | undefined)?.[segment];
    }
    return decode(raw, next);
  };

  const decodeString = (value: string, stack: string[]): unknown => {
    if (!value.startsWith("$")) return value;
    if (value === "$") return "react.element";
    const tag = value[1]!;
    const rest = value.slice(2);
    switch (tag) {
      case "$":
        return value.slice(1); // escaped literal "$..."
      case "L": // lazy node
      case "@": // promise
        return resolveRef(rest, stack);
      case "S":
        return `Symbol(${rest})`;
      case "D":
        return rest; // Date (ISO string)
      case "n":
        return `${rest}n`; // BigInt
      case "Q":
        return { $map: resolveRef(rest, stack) };
      case "W":
        return { $set: resolveRef(rest, stack) };
      case "F": // server reference (React 18)
      case "h": // server reference (React 19)
        return { $serverAction: resolveRef(rest, stack) };
      case "u":
        if (value === "$undefined") return undefined;
        break;
      case "N":
        if (value === "$NaN") return "NaN";
        break;
      case "I":
        if (value === "$Infinity") return "Infinity";
        break;
      case "-":
        if (value === "$-Infinity") return "-Infinity";
        if (value === "$-0") return -0;
        break;
    }
    if (/^[0-9a-f]/.test(tag)) return resolveRef(value.slice(1), stack);
    return { $special: value };
  };

  const decode = (value: unknown, stack: string[]): unknown => {
    if (typeof value === "string") return decodeString(value, stack);
    if (typeof value !== "object" || value === null) return value;
    if (isElementTuple(value)) {
      const [, type, key, props] = value;
      const el: Record<string, unknown> = { $type: decode(type, stack) };
      if (key !== null) el.key = key;
      el.props = decode(props, stack);
      return el;
    }
    if (Array.isArray(value)) return value.map((v) => decode(v, stack));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, stack)]));
  };

  return {
    root: rows.get("0")?.type === "model" ? resolveRef("0", []) : null,
    hints: chunks.hint.map((chunk) => ({ code: chunk.code, value: chunk.value })),
  };
}

// ---------------------------------------------------------------------------
// Stage 2: readable view, addressed by route path + component name
// ---------------------------------------------------------------------------

export interface ReadableComponent {
  /** Exported client component name, e.g. "MediaIndividualPage". */
  component: string;
  /** Route path the component was rendered under, e.g. "/(mms)/[maping_id]/__PAGE__". */
  route: string;
  /** Component props (children live in `routes`). */
  props: Record<string, unknown>;
}

export interface ReadableElement {
  /** Host tag (e.g. "div") or anonymous client component reference (e.g. `default@"123"`). */
  type: string;
  /** Route path the element was rendered under. */
  route: string;
  /** Element props, minus `children` and `dropProps`. */
  props: Record<string, unknown>;
}

export interface ReadableRsc {
  url: string | null;
  /** Dynamic route params, e.g. `{ maping_id: "354-easy-pay-…" }`. */
  params: Record<string, string>;
  head: { title?: string; meta: Record<string, string>; links: Record<string, unknown>[] };
  /** Client component data keyed by name (`Name`, then `Name[1]`, … for repeats in render order). */
  components: Record<string, ReadableComponent>;
  /** Simplified render tree per route segment. Named components point into `components`. */
  routes: Record<string, unknown>;
  /** Props of host elements and anonymous client components, in render order. */
  other: ReadableElement[];
  /** Element trees found outside the route tree. */
  detached: unknown[];
  /** Parsed `<script type="application/ld+json">` blocks (referenced from trees as `$jsonLd`). */
  jsonLd: unknown[];
  /** Preloaded assets grouped by kind (style, font, image, …). */
  assets: Record<string, string[]>;
}

export interface ReadableOptions {
  /** Props dropped from the render tree (not from component data). */
  dropProps?: string[];
  /** Strings in the render tree longer than this are truncated (component data is untouched). */
  maxTreeStringLength?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isElement = (v: unknown): v is DecodedElement =>
  isRecord(v) && "$type" in v && isRecord(v.props);
const isMap = (v: unknown): v is { $map: unknown[] } => isRecord(v) && Array.isArray(v.$map);

/** Components that only wrap their children (React and Next.js framework internals). */
const TRANSPARENT = new Set([
  "Fragment",
  "Suspense",
  "Activity",
  "StrictMode",
  "LoadingBoundaryProvider",
  "ViewportBoundary",
  "MetadataBoundary",
  "OutletBoundary",
  "ErrorBoundary",
  "HTTPAccessFallbackBoundary",
  "RenderFromTemplateContext",
]);
/** Host elements that are dropped when they carry no props of their own. */
const WRAPPERS = new Set([
  "div",
  "span",
  "section",
  "main",
  "article",
  "aside",
  "header",
  "footer",
]);
const HEAD_TAGS = new Set(["title", "meta", "link", "base"]);

const typeName = (type: unknown): string => {
  const t = typeof type === "string" ? type : JSON.stringify(type);
  const symbol = /^Symbol\(react\.(\w+)\)$/.exec(t);
  if (symbol) return symbol[1]!.replace(/^./, (c) => c.toUpperCase());
  return t.replace(/^client:/, "");
};
const isHost = (type: unknown) =>
  typeof type === "string" && !type.startsWith("client:") && !type.startsWith("Symbol(");
const isNamedClient = (type: unknown) =>
  typeof type === "string" && /^client:(?!default@|module-)/.test(type);

const textOf = (v: unknown): string =>
  typeof v === "string" || typeof v === "number"
    ? String(v)
    : Array.isArray(v)
      ? v.map(textOf).join("")
      : isElement(v)
        ? textOf(v.props.children)
        : "";

// --- route tree detection (by shape, not by Next.js's minified keys) ---

/** A dynamic param segment: a flat object of primitives, e.g. `{ n: "slug", t: "d", k: "value" }`. */
const isParamSegment = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) &&
  !isElement(v) &&
  !isMap(v) &&
  Object.values(v).some((x) => typeof x === "string") &&
  Object.values(v).every(
    (x) =>
      x === null ||
      typeof x !== "object" ||
      (Array.isArray(x) && x.every((y) => typeof y !== "object")),
  );

const segmentOf = (node: Record<string, unknown>) =>
  Object.values(node).find((v) => typeof v === "string" || isParamSegment(v));

const elementOf = (node: Record<string, unknown>): DecodedElement | undefined => {
  for (const v of Object.values(node)) {
    if (isElement(v)) return v;
    if (isRecord(v) && !isMap(v)) {
      const inner = Object.values(v).find(isElement);
      if (inner) return inner;
    }
  }
  return undefined;
};

const isRouteNode = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && !isElement(v) && segmentOf(v) !== undefined && elementOf(v) !== undefined;

const childSlots = (node: Record<string, unknown>): [string, Record<string, unknown>][] =>
  Object.values(node)
    .filter(isMap)
    .flatMap((m) => m.$map)
    .filter(
      (e): e is [string, Record<string, unknown>] =>
        Array.isArray(e) && typeof e[0] === "string" && isRouteNode(e[1]),
    );

/** Builds a readable, route-addressed view of a decoded RSC payload. */
export function toReadableRsc(decoded: DecodedRsc, options: ReadableOptions = {}): ReadableRsc {
  const dropProps = new Set(options.dropProps ?? ["className", "style"]);
  const maxLen = options.maxTreeStringLength ?? 200;

  const out: ReadableRsc = {
    url: null,
    params: {},
    head: { meta: {}, links: [] },
    components: {},
    routes: {},
    other: [],
    detached: [],
    jsonLd: [],
    assets: {},
  };
  const occurrences = new Map<string, number>();

  const register = (component: string, route: string, props: Record<string, unknown>) => {
    const index = occurrences.get(component) ?? 0;
    occurrences.set(component, index + 1);
    const key = index === 0 ? component : `${component}[${index}]`;
    // Reserve the slot first so outer components are listed before ones nested in their props.
    out.components[key] = { component, route, props: {} };
    out.components[key].props = simplify(props, route, "data") as Record<string, unknown>;
    return key;
  };

  const registerOther = (type: string, route: string, props: Record<string, unknown>) => {
    // Reserve the slot first so outer elements are listed before ones nested in their props.
    const entry: ReadableElement = { type, route, props: {} };
    out.other.push(entry);
    entry.props = simplify(props, route, "data") as Record<string, unknown>;
  };

  const cleanChildren = (items: unknown[]): unknown => {
    const flat: unknown[] = [];
    for (const item of items.flat(Infinity)) {
      if (item === null || item === undefined || typeof item === "boolean" || item === "") continue;
      const last = flat.at(-1);
      if (typeof item === "string" && typeof last === "string") flat[flat.length - 1] = last + item;
      else flat.push(item);
    }
    return flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat;
  };

  const compact = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  const simplifyElement = (el: DecodedElement, route: string): unknown => {
    const name = typeName(el.$type);
    const { children: rawChildren, ...rawProps } = el.props;

    if (typeof rawProps.parallelRouterKey === "string")
      return { $slot: rawProps.parallelRouterKey };
    if (isHost(el.$type) && HEAD_TAGS.has(name)) return undefined; // collected into `head`
    if (name === "svg") return { $: "svg" };
    if (rawProps.type === "application/ld+json") {
      const html = rawProps.dangerouslySetInnerHTML;
      const source = isRecord(html) ? html.__html : textOf(rawChildren);
      try {
        out.jsonLd.push(JSON.parse(String(source)));
        return { $jsonLd: out.jsonLd.length - 1 };
      } catch {
        // Not valid JSON: fall through and render it like any other element.
      }
    }

    const children =
      rawChildren === undefined ? undefined : cleanChildren([simplify(rawChildren, route, "tree")]);
    if (TRANSPARENT.has(name)) return children;

    const props = Object.fromEntries(
      Object.entries(rawProps).filter(
        ([k, v]) => v !== undefined && !(dropProps.has(k) && isHost(el.$type)),
      ),
    );
    const hasProps = Object.keys(props).length > 0;

    if (hasProps && !isNamedClient(el.$type)) registerOther(name, route, props);

    if (isHost(el.$type)) {
      if (!hasProps && WRAPPERS.has(name)) return children;
      return compact({ $: name, ...(simplify(props, route, "tree") as object), children });
    }
    if (isNamedClient(el.$type)) {
      return compact({
        $: name,
        $data: hasProps ? register(name, route, props) : undefined,
        children,
      });
    }
    // Anonymous client component (module id only — not stable across builds).
    if (!hasProps) return children;
    return compact({ $: name, ...(simplify(props, route, "tree") as object), children });
  };

  const simplify = (v: unknown, route: string, mode: "tree" | "data"): unknown => {
    if (typeof v === "string") {
      return mode === "tree" && v.length > maxLen
        ? `${v.slice(0, maxLen)}… (+${v.length - maxLen} chars)`
        : v;
    }
    if (Array.isArray(v)) {
      const items = v.map((x) => simplify(x, route, mode));
      return v.some(isElement) ? cleanChildren(items) : items;
    }
    if (!isRecord(v)) return v;
    if (isElement(v)) return simplifyElement(v, route);
    if (isRecord(v.$serverAction)) return `serverAction:${String(v.$serverAction.id)}`;
    if (isMap(v)) {
      const entries = v.$map as unknown[];
      return entries.every((e) => Array.isArray(e) && typeof e[0] === "string")
        ? Object.fromEntries(
            (entries as [string, unknown][]).map(([k, x]) => [k, simplify(x, route, mode)]),
          )
        : simplify(entries, route, mode);
    }
    if (Array.isArray(v.$set)) return simplify(v.$set, route, mode);
    return compact(
      Object.fromEntries(Object.entries(v).map(([k, x]) => [k, simplify(x, route, mode)])),
    );
  };

  const visitRoute = (node: Record<string, unknown>, parts: string[]) => {
    const segment = segmentOf(node);
    let name = "";
    if (typeof segment === "string") name = segment;
    else if (isParamSegment(segment)) {
      const strings = Object.values(segment).filter((x): x is string => typeof x === "string");
      const param = strings[0] ?? "param";
      name = `[${param}]`;
      if (strings.length > 1) out.params[param] = strings.at(-1)!;
    }
    const path = name ? [...parts, name] : parts;
    const route = `/${path.join("/")}`;

    const element = elementOf(node);
    const tree = element && cleanChildren([simplify(element, route, "tree")]);
    if (tree !== undefined) out.routes[route] = tree;

    for (const [slot, child] of childSlots(node)) {
      visitRoute(child, slot === "children" ? path : [...path, `@${slot}`]);
    }
  };

  const collectHead = (v: unknown, seen = new Set<unknown>()) => {
    if (typeof v !== "object" || v === null || seen.has(v)) return;
    seen.add(v);
    if (isElement(v) && isHost(v.$type)) {
      const p = v.props;
      if (v.$type === "title") out.head.title = textOf(p.children);
      if (v.$type === "meta") {
        const key =
          p.name ?? p.property ?? p.httpEquiv ?? p.itemProp ?? (p.charSet ? "charset" : undefined);
        const content = p.content ?? p.charSet;
        if (typeof key === "string" && typeof content === "string") out.head.meta[key] = content;
      }
      if (v.$type === "link" && p.rel !== "stylesheet")
        out.head.links.push(compact({ ...p, children: undefined }));
    }
    for (const x of Object.values(v)) collectHead(x, seen);
  };

  const visit = (v: unknown) => {
    if (isRouteNode(v)) return visitRoute(v, []);
    if (isElement(v)) {
      const tree = simplify(v, "", "tree");
      if (tree !== undefined) out.detached.push(tree);
      return;
    }
    if (Array.isArray(v)) {
      // The first all-string array at the top level is the requested URL's segments.
      if (out.url === null && v.length > 0 && v.every((x) => typeof x === "string")) {
        out.url = `/${v.filter(Boolean).join("/")}`;
      }
      return v.forEach(visit);
    }
    if (isRecord(v)) Object.values(v).forEach(visit);
  };

  collectHead(decoded.root);
  visit(decoded.root);

  for (const hint of decoded.hints) {
    if (hint.code !== "L" || !Array.isArray(hint.value)) continue;
    const [href, as] = hint.value as [unknown, unknown];
    if (typeof href !== "string") continue;
    (out.assets[typeof as === "string" ? as : "other"] ??= []).push(href);
  }

  return out;
}
