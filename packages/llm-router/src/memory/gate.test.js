import { assertEquals, assertStringIncludes } from "@std/assert";
import {
    admitLoad,
    createLoadHold,
    OUTCOME_ABANDONED,
    OUTCOME_ADMITTED,
    OUTCOME_REFUSED,
} from "./gate.js";

//  =====================================================================
//  The gate between a route and the broker
//  =====================================================================
//  The broker's decisions are tested in broker.test.js. These pin what
//  the routes share: each answer maps to one outcome, a refusal
//  carries the body every route sends, and a hold releases once.

function fakeBroker(verdict) {
    const calls = [];

    const broker = {
        gateLoad: (model, context) => {
            calls.push({ model, context });

            return Promise.resolve(verdict);
        },
    };

    return { broker, calls };
}

Deno.test("gate — an admitted load carries its hold", async () => {
    const hold = { release: () => {} };
    const { broker, calls } = fakeBroker({ admitted: true, hold });

    const gate = await admitLoad(broker, "voxtral:32k", {
        requestId: "req_1",
    });

    assertEquals(gate.outcome, OUTCOME_ADMITTED);
    assertEquals(gate.hold, hold);
    assertEquals(calls[0].model, "voxtral:32k");
    assertEquals(calls[0].context.requestId, "req_1");
});

Deno.test("gate — a load admitted with no hold says so", async () => {
    const { broker } = fakeBroker({ admitted: true, hold: null });

    const gate = await admitLoad(broker, "voxtral:32k", {
        requestId: "req_1",
    });

    assertEquals(gate.outcome, OUTCOME_ADMITTED);
    assertEquals(gate.hold, null);
});

Deno.test("gate — a refusal carries the reason and the body", async () => {
    const { broker } = fakeBroker({
        admitted: false,
        code: "memory_unavailable",
        reason: "'voxtral:32k' needs 10.0 GiB; 2.0 GiB free",
    });

    const gate = await admitLoad(broker, "voxtral:32k", {
        requestId: "req_1",
    });

    assertEquals(gate.outcome, OUTCOME_REFUSED);
    assertEquals(gate.reason, "'voxtral:32k' needs 10.0 GiB; 2.0 GiB free");
    assertEquals(gate.body.error.code, "memory_unavailable");
    assertEquals(gate.body.error.type, "server_error");
    assertStringIncludes(gate.body.error.message, "running job");
    assertStringIncludes(gate.body.error.message, "needs 10.0 GiB");
});

Deno.test("gate — a client that left is abandoned, not refused", async () => {
    const { broker } = fakeBroker({ admitted: false, code: "abandoned" });

    const gate = await admitLoad(broker, "voxtral:32k", {
        requestId: "req_1",
    });

    assertEquals(gate.outcome, OUTCOME_ABANDONED);
});

Deno.test("hold — releases once, however often it is asked", () => {
    let released = 0;
    const hold = createLoadHold();

    hold.take({ release: () => released++ });

    hold.release();
    hold.release();
    hold.release();

    assertEquals(released, 1);
});

Deno.test("hold — an empty hold releases nothing", () => {
    const hold = createLoadHold();

    hold.release();

    hold.take(null);
    hold.release();
});
