import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "@hono/hono";
import { registerCatchAll } from "./catch-all.js";

//  =====================================================================
//  The memory gate in the catch-all
//  =====================================================================
//  The broker's own decisions are tested in memory/broker.test.js and
//  the shared gate in memory/gate.js. These pin the catch-all's side:
//  with no job held nothing is read and the broker is not asked; with
//  one held, a JSON POST to an inference path is gated on its model,
//  a refusal never reaches the backend, and an admitted load's hold is
//  freed. Everything else is forwarded as it came.

const CONFIG = { upstream_url: "http://ollama.test" };

const GATED_PATHS = [
    "/api/chat",
    "/api/generate",
    "/api/embed",
    "/api/embeddings",
    "/v1/completions",
    "/v1/embeddings",
];

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

//  The catch-all hands fetch a Request, so the stub reads one.
function stubUpstream() {
    const original = globalThis.fetch;
    const requests = [];

    globalThis.fetch = async (request) => {
        requests.push({
            url: request.url,
            method: request.method,
            body: await request.text(),
            headers: request.headers,
        });

        return Response.json({ response: "ok" });
    };

    return {
        requests,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

function app(broker, sentApiToken = false, config = CONFIG) {
    const server = new Hono();

    server.use("*", async (c, next) => {
        c.set("config", config);
        c.set("broker", broker);

        if (sentApiToken) {
            c.set("sentApiToken", true);
        }

        await next();
    });

    registerCatchAll(server);

    return server;
}

function post(server, path, body, headers = {}) {
    return server.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
    });
}

function postJson(server, path, body) {
    return post(server, path, JSON.stringify(body));
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

Deno.test("catch-all — no job held: the broker is not asked", async () => {
    const upstream = stubUpstream();
    const { broker, calls } = fakeBroker({ hasJobs: false });

    try {
        const res = await quietly(() =>
            postJson(app(broker), "/api/chat", { model: "voxtral:32k" })
        );

        await res.text();

        assertEquals(res.status, 200);
        assertEquals(calls.gate, []);
        assertEquals(upstream.requests.length, 1);
        assertEquals(upstream.requests[0].url, "http://ollama.test/api/chat");
        assertEquals(
            JSON.parse(upstream.requests[0].body).model,
            "voxtral:32k",
        );
    } finally {
        upstream.restore();
    }
});

Deno.test("catch-all — every inference path is gated", async () => {
    for (const path of GATED_PATHS) {
        const upstream = stubUpstream();
        const { broker, calls } = fakeBroker({ hasJobs: true });

        try {
            const res = await quietly(() =>
                postJson(app(broker), path, { model: "voxtral:32k" })
            );

            await res.text();

            assertEquals(res.status, 200, path);
            assertEquals(calls.gate.length, 1, path);
            assertEquals(calls.gate[0].model, "voxtral:32k", path);
            assertEquals(upstream.requests.length, 1, path);
            assertEquals(
                JSON.parse(upstream.requests[0].body).model,
                "voxtral:32k",
                path,
            );
        } finally {
            upstream.restore();
        }
    }
});

Deno.test("catch-all — an admitted load's hold is freed", async () => {
    const upstream = stubUpstream();
    const { broker, calls } = fakeBroker({ hasJobs: true });

    try {
        const res = await quietly(() =>
            postJson(app(broker), "/api/generate", { model: "voxtral:32k" })
        );

        await res.text();

        assertEquals(calls.released, 1);
    } finally {
        upstream.restore();
    }
});

Deno.test("catch-all — a refusal never reaches the backend", async () => {
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
        const res = await quietly(() =>
            postJson(app(broker), "/api/embed", { model: "voxtral:32k" })
        );
        const body = await res.json();

        assertEquals(res.status, 503);
        assertEquals(body.error.code, "memory_unavailable");
        assertEquals(body.error.type, "server_error");
        assertStringIncludes(body.error.message, "needs 10.0 GiB");
        assertEquals(calls.gate[0].model, "voxtral:32k");
        assertEquals(upstream.requests, []);
    } finally {
        upstream.restore();
    }
});

Deno.test("catch-all — a client that left gets 499", async () => {
    const upstream = stubUpstream();
    const { broker } = fakeBroker({
        hasJobs: true,
        verdict: { admitted: false, code: "abandoned" },
    });

    try {
        const res = await quietly(() =>
            postJson(app(broker), "/api/chat", { model: "voxtral:32k" })
        );

        await res.body?.cancel();

        assertEquals(res.status, 499);
        assertEquals(upstream.requests, []);
    } finally {
        upstream.restore();
    }
});

Deno.test("catch-all — a non-JSON body goes through ungated", async () => {
    const upstream = stubUpstream();
    const { broker, calls } = fakeBroker({ hasJobs: true });

    try {
        const res = await quietly(() =>
            post(app(broker), "/api/generate", "model: voxtral:32k")
        );

        await res.text();

        assertEquals(res.status, 200);
        assertEquals(calls.gate, []);
        assertEquals(upstream.requests[0].body, "model: voxtral:32k");
    } finally {
        upstream.restore();
    }
});

