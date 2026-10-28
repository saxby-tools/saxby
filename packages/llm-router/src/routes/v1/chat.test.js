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
        requests.push({ url, body: JSON.parse(init.body) });

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
