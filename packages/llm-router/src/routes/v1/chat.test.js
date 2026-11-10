import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "@hono/hono";
import { registerChatRoutes } from "./chat.js";

//  =====================================================================
//  The memory gate in the chat route
//  =====================================================================
//  The broker's own decisions are tested in memory/broker.test.js.
//  These pin the route's side: a refusal never reaches the backend,
//  and with no job held the broker is not even asked. Bypass requests
//  keep routing out of the way; they are gated like any other.

const CONFIG = {
    upstream_url: "http://ollama.test",
    catalog: { "voxtral:32k": { name: "voxtral:32k", max_context: 32768 } },
    personas: {},
    client_names: {},
};

function fakeBroker(options = {}) {
    const calls = { gate: [], released: 0 };

    const broker = {
        hasJobs: () => options.hasJobs ?? false,
        gateLoad: (model, context) => {
            calls.gate.push({ model, requestId: context.requestId });

            return Promise.resolve(
                options.verdict ?? {
                    admitted: true,
                    hold: { release: () => calls.released++ },
                },
            );
        },
    };

    return { broker, calls };
}

function stubUpstream() {
    const original = globalThis.fetch;
    const requests = [];

    globalThis.fetch = (url, init) => {
        requests.push({
            url,
            body: JSON.parse(init.body),
            headers: init.headers,
        });

        return Promise.resolve(Response.json({ choices: [] }));
    };

    return {
        requests,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

function app(broker) {
    const server = new Hono();

    server.use("*", async (c, next) => {
        c.set("config", CONFIG);
        c.set("log", null);
        c.set("semantic", null);
        c.set("broker", broker);
        await next();
    });

    registerChatRoutes(server);

    return server;
}

function chat(server) {
    return server.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "saxby/voxtral:32k",
            messages: [{ role: "user", content: "hello" }],
        }),
    });
}

async function quietly(fn) {
    const log = console.log;
    const warn = console.warn;

    console.log = () => {};
    console.warn = () => {};

    try {
        return await fn();
    } finally {
        console.log = log;
        console.warn = warn;
    }
}

Deno.test("chat — with no job held, the broker is not asked", async () => {
    const upstream = stubUpstream();
    const { broker, calls } = fakeBroker({ hasJobs: false });

    try {
        const res = await quietly(() => chat(app(broker)));

        await res.body?.cancel();

        assertEquals(calls.gate, []);
        assertEquals(upstream.requests.length, 1);
    } finally {
        upstream.restore();
    }
});

Deno.test("chat — a refused load never reaches the backend", async () => {
    const upstream = stubUpstream();
    const { broker, calls } = fakeBroker({
        hasJobs: true,
        verdict: {
            admitted: false,
            code: "memory_unavailable",
            reason: "'voxtral:32k' needs 10.0 GiB; 2.0 GiB free",
        },
    });

    try {
        const res = await quietly(() => chat(app(broker)));
        const body = await res.json();

        assertEquals(res.status, 503);
        assertEquals(body.error.code, "memory_unavailable");
        assertStringIncludes(body.error.message, "needs 10.0 GiB");
        assertEquals(calls.gate[0].model, "voxtral:32k");
        assertEquals(upstream.requests, []);
    } finally {
        upstream.restore();
    }
});

Deno.test("chat — an admitted load is sent and its hold freed", async () => {
    const upstream = stubUpstream();
    const { broker, calls } = fakeBroker({ hasJobs: true });

    try {
        const res = await quietly(() => chat(app(broker)));

        await res.text();

        assertEquals(res.status, 200);
        assertEquals(upstream.requests[0].body.model, "voxtral:32k");
        assertEquals(calls.released, 1);
    } finally {
        upstream.restore();
    }
});

//  =====================================================================
//  Client defaults
//  =====================================================================
//  A client that cannot send a field itself gets it from the config.
//  These pin three things: the field reaches the backend, the client's
//  own value is never replaced, and the decision log is told.

const KEYBOARD = "LeanType/1.0";

const DEFAULTS_CONFIG = {
    ...CONFIG,
    global_default_model: "voxtral:32k",
    client_defaults: { leantype: { reasoning_effort: "none" } },
};

function fakeLog() {
    const entries = [];

    const log = {
        record: (entry) => {
            entries.push(entry);

            return "log-1";
        },
        complete: () => {},
        hashPrompt: () => Promise.resolve("hash"),
    };

    return { log, entries };
}

function appWithDefaults(log = null) {
    const server = new Hono();
    const { broker } = fakeBroker({ hasJobs: false });

    server.use("*", async (c, next) => {
        c.set("config", DEFAULTS_CONFIG);
        c.set("log", log);
        c.set("semantic", null);
        c.set("broker", broker);
        await next();
    });

    registerChatRoutes(server);

    return server;
}

function send(server, userAgent, fields = {}) {
    return server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": userAgent,
        },
        body: JSON.stringify({
            model: "saxby/voxtral:32k",
            messages: [{ role: "user", content: "hello" }],
            ...fields,
        }),
    });
}

