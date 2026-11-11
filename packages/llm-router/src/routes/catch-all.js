//  =====================================================================
//  The catch-all
//  =====================================================================
//  Whatever no route serves goes to the backend as it arrived, minus
//  the headers that break the forwarding, Saxby's own API token and,
//  unless `forward_user_headers` says otherwise, the headers that
//  name a person: the chat route reads the same switch, so the two
//  routes follow one rule (issue #22). Local programs only: the guard
//  keeps proxied, remote and extension clients to chat and the model
//  list before any route runs, so nothing here loosens that
//  (security/guard.js).
//
//  Six of the paths it forwards load the model their body names:
//  Ollama's own inference paths and the two OpenAI-style ones Saxby
//  does not serve itself. A POST to one of them is read for its
//  `model` on every request, job or no job. While a `saxby reserve`
//  job holds memory, the model is asked of the broker and the request
//  is forwarded once the load fits: the gate the chat route takes
//  (memory/gate.js). Through v0.9.8 these paths were not gated, so a
//  load could land on memory a job had reserved but not used yet
//  (issue #33). With no job held, the load is noted in the broker's
//  ledger until the response's first byte, as the chat route notes
//  its own: until the backend lists the model, a job that arrives now
//  would read its space as free. The gate alone read the body only
//  while a job was held, so with none the load went unnoted and that
//  window stayed open here (issue #71). Reading a JSON body is one
//  small await, and closing the window is worth it.
//
//  On every other path and method, the request streams through
//  untouched and nothing is awaited before it is forwarded. A body
//  that is not JSON, or names no model, is forwarded as it came with
//  no hold: the broker cannot judge a load it cannot name, and the
//  backend will say what is wrong with the request.

import { USER_HEADER_PREFIX } from "@saxby/core";
import { observeResponse } from "../observability/stream.js";
import { startTrace } from "../observability/trace.js";
import {
    admitLoad,
    createLoadHold,
    OUTCOME_ABANDONED,
    OUTCOME_REFUSED,
    STATUS_CLIENT_LEFT,
    STATUS_MEMORY_REFUSED,
} from "../memory/gate.js";

//  The paths whose POST loads the model its body names.
const LOAD_PATHS = new Set([
    "/api/chat",
    "/api/generate",
    "/api/embed",
    "/api/embeddings",
    "/v1/completions",
    "/v1/embeddings",
]);

const LOAD_METHOD = "POST";

//  A request with no body to forward.
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

//  accept-encoding would make the backend gzip a stream that is
//  re-framed on the way back; content-length is wrong once the body
//  is re-sent; host names Saxby, not the backend.
const DROPPED_REQUEST_HEADERS = [
    "accept-encoding",
    "content-length",
    "host",
];

//  fetch() already decompressed the body, so a surviving
//  content-encoding tells the client to gunzip plaintext.
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length"];

/**
 * Removes every header `forward_user_headers` governs. Headers
 * reports names in lowercase, so the prefix matches however the
 * client spelt them. The names are collected first: deleting from a
 * Headers while walking it skips entries.
 */
function dropUserHeaders(headers) {
    const named = [];

    for (const name of headers.keys()) {
        if (name.startsWith(USER_HEADER_PREFIX)) {
            named.push(name);
        }
    }

    for (const name of named) {
        headers.delete(name);
    }
}

/**
 * The client's headers as they arrived, minus what breaks the
 * forwarding. Saxby's own API token stops here (main.js sets the
 * flag); any other Authorization value is the client's business with
 * the backend. Open WebUI's user headers stop here too unless the
 * config says to pass them on; the chat route reads the same switch
 * (routes/v1/chat.js).
 */
function buildUpstreamHeaders(c) {
    const headers = new Headers(c.req.raw.headers);

    for (const name of DROPPED_REQUEST_HEADERS) {
        headers.delete(name);
    }

    if (c.get("sentApiToken")) {
        headers.delete("authorization");
    }

    if (!c.get("config").forward_user_headers) {
        dropUserHeaders(headers);
    }

    return headers;
}

/**
 * Sends the request to the backend at the same path and query.
 * @param {ReadableStream | string | undefined} body - the client's
 *     body as it arrived, or as it was read for the gate
 */
