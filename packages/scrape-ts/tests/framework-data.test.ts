import { describe, expect, test } from "vite-plus/test";
import {
  parseTextRemixDeferredBody,
  parseTextXScriptTurboStreamBody,
  TEXT_REMIX_DEFERRED_CONTENT_TYPE,
  TEXT_X_SCRIPT_CONTENT_TYPE,
} from "../src/index.ts";

describe("parseTextRemixDeferredBody", () => {
  test("resolves deferred placeholders from later sections", async () => {
    const body =
      '{"a":1,"b":"__deferred_promise:b","c":"__deferred_promise:c"}\n\n' +
      'data:{"b":{"x":"y:z"}}\n\n' +
      'data:{"c":[1,2]}\n\n';
    await expect(parseTextRemixDeferredBody(body)).resolves.toEqual({
      a: 1,
      b: { x: "y:z" },
      c: [1, 2],
    });
  });

  test("accepts a body with only critical data", async () => {
    await expect(parseTextRemixDeferredBody('{"plain":true}')).resolves.toEqual({ plain: true });
  });

  test("rejects when a deferred value errored", async () => {
    const body = '{"a":"__deferred_promise:a"}\n\nerror:{"a":{"message":"boom"}}\n\n';
    await expect(parseTextRemixDeferredBody(body)).rejects.toThrow("boom");
  });

  test("matches the content type", () => {
    expect(TEXT_REMIX_DEFERRED_CONTENT_TYPE.test("text/remix-deferred; charset=utf-8")).toBe(true);
    expect(TEXT_REMIX_DEFERRED_CONTENT_TYPE.test("application/json")).toBe(false);
  });
});

describe("parseTextXScriptTurboStreamBody", () => {
  // Produced by turbo-stream@2.4.1 `encode`, which React Router 7 vendors.
  const body = [
    '[{"_1":2,"_20":21},"root",{"_3":4},"data",{"_5":6},"user",{"_7":8,"_9":10,"_11":12,"_19":12},"name","Ann","joined",["D",0],"shared",{"_13":14,"_15":16},"id",7,"tags",[17,18],"a","b","again","routes/item",{"_3":22},{"_23":24,"_25":26,"_28":29,"_30":31,"_33":34,"_38":39,"_40":41,"_42":43},"title","hello","nums",[27,-2,-4,-6,-5,-7],1,"big",["B","10"],"set",["S",27,32],2,"map",["M",35,36],"k",{"_37":27},"v","url",["U","https://x.dev/a"],"slow",["P",41],"bad",["P",43]]',
    'P41:[{"_45":46,"_11":12},"reviews",[47],{"_48":49},"stars",5]',
    'E43:[["E","nope"]]',
    "",
  ].join("\n");

  test("resolves references, streamed promises and rich types", () => {
    const shared = { id: 7, tags: ["a", "b"] };
    const result = parseTextXScriptTurboStreamBody<any>(body);
    expect(result).toEqual({
      root: { data: { user: { name: "Ann", joined: new Date(0), shared, again: shared } } },
      "routes/item": {
        data: {
          title: "hello",
          nums: [1, Number.NaN, -0, Number.POSITIVE_INFINITY, null, undefined],
          big: 10n,
          set: [1, 2],
          map: { k: { v: 1 } },
          url: "https://x.dev/a",
          slow: { reviews: [{ stars: 5 }], shared },
          bad: { name: "Error", message: "nope" },
        },
      },
    });
    // Shared references stay shared.
    expect(result.root.data.user.again).toBe(result.root.data.user.shared);
    expect(result["routes/item"].data.slow.shared).toBe(result.root.data.user.shared);
  });

  test("decodes React Router single-fetch plugin values", () => {
    // turbo-stream `encode` output using React Router's single-fetch plugins.
    const rrBody =
      '[{"_1":2,"_7":8},"routes/a",{"_3":4},"error",["SanitizedError",5,6],"Error","Unexpected Server Error","routes/b",{"_3":9},["ErrorResponse",10,13,14],{"_11":12},"reason","missing",404,"Not Found"]';
    expect(parseTextXScriptTurboStreamBody(rrBody)).toEqual({
      "routes/a": { error: { name: "Error", message: "Unexpected Server Error" } },
      "routes/b": { error: { status: 404, statusText: "Not Found", data: { reason: "missing" } } },
    });
  });

  test("leaves never-settled promises undefined", () => {
    expect(parseTextXScriptTurboStreamBody('[{"_1":2},"later",["P",2]]')).toEqual({
      later: undefined,
    });
  });

  test("throws SyntaxError on malformed bodies", () => {
    expect(() => parseTextXScriptTurboStreamBody("")).toThrow(SyntaxError);
    expect(() => parseTextXScriptTurboStreamBody("{not json")).toThrow(SyntaxError);
    expect(() => parseTextXScriptTurboStreamBody('[{"_1":2},"a",3]\nX1:[1]')).toThrow(SyntaxError);
  });

  test("matches the content type", () => {
    expect(TEXT_X_SCRIPT_CONTENT_TYPE.test("text/x-script")).toBe(true);
    expect(TEXT_X_SCRIPT_CONTENT_TYPE.test("text/javascript")).toBe(false);
  });
});
