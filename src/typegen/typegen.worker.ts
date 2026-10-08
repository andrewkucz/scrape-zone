import {
  defaultInferenceFlags,
  defaultTargetLanguages,
  inferenceFlagsObject,
  InputData,
  isLanguageName,
  jsonInputForTargetLanguage,
  quicktype,
} from "quicktype-core";
import type {
  GenerateParams,
  LanguageOption,
  TypegenMeta,
  TypegenRequest,
  TypegenResponse,
} from "./protocol.ts";

function meta(): TypegenMeta {
  return {
    languages: defaultTargetLanguages.map((lang) => ({
      name: lang.name,
      displayName: lang.displayName,
      extension: lang.extension,
      options: lang.optionDefinitions.flatMap((o): LanguageOption[] =>
        o.kind === "cli"
          ? []
          : [
              {
                name: o.name,
                description: o.description,
                optionType: o.optionType,
                defaultValue:
                  typeof o.defaultValue === "boolean" || typeof o.defaultValue === "string"
                    ? o.defaultValue
                    : "",
                values: o.values ? Object.keys(o.values) : undefined,
                kind: o.kind ?? "primary",
              },
            ],
      ),
    })),
    inferenceFlags: Object.entries(inferenceFlagsObject).map(([name, flag]) => ({
      name,
      description: flag.description,
      defaultValue: defaultInferenceFlags[name as keyof typeof defaultInferenceFlags],
    })),
  };
}

async function generate({ json, lang, topLevel, rendererOptions, flags }: GenerateParams) {
  if (!isLanguageName(lang)) throw new Error(`Unknown language "${lang}"`);
  const input = jsonInputForTargetLanguage(lang);
  await input.addSource({ name: topLevel, samples: [json] });
  const inputData = new InputData();
  inputData.addInput(input);
  const result = await quicktype({ inputData, lang, rendererOptions, ...flags });
  return result.lines.join("\n");
}

self.addEventListener("message", async (event: MessageEvent<TypegenRequest>) => {
  const msg = event.data;
  let response: TypegenResponse;
  try {
    response =
      msg.type === "meta"
        ? { id: msg.id, ok: true, meta: meta() }
        : { id: msg.id, ok: true, code: await generate(msg.params) };
  } catch (error) {
    response = {
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  self.postMessage(response);
});
