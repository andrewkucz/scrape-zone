import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ScrapedDoc } from "../../server/scrape.ts";
import { generateTypes, typegenMetaQuery } from "./client.ts";
import type { LanguageMeta, LanguageOption } from "./protocol.ts";

/** Shown first in the language picker. */
const POPULAR = [
  "typescript",
  "typescript-zod",
  "typescript-effect-schema",
  "schema",
  "python",
  "go",
  "rust",
  "swift",
  "kotlin",
  "cs",
  "java",
  "dart",
];

/** Our defaults where they differ from quicktype's: plain types beat generated (de)serializers here. */
const PREFERRED_DEFAULTS: Record<string, boolean | string> = { "just-types": true };

const EXTRA_FLAGS = [
  {
    name: "allPropertiesOptional",
    description: "Make all properties optional",
    defaultValue: false,
  },
  { name: "alphabetizeProperties", description: "Alphabetize properties", defaultValue: false },
];

interface TypegenSettings {
  lang: string;
  /** Per-language overrides of renderer options. */
  rendererOptions: Record<string, Record<string, string | boolean>>;
  /** Overrides of inference flags and EXTRA_FLAGS. */
  flags: Record<string, boolean>;
}

const STORAGE_KEY = "scrape-zone:typegen";
const DEFAULT_SETTINGS: TypegenSettings = { lang: "typescript", rendererOptions: {}, flags: {} };

function loadSettings(): TypegenSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as TypegenSettings) }
      : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function pascalCase(input: string): string {
  const name = input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
  return /^[0-9]/.test(name) ? `T${name}` : name;
}

function defaultTopLevelName(doc: ScrapedDoc): string {
  if (doc.request) {
    const segments = new URL(doc.request.url).pathname.split("/").filter(Boolean);
    return pascalCase(segments.at(-1) ?? "") || "Response";
  }
  const type = /^@type: ([^,]+)/.exec(doc.label)?.[1];
  if (type) return pascalCase(type) || "Root";
  return doc.kind === "rsc" ? "Props" : "Root";
}

function optionDefault(option: LanguageOption): string | boolean {
  const preferred = PREFERRED_DEFAULTS[option.name];
  return preferred !== undefined && typeof preferred === typeof option.defaultValue
    ? preferred
    : option.defaultValue;
}

/** Stable per-document identity for query keys (doc text is too large to hash). */
const docIds = new WeakMap<ScrapedDoc, number>();
let nextDocId = 0;
function docKey(doc: ScrapedDoc): number {
  let id = docIds.get(doc);
  if (id === undefined) {
    id = ++nextDocId;
    docIds.set(doc, id);
  }
  return id;
}

function useDebounced<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(JSON.parse(key) as T), ms);
    return () => clearTimeout(id);
  }, [key, ms]);
  return debounced;
}

