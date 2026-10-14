export interface LanguageOption {
  name: string;
  description: string;
  optionType: "string" | "boolean" | "enum";
  defaultValue: string | boolean;
  /** Enum choices. */
  values?: string[];
  kind: "primary" | "secondary";
}

export interface LanguageMeta {
  name: string;
  displayName: string;
  extension: string;
  options: LanguageOption[];
}

export interface InferenceFlagMeta {
  name: string;
  description: string;
  defaultValue: boolean;
}

export interface TypegenMeta {
  languages: LanguageMeta[];
  inferenceFlags: InferenceFlagMeta[];
}

export interface GenerateParams {
  json: string;
  lang: string;
  topLevel: string;
  rendererOptions: Record<string, string>;
  /** Inference flags plus `allPropertiesOptional` / `alphabetizeProperties`. */
  flags: Record<string, boolean>;
}

export type TypegenRequestBody = { type: "meta" } | { type: "generate"; params: GenerateParams };

export type TypegenRequest = TypegenRequestBody & { id: number };

export type TypegenResponse =
  | { id: number; ok: true; meta?: TypegenMeta; code?: string }
  | { id: number; ok: false; error: string };
