import { assertEquals } from "@std/assert";
import { OllamaAdapter } from "./ollama.js";

//  =====================================================================
//  fetchModelDetails
//  =====================================================================
//  Image and audio support are requirements, so they must come from
//  what Ollama reports for this exact model. These cases use real
//  /api/show capability lists from 2026-10-26.

const URL = "http://ollama.test";

function stubShow(response) {
    const original = globalThis.fetch;

    globalThis.fetch = () => {
        if (response instanceof Error) {
            return Promise.reject(response);
        }

        return Promise.resolve(Response.json(response.body, {
            status: response.status ?? 200,
        }));
    };

    return () => {
        globalThis.fetch = original;
    };
}

function quietly(fn) {
    const warn = console.warn;
    console.warn = () => {};

    return fn().finally(() => {
        console.warn = warn;
    });
}

async function details(response) {
    const restore = stubShow(response);

    try {
        return await quietly(() =>
            OllamaAdapter.fetchModelDetails("model", URL)
        );
    } finally {
        restore();
    }
}

Deno.test("a vision model reports vision but not audio", async () => {
    const got = await details({
        body: {
            capabilities: ["completion", "vision", "tools", "thinking"],
            model_info: { "gemma4.context_length": 262144 },
        },
    });

    assertEquals(got, { max_context: 262144, vision: true, audio: false });
});

Deno.test("an audio model reports audio", async () => {
    const got = await details({
        body: {
            capabilities: ["completion", "vision", "audio"],
            model_info: { "gemma4.context_length": 131072 },
        },
    });

    assertEquals(got, { max_context: 131072, vision: true, audio: true });
});

Deno.test("a text-only model reports neither", async () => {
    const got = await details({
        body: {
            capabilities: ["completion", "tools"],
            model_info: { "granitehybrid.context_length": 1048576 },
        },
    });

    assertEquals(got, { max_context: 1048576, vision: false, audio: false });
});

Deno.test("no capabilities list reports neither", async () => {
    const got = await details({
        body: { model_info: { "llama.context_length": 8192 } },
    });

    assertEquals(got, { max_context: 8192, vision: false, audio: false });
});

Deno.test("capabilities survive a missing context length", async () => {
    const got = await details({
        body: { capabilities: ["completion", "vision"], model_info: {} },
    });

    assertEquals(got, { max_context: 4096, vision: true, audio: false });
});

Deno.test("an HTTP error claims nothing", async () => {
    const got = await details({ status: 404, body: { error: "not found" } });

    assertEquals(got, { max_context: 4096, vision: false, audio: false });
});

Deno.test("an unreachable backend claims nothing", async () => {
    const got = await details(new TypeError("connection refused"));

    assertEquals(got, { max_context: 4096, vision: false, audio: false });
});