async function upstreamBodyFor(userAgent, fields, log) {
    const upstream = stubUpstream();

    try {
        const res = await quietly(
            () => send(appWithDefaults(log), userAgent, fields),
        );

        await res.text();

        return upstream.requests[0].body;
    } finally {
        upstream.restore();
    }
}

Deno.test("defaults — the named client gets the field", async () => {
    const body = await upstreamBodyFor(KEYBOARD);

    assertEquals(body.reasoning_effort, "none");
});

Deno.test("defaults — a routed request gets it too", async () => {
    const body = await upstreamBodyFor(KEYBOARD, { model: "saxby" });

    assertEquals(body.model, "voxtral:32k");
    assertEquals(body.reasoning_effort, "none");
});

Deno.test("defaults — the client's own value always stands", async () => {
    for (const effort of ["low", null]) {
        const body = await upstreamBodyFor(KEYBOARD, {
            reasoning_effort: effort,
        });

        assertEquals(body.reasoning_effort, effort);
    }
});

Deno.test("defaults — any other client is left alone", async () => {
    for (const userAgent of ["curl/8.7.1", "OpenAI/JS 7.20.0"]) {
        const body = await upstreamBodyFor(userAgent);

        assertEquals("reasoning_effort" in body, false, userAgent);
    }
});

Deno.test("defaults — the decision log is told what was added", async () => {
    const { log, entries } = fakeLog();

    await upstreamBodyFor(KEYBOARD, {}, log);

    assertEquals(entries[0].clientDefaults, { reasoning_effort: "none" });
});

Deno.test("defaults — nothing added is logged as nothing", async () => {
    const cases = [
        ["curl/8.7.1", {}],
        [KEYBOARD, { reasoning_effort: "low" }],
    ];

    for (const [userAgent, fields] of cases) {
        const { log, entries } = fakeLog();

        await upstreamBodyFor(userAgent, fields, log);

        assertEquals(entries[0].clientDefaults, null, userAgent);
    }
});

//  =====================================================================
//  The API token stops at Saxby
//  =====================================================================
//  main.js flags a request that carried Saxby's own token. The route
//  must not hand that secret to the backend. Any other Authorization
//  value still passes, as it always has.

function appWithToken(sentApiToken) {
    const server = new Hono();
    const { broker } = fakeBroker({ hasJobs: false });

    server.use("*", async (c, next) => {
        c.set("config", CONFIG);
        c.set("log", null);
        c.set("semantic", null);
        c.set("broker", broker);

        if (sentApiToken) {
            c.set("sentApiToken", true);
        }

        await next();
    });

    registerChatRoutes(server);

    return server;
}

async function upstreamHeadersFor(sentApiToken) {
    const upstream = stubUpstream();

    try {
        const res = await quietly(() =>
            appWithToken(sentApiToken).request("/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer the-secret",
                },
                body: JSON.stringify({
                    model: "saxby/voxtral:32k",
                    messages: [{ role: "user", content: "hello" }],
                }),
            })
        );

        await res.text();

        return upstream.requests[0].headers;
    } finally {
        upstream.restore();
    }
}

Deno.test("token — Saxby's own token stops at Saxby", async () => {
    const headers = await upstreamHeadersFor(true);

    assertEquals("Authorization" in headers, false);
    assertEquals(headers["Content-Type"], "application/json");
});

Deno.test("token — any other Authorization is passed on", async () => {
    const headers = await upstreamHeadersFor(false);

    assertEquals(headers.Authorization, "Bearer the-secret");
});

//  =====================================================================
//  The /command strip keeps the rest of the message
//  =====================================================================
//  A message can be parts: text beside an image or audio. Through
//  v0.9.8 the strip replaced the whole array with the clean text, so
//  a `/coder` prompt with a screenshot reached the model blind.

const PERSONA_CONFIG = {
    ...CONFIG,
    global_default_model: "voxtral:32k",
    personas: {
        coder: { default_model: "voxtral:32k", tags: ["TAG_CODER"] },
    },
};

function appWithPersona() {
    const server = new Hono();
    const { broker } = fakeBroker({ hasJobs: false });

    server.use("*", async (c, next) => {
        c.set("config", PERSONA_CONFIG);
        c.set("log", null);
        c.set("semantic", null);
        c.set("broker", broker);
        await next();
    });

    registerChatRoutes(server);

    return server;
}

Deno.test("strip — a /command message keeps its image part", async () => {
    const upstream = stubUpstream();
    const image = { type: "image_url", image_url: { url: "data:x" } };

    try {
        const res = await quietly(() =>
            appWithPersona().request("/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "saxby",
                    messages: [{
                        role: "user",
                        content: [
                            { type: "text", text: "/coder what is this" },
                            image,
                        ],
                    }],
                }),
            })
        );

        await res.text();

        const sent = upstream.requests[0].body;

        assertEquals(sent.model, "voxtral:32k");
        assertEquals(sent.messages[0].content, [
            { type: "text", text: "what is this" },
            image,
        ]);
    } finally {
        upstream.restore();
    }
});
