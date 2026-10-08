import { queryOptions } from "@tanstack/react-query";
import type {
  GenerateParams,
  TypegenMeta,
  TypegenRequest,
  TypegenRequestBody,
  TypegenResponse,
} from "./protocol.ts";

// quicktype is large, so the worker (and the library) only load once a dialog that can
// generate types opens (see preloadTypegen), and then stay alive for later dialogs.
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (r: TypegenResponse) => void }>();

function call(request: TypegenRequestBody): Promise<TypegenResponse> {
  if (!worker) {
    worker = new Worker(new URL("./typegen.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<TypegenResponse>) => {
      pending.get(event.data.id)?.resolve(event.data);
      pending.delete(event.data.id);
    });
  }
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    const message: TypegenRequest = { ...request, id };
    worker!.postMessage(message);
  });
}

export async function fetchTypegenMeta(): Promise<TypegenMeta> {
  const res = await call({ type: "meta" });
  if (!res.ok) throw new Error(res.error);
  return res.meta!;
}

/** Shared by TypegenPanel and the dialog's preload so they hit the same cache entry. */
export const typegenMetaQuery = queryOptions({
  queryKey: ["typegen-meta"],
  queryFn: fetchTypegenMeta,
  staleTime: Infinity,
  gcTime: Infinity,
});

export async function generateTypes(params: GenerateParams): Promise<string> {
  const res = await call({ type: "generate", params });
  if (!res.ok) throw new Error(res.error);
  return res.code!;
}
