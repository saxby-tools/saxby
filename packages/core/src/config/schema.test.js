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
//  Listening
//  =====================================================================

Deno.test("config — the bind defaults to loopback", () => {
    const parsed = validateConfig(config());

    assertEquals(parsed.listen_host, "127.0.0.1");
    assertEquals(parsed.allowed_hosts, []);
});

Deno.test("config — any listen_host is accepted as written", () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "localhost"]) {
        const parsed = validateConfig(config({ listen_host: host }));

        assertEquals(parsed.listen_host, host, host);
    }
});

Deno.test("config — an empty listen_host is refused", () => {
    const message = messageFor(config({ listen_host: "" }));

    assert(message.includes("listen_host must not be empty"));
});

Deno.test("config — allowed_hosts is a list of names", () => {
    const parsed = validateConfig(
        config({ allowed_hosts: ["saxby", "host.containers.internal"] }),
    );

    assertEquals(parsed.allowed_hosts, ["saxby", "host.containers.internal"]);
});

Deno.test("config — a non-string in allowed_hosts is named", () => {
    const message = messageFor(config({ allowed_hosts: ["saxby", 11435] }));

    assert(message.includes("allowed_hosts.1"));
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

//  =====================================================================
//  Client defaults
//  =====================================================================

Deno.test("config — no client gets a default unless one is set", () => {
    const parsed = validateConfig(config());

    assertEquals(parsed.client_defaults, {});
});

Deno.test("config — a client may have reasoning turned off", () => {
    const parsed = validateConfig(config({
        client_defaults: { leantype: { reasoning_effort: "none" } },
    }));

    assertEquals(parsed.client_defaults.leantype, {
        reasoning_effort: "none",
    });
});

Deno.test("config — any other reasoning_effort is refused", () => {
    for (const effort of ["low", "high", "off", false]) {
        const message = messageFor(config({
            client_defaults: { leantype: { reasoning_effort: effort } },
        }));

        assert(
            message.includes("client_defaults.leantype.reasoning_effort"),
            String(effort),
        );
    }
});

Deno.test("config — a client default Saxby cannot add is refused", () => {
    const message = messageFor(config({
        client_defaults: { leantype: { temperature: 0 } },
    }));

    assert(
        message.includes(
            "unknown field 'client_defaults.leantype.temperature'",
        ),
    );
});

Deno.test("config — a signature that could never match is refused", () => {
    for (const key of ["LeanType", "LeanType/1.0", "lean type"]) {
        const message = messageFor(config({
            client_defaults: { [key]: { reasoning_effort: "none" } },
        }));

        assert(message.includes("a client signature is lowercase"), key);
    }
});

//  =====================================================================
//  Allowed origins
//  =====================================================================

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

Deno.test("config — no browser origin is allowed unless listed", () => {
    const parsed = validateConfig(config());

    assertEquals(parsed.allowed_origins, []);
});

Deno.test("config — a browser extension's origin passes", () => {
    const origins = [
        EXTENSION,
        "moz-extension://1b2c3d4e-0000-4000-8000-123456789abc",
    ];

    const parsed = validateConfig(config({ allowed_origins: origins }));

    assertEquals(parsed.allowed_origins, origins);
});

Deno.test("config — anything but one extension is refused", () => {
    const origins = [
        "chrome-extension://*",
        "*",
        "https://example.com",
        "http://localhost:3000",
        `${EXTENSION}/`,
        `${EXTENSION}/popup.html`,
        "CHROME-EXTENSION://ABCDEF",
        "null",
    ];

    for (const origin of origins) {
        const message = messageFor(config({ allowed_origins: [origin] }));

        assert(message.includes("allowed_origins.0"), origin);
        assert(message.includes("one browser extension"), origin);
    }
});

Deno.test("config — an extension may have client defaults", () => {
    const parsed = validateConfig(config({
        client_defaults: {
            "ext-abcdefghijklmnopabcdefghijklmnop": {
                reasoning_effort: "none",
            },
        },
    }));

    assertEquals(Object.keys(parsed.client_defaults).length, 1);
});