function forward(c, body) {
    const url = new URL(c.req.url);
    const upstreamUrl = c.get("config").upstream_url;
    const bodyless = BODYLESS_METHODS.has(c.req.method);

    const upstreamReq = new Request(
        `${upstreamUrl}${url.pathname}${url.search}`,
        {
            method: c.req.method,
            headers: buildUpstreamHeaders(c),
            body: bodyless ? undefined : body,
            duplex: bodyless ? undefined : "half",
        },
    );

    return fetch(upstreamReq);
}

function buildDownstreamHeaders(upstreamRes) {
    const headers = new Headers(upstreamRes.headers);

    for (const name of DROPPED_RESPONSE_HEADERS) {
        headers.delete(name);
    }

    return headers;
}

function respond(upstreamRes, body) {
    return new Response(body, {
        status: upstreamRes.status,
        headers: buildDownstreamHeaders(upstreamRes),
    });
}

/**
 * The streaming path: the body streams through, nothing is read.
 */
async function forwardAsIs(c) {
    const upstreamRes = await forward(c, c.req.raw.body);

    return respond(upstreamRes, upstreamRes.body);
}

/**
 * Whether the request's path and method load a model. Synchronous
 * and about the request alone, so every other path stays one check
 * with no await; whether a job is held is asked once the body is in
 * hand.
 */
function isModelLoad(c) {
    if (c.req.method !== LOAD_METHOD) {
        return false;
    }

    if (!LOAD_PATHS.has(c.req.path)) {
        return false;
    }

    return true;
}

/**
 * The model a JSON body names, or null when the body is not JSON or
 * names none.
 */
function readModel(text) {
    let body;

    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }

    if (typeof body?.model !== "string") {
        return null;
    }

    if (body.model === "") {
        return null;
    }

    return body.model;
}

/**
 * The load path: reads the body for its model and holds the load
 * until the response's first byte, when the backend lists the model
 * and its size counts as loaded instead. While a job holds memory the
 * broker is asked first, and a refusal never reaches the backend.
 */
async function forwardLoad(c) {
    const broker = c.get("broker");
    const text = await c.req.text();
    const model = readModel(text);

    if (model === null) {
        const upstreamRes = await forward(c, text);

        return respond(upstreamRes, upstreamRes.body);
    }

    const tracer = startTrace("proxy");
    const loadHold = createLoadHold();

    //  While a job holds a reservation, the load must fit first
    //  (docs/memory-broker.md). The same gate as the chat route
    //  (routes/v1/chat.js).
    if (broker.hasJobs()) {
        const gate = await admitLoad(broker, model, {
            requestId: tracer.id,
            signal: c.req.raw.signal,
        });

        if (gate.outcome === OUTCOME_ABANDONED) {
            tracer.aborted();

            return c.body(null, STATUS_CLIENT_LEFT);
        }

        if (gate.outcome === OUTCOME_REFUSED) {
            tracer.warn(gate.reason);

            return c.json(gate.body, STATUS_MEMORY_REFUSED);
        }

        loadHold.take(gate.hold);
    }

    //  Every forwarded load is counted, gate or no gate: until the
    //  backend lists the model, a job that arrives now would read
    //  its space as free. Synchronous, with no call to the backend.
    if (!loadHold.taken()) {
        loadHold.take(broker.trackLoad(model, {
            requestId: tracer.id,
        }));
    }

    tracer.proxy(`${c.req.method} ${c.req.path} model=${model}`);

    let upstreamRes;

    try {
        upstreamRes = await forward(c, text);
    } catch (err) {
        //  The hold would be reaped after its TTL; freeing it now is
        //  the only thing this path does that the streaming one does
        //  not. The error goes on to the same 500 as before.
        loadHold.release();

        throw err;
    }

    const observed = observeResponse(upstreamRes.body, {
        onFirstByte: () => {
            tracer.firstByte();
            loadHold.release();
        },

        onEnd: () => {
            tracer.done(upstreamRes.status);
            loadHold.release();
        },

        onCancel: () => {
            tracer.aborted();
            loadHold.release();
        },
    });

    return respond(upstreamRes, observed);
}

/**
 * Registered after every other route, so it sees only what none of
 * them served.
 * @param {import("@hono/hono").Hono} app
 */
export function registerCatchAll(app) {
    app.all("*", (c) => {
        console.log(`\n➡️ Proxying unhandled endpoint: ${c.req.path}`);

        if (isModelLoad(c)) {
            return forwardLoad(c);
        }

        return forwardAsIs(c);
    });
}