Deno.test("catch-all — no model named: goes through ungated", async () => {
    const bodies = [
        { prompt: "hello" },
        { model: "" },
        { model: 7 },
        [],
    ];

    for (const body of bodies) {
        const upstream = stubUpstream();
        const { broker, calls } = fakeBroker({ hasJobs: true });

        try {
            const res = await quietly(() =>
                postJson(app(broker), "/api/chat", body)
            );

            await res.text();

            assertEquals(res.status, 200);
            assertEquals(calls.gate, []);
            assertEquals(upstream.requests[0].body, JSON.stringify(body));
        } finally {
            upstream.restore();
        }
    }
});

Deno.test("catch-all — other paths and methods are never gated", async () => {
    const cases = [
        ["GET", "/api/tags", undefined],
        ["GET", "/api/chat", undefined],
        ["POST", "/api/show", JSON.stringify({ model: "voxtral:32k" })],
        ["POST", "/api/ps", JSON.stringify({ model: "voxtral:32k" })],
    ];

    for (const [method, path, body] of cases) {
        const upstream = stubUpstream();
        const { broker, calls } = fakeBroker({ hasJobs: true });

        try {
            const res = await quietly(() =>
                app(broker).request(path, { method, body })
            );

            await res.text();

            const label = `${method} ${path}`;

            assertEquals(res.status, 200, label);
            assertEquals(calls.gate, [], label);
            assertEquals(upstream.requests.length, 1, label);
            assertEquals(upstream.requests[0].method, method, label);
        } finally {
            upstream.restore();
        }
    }
});

Deno.test("catch-all — the path and query reach the backend", async () => {
    const upstream = stubUpstream();
    const { broker } = fakeBroker({ hasJobs: false });

    try {
        const res = await quietly(() =>
            app(broker).request("/api/version?verbose=1")
        );

        await res.text();

        assertEquals(
            upstream.requests[0].url,
            "http://ollama.test/api/version?verbose=1",
        );
    } finally {
        upstream.restore();
    }
});

//  =====================================================================
//  The API token stops at Saxby
//  =====================================================================
//  main.js flags a request that carried Saxby's own token. The
//  catch-all must not hand that secret to the backend; any other
//  Authorization value still passes.

async function upstreamHeadersFor(sentApiToken) {
    const upstream = stubUpstream();
    const { broker } = fakeBroker({ hasJobs: false });

    try {
        const res = await quietly(() =>
            app(broker, sentApiToken).request("/api/tags", {
                headers: {
                    "Authorization": "Bearer the-secret",
                    "Accept-Encoding": "gzip",
                },
            })
        );

        await res.text();

        return upstream.requests[0].headers;
    } finally {
        upstream.restore();
    }
}

Deno.test("catch-all — Saxby's own token stops at Saxby", async () => {
    const headers = await upstreamHeadersFor(true);

    assertEquals(headers.get("authorization"), null);
});

Deno.test("catch-all — any other Authorization is passed on", async () => {
    const headers = await upstreamHeadersFor(false);

    assertEquals(headers.get("authorization"), "Bearer the-secret");
});

//  =====================================================================
//  Open WebUI's user headers
//  =====================================================================
//  With ENABLE_FORWARD_USER_INFO_HEADERS on, Open WebUI names the
//  person at the keyboard in X-OpenWebUI-User-* headers, on embedding
//  requests as well as chat. Through v0.9.9 the catch-all passed them
//  on while the chat route did not (issue #22). Now they stop here
//  unless forward_user_headers says otherwise, and a header that only
//  shares the vendor prefix is left alone either way.

const USER_HEADERS = {
    "X-OpenWebUI-User-Name": "Someone",
    "X-OpenWebUI-User-Id": "00000000-0000-0000-0000-000000000000",
    "X-OpenWebUI-User-Email": "someone@example.com",
    "X-OpenWebUI-User-Role": "admin",
    "X-OpenWebUI-User-Jwt": "a.b.c",
};

const OTHER_HEADER = "X-OpenWebUI-Other";

async function upstreamHeadersWith(config) {
    const upstream = stubUpstream();
    const { broker } = fakeBroker({ hasJobs: false });

    try {
        const res = await quietly(() =>
            post(app(broker, false, config), "/v1/embeddings", "{}", {
                ...USER_HEADERS,
                [OTHER_HEADER]: "kept",
            })
        );

        await res.text();

        return upstream.requests[0].headers;
    } finally {
        upstream.restore();
    }
}

Deno.test("catch-all — user headers stop at Saxby by default", async () => {
    const headers = await upstreamHeadersWith(CONFIG);

    for (const name of Object.keys(USER_HEADERS)) {
        assertEquals(headers.get(name), null, name);
    }

    assertEquals(headers.get(OTHER_HEADER), "kept");
});

Deno.test("catch-all — the switch passes them on as sent", async () => {
    const headers = await upstreamHeadersWith({
        ...CONFIG,
        forward_user_headers: true,
    });

    for (const [name, value] of Object.entries(USER_HEADERS)) {
        assertEquals(headers.get(name), value, name);
    }

    assertEquals(headers.get(OTHER_HEADER), "kept");
});
