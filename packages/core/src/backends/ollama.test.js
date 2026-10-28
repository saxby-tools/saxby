import { assertEquals, assertRejects } from "@std/assert";
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

//  =====================================================================
//  fetchResidency
//  =====================================================================
//  The memory broker budgets with these sizes, so an answer it cannot
//  read must throw rather than look like free memory. The fixture is
//  a real /api/ps answer from 2026-10-27, trimmed to the fields read.

const PS_QWEN = {
    name: "qwen3.8:27b",
    model: "qwen3.8:27b",
    size: 27490963176,
    size_vram: 27490963176,
    context_length: 32768,
    runner: "mlx",
};

async function residency(response) {
    const restore = stubShow(response);

    try {
        return await OllamaAdapter.fetchResidency(URL);
    } finally {
        restore();
    }
}

Deno.test("residency reads each model's GPU size", async () => {
    const got = await residency({ body: { models: [PS_QWEN] } });

    assertEquals(got, [{
        name: "qwen3.8:27b",
        bytes: 27490963176,
        partial: false,
    }]);
});

Deno.test("residency marks a model Ollama spilled to the CPU", async () => {
    const got = await residency({
        body: { models: [{ ...PS_QWEN, size_vram: 20000000000 }] },
    });

    assertEquals(got[0].bytes, 20000000000);
    assertEquals(got[0].partial, true);
});

Deno.test("residency treats a missing size as a partial load", async () => {
    const got = await residency({
        body: { models: [{ name: "qwen3.8:27b", size_vram: 27490963176 }] },
    });

    assertEquals(got[0].partial, true);
});

Deno.test("residency spells an untagged name as Ollama does", async () => {
    const got = await residency({
        body: {
            models: [{ name: "bge-m3", size: 689000000, size_vram: 689000000 }],
        },
    });

    assertEquals(got, [{
        name: "bge-m3:latest",
        bytes: 689000000,
        partial: false,
    }]);
});

Deno.test("nothing loaded is an empty list, not an error", async () => {
    const got = await residency({ body: { models: [] } });

    assertEquals(got, []);
});

Deno.test("an HTTP error from /api/ps throws", async () => {
    await assertRejects(() =>
        residency({ status: 500, body: { error: "boom" } })
    );
});

Deno.test("an unreachable backend throws, never reads as empty", async () => {
    await assertRejects(() => residency(new TypeError("connection refused")));
});

Deno.test("a model with no size_vram throws", async () => {
    await assertRejects(
        () => residency({ body: { models: [{ name: "qwen3.8:27b" }] } }),
        Error,
        "size_vram",
    );
});

Deno.test("an answer with no models list throws", async () => {
    await assertRejects(() => residency({ body: {} }));
});

//  =====================================================================
//  canonicalName
//  =====================================================================

Deno.test("a name without a tag gets latest", () => {
    assertEquals(OllamaAdapter.canonicalName("bge-m3"), "bge-m3:latest");
});

Deno.test("a tagged name is left alone", () => {
    assertEquals(OllamaAdapter.canonicalName("qwen3.8:27b"), "qwen3.8:27b");
});

Deno.test("a hub path without a tag gets latest", () => {
    const name = "hf.co/ggml-org/Voxtral-Mini-3B-2507-GGUF";

    assertEquals(OllamaAdapter.canonicalName(name), `${name}:latest`);
});

Deno.test("a registry port is not mistaken for a tag", () => {
    assertEquals(
        OllamaAdapter.canonicalName("localhost:5000/team/model"),
        "localhost:5000/team/model:latest",
    );
});
