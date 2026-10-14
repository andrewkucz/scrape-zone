import { REQUEST_METHODS, type RequestMethod, type RequestOptions } from "../../server/scrape.ts";

export interface HeaderRow {
  name: string;
  value: string;
}

/** The editable (not yet submitted) state of the advanced request options. */
export interface AdvancedDraft {
  method: RequestMethod;
  headers: HeaderRow[];
  body: string;
  proxy: boolean;
}

export const EMPTY_DRAFT: AdvancedDraft = { method: "GET", headers: [], body: "", proxy: false };

const EMPTY_ROW: HeaderRow = { name: "", value: "" };

export function toRequestOptions(draft: AdvancedDraft): RequestOptions {
  const headers: Record<string, string> = {};
  for (const { name, value } of draft.headers) {
    if (name.trim()) headers[name.trim()] = value;
  }
  const body = draft.method !== "GET" && draft.body !== "" ? draft.body : undefined;
  return { method: draft.method, headers, body, proxy: draft.proxy };
}

export function fromRequestOptions(options: RequestOptions): AdvancedDraft {
  return {
    method: options.method,
    headers: Object.entries(options.headers).map(([name, value]) => ({ name, value })),
    body: options.body ?? "",
    proxy: options.proxy,
  };
}

/** A short description of non-default options, e.g. `POST · 2 headers · EU proxy`. */
export function describeOptions(options: RequestOptions): string {
  const headerCount = Object.keys(options.headers).length;
  return [
    options.method !== "GET" && options.method,
    headerCount > 0 && `${headerCount} header${headerCount === 1 ? "" : "s"}`,
    options.body !== undefined && "body",
    options.proxy && "EU proxy",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** How many options differ from a plain GET, for the toggle's badge. */
export function countActive(draft: AdvancedDraft): number {
  const options = toRequestOptions(draft);
  return (
    (options.method !== "GET" ? 1 : 0) +
    Object.keys(options.headers).length +
    (options.body !== undefined ? 1 : 0) +
    (options.proxy ? 1 : 0)
  );
}

interface AdvancedOptionsProps {
  id: string;
  /** Id of the URL form, so Enter in these fields submits it. */
  form: string;
  value: AdvancedDraft;
  onChange: (value: AdvancedDraft) => void;
}

/** Method, headers, body and proxy overrides for the page request. */
export function AdvancedOptions({ id, form, value, onChange }: AdvancedOptionsProps) {
  const last = value.headers.at(-1);
  // Always offer a blank row to type a new header into.
  const rows = !last || last.name || last.value ? [...value.headers, EMPTY_ROW] : value.headers;

  const setRow = (index: number, row: HeaderRow) => {
    const headers = [...value.headers];
    headers[index] = row;
    onChange({ ...value, headers });
  };
  const removeRow = (index: number) =>
    onChange({ ...value, headers: value.headers.filter((_, i) => i !== index) });

  return (
    <fieldset id={id} className="advanced-options" aria-label="Advanced request options">
      <label className="advanced-field">
        <span>Method</span>
        <select
          form={form}
          value={value.method}
          onChange={(e) => onChange({ ...value, method: e.target.value as RequestMethod })}
        >
          {REQUEST_METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>

      <div className="advanced-field">
        <span>Proxy</span>
        <label className="advanced-checkbox">
          <input
            form={form}
            type="checkbox"
            checked={value.proxy}
            onChange={(e) => onChange({ ...value, proxy: e.target.checked })}
          />
          Proxy (EU)
          <span className="meta">Route requests, including network capture, via the EU proxy</span>
        </label>
      </div>

      <div className="advanced-field">
        <span>Headers</span>
        <div className="header-rows">
          {rows.map((row, i) => (
            <div key={i} className="header-row">
              <input
                form={form}
                type="text"
                placeholder="Header-Name"
                value={row.name}
                onChange={(e) => setRow(i, { ...row, name: e.target.value })}
                aria-label={`Header ${i + 1} name`}
                spellCheck={false}
              />
              <input
                form={form}
                type="text"
                placeholder="value"
                value={row.value}
                onChange={(e) => setRow(i, { ...row, value: e.target.value })}
                aria-label={`Header ${i + 1} value`}
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => removeRow(i)}
                disabled={i >= value.headers.length}
                aria-label={`Remove header ${i + 1}`}
                title="Remove header"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {value.method !== "GET" && (
        <label className="advanced-field">
          <span>Body</span>
          <textarea
            form={form}
            rows={4}
            placeholder={'{"key": "value"}'}
            value={value.body}
            onChange={(e) => onChange({ ...value, body: e.target.value })}
            spellCheck={false}
          />
        </label>
      )}

      <div className="advanced-actions">
        <span className="meta">
          Headers override the defaults and only apply to the page request.
        </span>
        <button type="button" className="small" onClick={() => onChange(EMPTY_DRAFT)}>
          Reset
        </button>
      </div>
    </fieldset>
  );
}
