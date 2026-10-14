import type { StandardSchemaV1 } from "@standard-schema/spec";

export type { StandardSchemaV1 };

export type ValidationResult<TOutput> =
  | { success: true; value: TOutput }
  | { success: false; issues: readonly StandardSchemaV1.Issue[] };

/** Runs any Standard Schema compliant validator (Zod, Valibot, ArkType, ...). */
export async function validate<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<TSchema>>> {
  let result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    result = await result;
  }

  if (result.issues) {
    return { success: false, issues: result.issues };
  }

  return { success: true, value: result.value as StandardSchemaV1.InferOutput<TSchema> };
}
