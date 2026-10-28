import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { BrokerUnreachable, createReservationClient } from "./client.js";

//  A fake fetch: no port is opened.

function client(respond) {
    const seen = [];

    const fetchImpl = (url, init) => {
        seen.push({ url, method: init.method, body: init.body });

        return respond();
    };

    return { api: createReservationClient(11436, fetchImpl), seen };
}

const REQUEST = { gib: 1, pid: 4242, label: "sleep", timeout_s: 120 };

Deno.test("client — a refused connection is BrokerUnreachable", async () => {
    const { api } = client(() =>
        Promise.reject(new TypeError("Connection refused"))
    );

    await assertRejects(() => api.create(REQUEST), BrokerUnreachable);
});

Deno.test("client — Ctrl-C is not mistaken for no answer", async () => {
    const { api } = client(() =>
        Promise.reject(new DOMException("stopped", "AbortError"))
    );

    await assertRejects(() => api.create(REQUEST), DOMException);
});

Deno.test("client — a create must name its wait", () => {
    const { api } = client(() => Promise.resolve(Response.json({})));

    assertThrows(() => api.create({ gib: 1, pid: 4242 }), TypeError);
});

Deno.test("client — an answer comes back with its status", async () => {
    const { api, seen } = client(() =>
        Promise.resolve(Response.json({ error: { code: "x" } }, {
            status: 503,
        }))
    );

    const reply = await api.create(REQUEST);

    assertEquals(reply.status, 503);
    assertEquals(reply.body.error.code, "x");
    assertEquals(seen[0].url, "http://127.0.0.1:11436/saxby/v1/reservations");
});

Deno.test("client — a heartbeat carries the child's pid", async () => {
    const { api, seen } = client(() => Promise.resolve(Response.json({})));

    await api.heartbeat("abc", 4243);

    assertEquals(seen[0].url.endsWith("/abc/heartbeat"), true);
    assertEquals(JSON.parse(seen[0].body), { child_pid: 4243 });
});

Deno.test("client — an answer with no body reads as null", async () => {
    const { api } = client(() =>
        Promise.resolve(new Response(null, { status: 499 }))
    );

    const reply = await api.release("abc");

    assertEquals(reply, { status: 499, body: null });
});
