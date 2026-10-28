import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "@hono/hono";
import { gibToBytes } from "@saxby/core";
import { createBroker } from "../../../memory/broker.js";
import { createSizeCache } from "../../../memory/sizes.js";
import { registerReservationRoutes } from "./reservations.js";

//  A real broker over fake surroundings, served by Hono in memory: no
//  port, no backend, no processes. 96 - 8 - 26 pinned = 62 GiB free,
//  with nothing else loaded. Waits are zero so a refusal is instant.

const WRAPPER = 4242;
const CHILD = 4243;
const PATH = "/saxby/v1/reservations";

function app() {
    const broker = createBroker({
        config: {
            catalog: { "gemma4:31b-128k": { pinned: true, size_gib: 26 } },
            memory: {
                margin_gib: 8,
                wait_timeout_s: 0,
                heartbeat_interval_s: 10,
            },
        },
        probe: {
            read: () =>
                Promise.resolve({
                    ceilingBytes: gibToBytes(96),
                    ceilingSource: "fixture",
                    usedBytes: null,
                    usedSource: "fixture",
                }),
        },
        backend: {
            canonicalName: (name) => name,
            fetchResidency: () => Promise.resolve([]),
        },
        upstreamUrl: "http://ollama.test",
        isAlive: (pid) => Promise.resolve(pid === WRAPPER || pid === CHILD),
        sizes: createSizeCache(),
    });

    const server = new Hono();

    server.use("*", async (c, next) => {
        c.set("broker", broker);
        await next();
    });

    registerReservationRoutes(server);

    return server;
}

function post(server, path, body) {
    return server.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function reserve(server, gib = 1) {
    const res = await post(server, PATH, {
        gib,
        pid: WRAPPER,
        label: "sleep",
    });

    return { status: res.status, body: await res.json() };
}

Deno.test("reservations — an admitted job gets what it needs", async () => {
    const got = await reserve(app());

    assertEquals(got.status, 201);
    assertEquals(got.body.reservation.bytes, gibToBytes(1));
    assertEquals(got.body.reservation.label, "sleep");
    assertEquals(got.body.heartbeat_interval_s, 10);
    assertEquals(got.body.ceiling_bytes, gibToBytes(96));
    assertEquals(got.body.waited_ms, 0);
});

Deno.test("reservations — a refusal is a 503 with its budget", async () => {
    const got = await reserve(app(), 63);

    assertEquals(got.status, 503);
    assertEquals(got.body.error.code, "memory_unavailable");
    assertEquals(got.body.error.type, "server_error");
    assertEquals(got.body.budget.free_bytes, gibToBytes(62));
});

Deno.test("reservations — a dead pid is a 400", async () => {
    const res = await post(app(), PATH, { gib: 1, pid: 99 });
    const body = await res.json();

    assertEquals(res.status, 400);
    assertEquals(body.error.code, "pid_not_alive");
});

Deno.test("reservations — a bad body names the field", async () => {
    const res = await post(app(), PATH, { gib: 0, pid: WRAPPER });
    const body = await res.json();

    assertEquals(res.status, 400);
    assertStringIncludes(body.error.message, "'gib'");
});

Deno.test("reservations — re-registering needs a real id", async () => {
    const res = await post(app(), PATH, {
        gib: 1,
        pid: WRAPPER,
        reregister: true,
        id: "../../etc",
    });

    assertEquals(res.status, 400);
});

Deno.test("reservations — a heartbeat records the child", async () => {
    const server = app();
    const { body } = await reserve(server);
    const id = body.reservation.id;

    const res = await post(server, `${PATH}/${id}/heartbeat`, {
        child_pid: CHILD,
    });

    assertEquals(res.status, 200);
    assertEquals((await res.json()).reservation.child_pid, CHILD);
});

Deno.test("reservations — an unknown heartbeat asks for more", async () => {
    const res = await post(app(), `${PATH}/ghost/heartbeat`, {});
    const body = await res.json();

    assertEquals(res.status, 404);
    assertEquals(body.error.code, "reservation_unknown");
    assertStringIncludes(body.error.message, "reregister");
});

Deno.test("reservations — a re-registered job keeps its id", async () => {
    const id = crypto.randomUUID();

    const res = await post(app(), PATH, {
        gib: 1,
        pid: WRAPPER,
        child_pid: CHILD,
        reregister: true,
        id,
    });

    assertEquals(res.status, 201);
    assertEquals((await res.json()).reservation.id, id);
});

Deno.test("reservations — a second release is a 404", async () => {
    const server = app();
    const { body } = await reserve(server);
    const path = `${PATH}/${body.reservation.id}`;

    const first = await server.request(path, { method: "DELETE" });
    const second = await server.request(path, { method: "DELETE" });

    assertEquals(first.status, 200);
    assertEquals(second.status, 404);
});

Deno.test("reservations — the list shows budget and ledger", async () => {
    const server = app();

    await reserve(server, 2);

    const res = await server.request(PATH);
    const body = await res.json();

    assertEquals(body.reservations.length, 1);
    assertEquals(body.budget.reserved_bytes, gibToBytes(2));
    assertEquals(body.budget.free_bytes, gibToBytes(60));
    assertEquals(body.holds, []);
});
