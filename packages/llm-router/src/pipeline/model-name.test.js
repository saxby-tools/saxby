//  =====================================================================
//  Requested model names
//  =====================================================================
//  Pure unit tests. The names below are shapes, not real catalog
//  entries.
//
//  Run:  deno test packages/llm-router/src/pipeline/

import { assertEquals } from "@std/assert";
import { classifyModel, SAXBY_MODEL, SAXBY_PREFIX } from "./model-name.js";

Deno.test("saxby routes", () => {
    assertEquals(classifyModel("saxby"), { mode: "route", target: null });
});

Deno.test("saxby/<model> bypasses to the model", () => {
    assertEquals(classifyModel("saxby/granite4:micro-h"), {
        mode: "bypass",
        target: "granite4:micro-h",
    });
});

Deno.test("only the first saxby/ is stripped", () => {
    assertEquals(classifyModel("saxby/saxby"), {
        mode: "bypass",
        target: "saxby",
    });

    assertEquals(classifyModel("saxby/org/model:tag"), {
        mode: "bypass",
        target: "org/model:tag",
    });
});

Deno.test("a bare saxby/ bypasses to an empty target", () => {
    assertEquals(classifyModel("saxby/"), { mode: "bypass", target: "" });
});

Deno.test("any other name passes through raw", () => {
    assertEquals(classifyModel("gemma4:31b"), {
        mode: "raw",
        target: "gemma4:31b",
    });

    assertEquals(classifyModel("Saxby"), { mode: "raw", target: "Saxby" });
    assertEquals(classifyModel("saxbyd"), { mode: "raw", target: "saxbyd" });
});

Deno.test("a missing name is raw with an empty target", () => {
    assertEquals(classifyModel(undefined), { mode: "raw", target: "" });
    assertEquals(classifyModel(null), { mode: "raw", target: "" });
    assertEquals(classifyModel(""), { mode: "raw", target: "" });
});

Deno.test("the prefix is the model name plus a slash", () => {
    assertEquals(SAXBY_PREFIX, `${SAXBY_MODEL}/`);
});
