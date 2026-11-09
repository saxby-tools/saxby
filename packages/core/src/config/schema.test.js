import { assert, assertEquals, assertThrows } from "@std/assert";
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

Deno.test("config — prompt text is not logged unless asked for", () => {
    const parsed = validateConfig(config());

    assertEquals(parsed.log_prompts, false);
});

//  =====================================================================
//  Memory broker fields
//  =====================================================================

function pinnedModel(fields = {}) {
    return {
        catalog: {
            "model-a": { name: "model-a", max_context: 4096, ...fields },
        },
    };
}

Deno.test("config — a missing memory section gets every default", () => {
    const parsed = validateConfig(config());

    assertEquals(parsed.memory, {
        margin_gib: 8,
        wait_timeout_s: 120,
        heartbeat_interval_s: 10,
    });
});

Deno.test("config — a partial memory section keeps the rest", () => {
    const parsed = validateConfig(config({ memory: { margin_gib: 4 } }));

    assertEquals(parsed.memory.margin_gib, 4);
    assertEquals(parsed.memory.heartbeat_interval_s, 10);
});

Deno.test("config — models are not pinned unless they say so", () => {
    const parsed = validateConfig(config());

    assertEquals(parsed.catalog["model-a"].pinned, false);
});

Deno.test("config — a pinned model with a size passes", () => {
    const parsed = validateConfig(
        config(pinnedModel({ pinned: true, size_gib: 25.6 })),
    );

    assertEquals(parsed.catalog["model-a"].pinned, true);
    assertEquals(parsed.catalog["model-a"].size_gib, 25.6);
});

Deno.test("config — a size of zero is refused", () => {
    const message = messageFor(config(pinnedModel({ size_gib: 0 })));

    assert(message.includes("catalog.model-a.size_gib"));
});

Deno.test("config — a heartbeat under one second is refused", () => {
    const message = messageFor(
        config({ memory: { heartbeat_interval_s: 0 } }),
    );

    assert(message.includes("memory.heartbeat_interval_s"));
});

Deno.test("config — a misspelled memory field is named", () => {
    const message = messageFor(config({ memory: { margin: 8 } }));

    assert(message.includes("unknown field 'memory.margin'"));
});

Deno.test("config — an embedder profile may carry a size", () => {
    const parsed = validateConfig(config({
        semantic: {
            active: "bge-m3",
            profiles: {
                "bge-m3": {
                    model: "bge-m3",
                    dim: 1024,
                    threshold: 0.6,
                    size_gib: 0.7,
                },
            },
        },
    }));

    assertEquals(parsed.semantic.profiles["bge-m3"].size_gib, 0.7);
});

//  =====================================================================
//  Trusted proxies
//  =====================================================================

function proxy(fields = {}) {
    return {
        trusted_proxies: [{
            kind: "tailscale-serve",
            host: "box.example.ts.net",
            ...fields,
        }],
    };
}

Deno.test("config — no proxy is trusted unless one is named", () => {
    const parsed = validateConfig(config());

    assertEquals(parsed.trusted_proxies, []);
});

Deno.test("config — a Tailscale Serve proxy passes", () => {
    const parsed = validateConfig(config(proxy()));

    assertEquals(parsed.trusted_proxies, [{
        kind: "tailscale-serve",
        host: "box.example.ts.net",
    }]);
});

Deno.test("config — an unknown proxy kind is refused", () => {
    const message = messageFor(config(proxy({ kind: "caddy" })));

    assert(message.includes("trusted_proxies.0.kind"));
    assert(message.includes("tailscale-serve"));
});

Deno.test("config — a proxy host with a scheme or port is refused", () => {
    const hosts = [
        "https://box.example.ts.net",
        "box.example.ts.net:11435",
        "",
    ];

    for (const host of hosts) {
        const message = messageFor(config(proxy({ host })));

        assert(message.includes("trusted_proxies.0.host"), host);
    }
});

Deno.test("config — a proxy with no host is refused", () => {
    const message = messageFor(config({
        trusted_proxies: [{ kind: "tailscale-serve" }],
    }));

    assert(message.includes("trusted_proxies.0.host"));
});