export default function TypegenPanel({ doc }: { doc: ScrapedDoc }) {
  const [settings, setSettings] = useState(loadSettings);
  const [topLevel, setTopLevel] = useState(() => defaultTopLevelName(doc));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const meta = useQuery(typegenMetaQuery);

  const languages = meta.data?.languages ?? [];
  const language = languages.find((l) => l.name === settings.lang) ?? languages[0];
  const overrides = (language && settings.rendererOptions[language.name]) ?? {};

  const rendererOptions = useMemo(() => {
    const out: Record<string, string> = {};
    for (const option of language?.options ?? []) {
      out[option.name] = String(overrides[option.name] ?? optionDefault(option));
    }
    return out;
  }, [language, overrides]);

  const allFlags = useMemo(
    () => [...(meta.data?.inferenceFlags ?? []), ...EXTRA_FLAGS],
    [meta.data],
  );
  const flags = useMemo(
    () =>
      Object.fromEntries(allFlags.map((f) => [f.name, settings.flags[f.name] ?? f.defaultValue])),
    [allFlags, settings.flags],
  );

  const params = useDebounced(
    { lang: language?.name ?? "", topLevel: topLevel.trim() || "Root", rendererOptions, flags },
    200,
  );

  const output = useQuery({
    queryKey: ["typegen", docKey(doc), params],
    queryFn: () => generateTypes({ json: doc.text, ...params }),
    enabled: params.lang !== "",
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });

  const setOption = (name: string, value: string | boolean) =>
    setSettings((s) => ({
      ...s,
      rendererOptions: {
        ...s.rendererOptions,
        [s.lang]: { ...s.rendererOptions[s.lang], [name]: value },
      },
    }));

  const setFlag = (name: string, value: boolean) =>
    setSettings((s) => ({ ...s, flags: { ...s.flags, [name]: value } }));

  const resetOptions = () =>
    setSettings((s) => ({
      ...s,
      rendererOptions: { ...s.rendererOptions, [s.lang]: {} },
      flags: {},
    }));

  const copy = async () => {
    if (!output.data) return;
    await navigator.clipboard.writeText(output.data);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    if (!output.data || !language) return;
    const url = URL.createObjectURL(new Blob([output.data], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${params.topLevel}.${language.extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (meta.isPending) return <div className="placeholder">Loading quicktype…</div>;
  if (meta.isError)
    return <div className="error">Failed to load quicktype: {meta.error.message}</div>;

  const primary = language?.options.filter((o) => o.kind === "primary") ?? [];
  const secondary = language?.options.filter((o) => o.kind === "secondary") ?? [];
  const popular = POPULAR.flatMap((name) => languages.filter((l) => l.name === name));
  const rest = languages
    .filter((l) => !POPULAR.includes(l.name))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <div className="typegen">
      <aside className="typegen-options">
        <label className="field">
          <span>Language</span>
          <select
            value={language?.name}
            onChange={(e) => setSettings((s) => ({ ...s, lang: e.target.value }))}
          >
            <LanguageGroup label="Popular" languages={popular} />
            <LanguageGroup label="More" languages={rest} />
          </select>
        </label>

        <label className="field">
          <span>Top-level type name</span>
          <input type="text" value={topLevel} onChange={(e) => setTopLevel(e.target.value)} />
        </label>

        <div className="typegen-options-scroll">
          {primary.length > 0 && (
            <fieldset>
              <legend>{language?.displayName} options</legend>
              {primary.map((o) => (
                <OptionControl
                  key={o.name}
                  option={o}
                  value={overrides[o.name] ?? optionDefault(o)}
                  onChange={(v) => setOption(o.name, v)}
                />
              ))}
            </fieldset>
          )}

          {secondary.length > 0 && (
            <details>
              <summary>More {language?.displayName} options</summary>
              {secondary.map((o) => (
                <OptionControl
                  key={o.name}
                  option={o}
                  value={overrides[o.name] ?? optionDefault(o)}
                  onChange={(v) => setOption(o.name, v)}
                />
              ))}
            </details>
          )}

          <fieldset>
            <legend>Inference</legend>
            {allFlags.map((f) => (
              <label key={f.name} className="check" title={f.name}>
                <input
                  type="checkbox"
                  checked={flags[f.name] ?? false}
                  onChange={(e) => setFlag(f.name, e.target.checked)}
                />
                {f.description}
              </label>
            ))}
          </fieldset>

          <button type="button" className="small" onClick={resetOptions}>
            Reset options
          </button>
        </div>

        <p className="typegen-credit">
          Powered by{" "}
          <a href="https://quicktype.io/" target="_blank" rel="noreferrer">
            quicktype
          </a>
        </p>
      </aside>

      <section className="typegen-output">
        <div className="typegen-toolbar">
          <span className="meta">
            {output.isFetching
              ? "Generating…"
              : output.isError
                ? "Generation failed"
                : output.data
                  ? `${output.data.split("\n").length.toLocaleString()} lines`
                  : ""}
          </span>
          <span className="spacer" />
          <button type="button" className="small" onClick={download} disabled={!output.data}>
            Download .{language?.extension}
          </button>
          <button type="button" className="small" onClick={copy} disabled={!output.data}>
            {copied ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
        {output.isError ? (
          <pre className="code typegen-error">{output.error.message}</pre>
        ) : (
          <textarea
            className="code typegen-code"
            readOnly
            spellCheck={false}
            value={output.data ?? ""}
            aria-label="Generated code"
          />
        )}
      </section>
    </div>
  );
}

function LanguageGroup({ label, languages }: { label: string; languages: LanguageMeta[] }) {
  return (
    <optgroup label={label}>
      {languages.map((l) => (
        <option key={l.name} value={l.name}>
          {l.displayName}
        </option>
      ))}
    </optgroup>
  );
}

function OptionControl({
  option,
  value,
  onChange,
}: {
  option: LanguageOption;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  if (option.optionType === "boolean") {
    return (
      <label className="check" title={option.name}>
        <input
          type="checkbox"
          checked={value === true || value === "true"}
          onChange={(e) => onChange(e.target.checked)}
        />
        {option.description}
      </label>
    );
  }
  return (
    <label className="field" title={option.name}>
      <span>{option.description}</span>
      {option.optionType === "enum" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {option.values?.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
