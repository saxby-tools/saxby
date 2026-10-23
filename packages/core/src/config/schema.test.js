import { assert, assertThrows } from "@std/assert";
import { validateConfig } from "./schema.js";

function config(overrides = {}) {
    return {
        global_default_model: "model-a",
        catalog: { "model-a": { name: "model-a", max_context: 4096 } },
        personas: {},
        ...overrides,
    };
}

function messageFor(raw) {
    const error = assertThrows(() => validateConfig(raw));

    return error.message;
}

Deno.test("config — a valid config passes", () => {
    validateConfig(config());
});

Deno.test("config — a misspelled field is named plainly", () => {
    const message = messageFor(config({ listen_prot: 11435 }));

    assert(message.includes("unknown field 'listen_prot'"));
    assert(!message.includes("Expected never"));
});

Deno.test("config — every problem is listed, with its path", () => {
    const message = messageFor(config({
        listen_port: 80,
        catalog: { "model-a": { name: "model-a" } },
    }));

    assert(message.includes("listen_port: Port must be > 1023"));
    assert(message.includes("catalog.model-a.max_context"));
});

Deno.test("config — a model missing from the catalog is named", () => {
    const message = messageFor(config({ global_default_model: "ghost" }));

    assert(message.includes("global_default_model 'ghost'"));
});
