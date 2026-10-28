import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { gibToBytes } from "@saxby/core";
import { createBroker } from "./broker.js";
import { createSizeCache } from "./sizes.js";

//  =====================================================================
//  Harness
//  =====================================================================
//  Everything the broker touches is faked: the probe, the backend, the
//  pids, the clock and sleep. A wait of ten seconds runs instantly.
//
//  The budget, shaped like the M5 Max with round sizes:
//
//    ceiling 96 - margin 8 - pinned 31 - loaded 25 = 32 GiB free
//
//    pinned  gemma4:31b-128k 26, granite4:micro-h 4, bge-m3 1 (the
//            active embedder, pinned without asking)
//    loaded  qwen3.8:27b 25, not pinned

const WRAPPER = 4242;
const CHILD = 4243;

const QWEN = { name: "qwen3.8:27b", bytes: gibToBytes(25) };
const GEMMA = { name: "gemma4:31b-128k", bytes: gibToBytes(26) };

function testConfig(overrides = {}) {
    return {
        catalog: {
            "gemma4:31b-128k": { pinned: true, size_gib: 26 },
            "granite4:micro-h": { pinned: true, size_gib: 4 },
            "qwen3.8:27b": { pinned: false },
            "voxtral:32k": { pinned: false, size_gib: 10 },
            "other:7b": { pinned: false, size_gib: 5 },
        },
        semantic: {
            active: "bge-m3",
            profiles: {
                "bge-m3": { model: "bge-m3", size_gib: 1 },
            },
        },
        memory: {
            margin_gib: 8,
            wait_timeout_s: 10,
            heartbeat_interval_s: 10,
        },
        ...overrides,
    };
}

function canonicalName(name) {
    return name.includes(":") ? name : `${name}:latest`;
}

function harness(options = {}) {
    let ms = 0;
    let residency = options.loaded ?? [QWEN];

    const alive = options.alive ?? new Map([[WRAPPER, true]]);
    const events = [];
    const warnings = [];
    const sleeps = [];

    const backend = {
        canonicalName,
        fetchResidency: () => {
            if (residency instanceof Error) {
                return Promise.reject(residency);
            }

            return Promise.resolve(residency);
        },
    };

    let probeReads = 0;

    const probe = {
        read: () =>
            Promise.resolve({
                ceilingBytes: options.ceilingBytes === undefined
                    ? gibToBytes(96)
                    : options.ceilingBytes,
                ceilingSource: "fixture",
                usedBytes: gibToBytes(24),
                usedSource: "fixture wired",
            }).finally(() => {
                probeReads += 1;
            }),
    };

    const broker = createBroker({
        config: testConfig(options.config),
        probe,
        backend,
        upstreamUrl: "http://ollama.test",
        //  A pid not in the map is dead; null means "can't check".
        isAlive: (pid) =>
            Promise.resolve(alive.has(pid) ? alive.get(pid) : false),
        sizes: createSizeCache({ now: () => ms }),
        record: (event) => events.push(event),
        now: () => ms,
        sleep: (wait) => {
            ms += wait;
            sleeps.push(wait);
            options.onSleep?.(sleeps.length, control);

            return Promise.resolve();
        },
        warn: (message) => warnings.push(message),
    });

    const control = {
        broker,
        events,
        warnings,
        sleeps,
        alive,
        setLoaded: (models) => {
            residency = models;
        },
        advance: (by) => {
            ms += by;
        },
        probeReads: () => probeReads,
    };

    return control;
}

function kinds(events) {
    return events.map((event) => `${event.subject}:${event.event}`);
}

function reserve(broker, gib, extra = {}) {
    return broker.reserve({
        bytes: gibToBytes(gib),
        pid: WRAPPER,
        label: "sleep",
        ...extra,
    });
}

//  =====================================================================
//  Jobs
//  =====================================================================

Deno.test("broker — a job that fits is admitted at once", async () => {
    const { broker, events } = harness();
    const got = await reserve(broker, 30);

    assert(got.admitted);
    assertEquals(got.waitedMs, 0);
    assertEquals(kinds(events), ["job:admit"]);
    assertEquals(events[0].reservationId, got.reservation.id);
    assertEquals(broker.hasJobs(), true);
});

Deno.test("broker — the log row carries its budget", async () => {
    const { broker, events } = harness();

    await reserve(broker, 1);

    assertEquals(events[0].budget.freeBytes, gibToBytes(32));
    assertEquals(events[0].budget.usedBytes, gibToBytes(24));
});

Deno.test("broker — a job waits until a model unloads", async () => {
    const { broker, events } = harness({
        onSleep: (count, control) => {
            if (count === 2) {
                control.setLoaded([]);
            }
        },
    });

    const got = await reserve(broker, 40);

    assert(got.admitted);
    assertEquals(got.waitedMs, 2000);
    assertEquals(kinds(events), ["job:wait", "job:admit"]);
});

Deno.test("broker — a job with no room is refused in time", async () => {
    const { broker, events } = harness();
    const got = await reserve(broker, 40);

    assertEquals(got.admitted, false);
    assertEquals(got.code, "memory_unavailable");
    assertEquals(got.waitedMs, 10_000);
    assertStringIncludes(got.reason, "waited 10 s");
    assertEquals(kinds(events), ["job:wait", "job:refuse"]);
});

Deno.test("broker — a job's own timeout overrides the config's", async () => {
    const { broker } = harness();
    const got = await reserve(broker, 40, { timeoutMs: 3000 });

    assertEquals(got.waitedMs, 3000);
});

Deno.test("broker — a job that can never fit doesn't wait", async () => {
    const { broker, events, sleeps } = harness();

    //  96 - 8 - 31 pinned leaves 57, even with nothing else loaded.
    const got = await reserve(broker, 58);

    assertEquals(got.admitted, false);
    assertStringIncludes(got.reason, "can never fit");
    assertEquals(sleeps, []);
    assertEquals(kinds(events), ["job:refuse"]);
});

Deno.test("broker — the auto-pinned embedder takes its space", async () => {
    const { broker } = harness();
    const snapshot = await broker.snapshot();
    const models = snapshot.budget.pinned.map((term) => term.model);

    assert(models.includes("bge-m3:latest"));

    //  Free is 32 only because bge-m3's 1 GiB is counted.
    const got = await reserve(broker, 32.5, { timeoutMs: 0 });

    assertEquals(got.admitted, false);
});

Deno.test("broker — one probe reading serves a second of polls", async () => {
    const control = harness();

    await control.broker.snapshot();
    await control.broker.snapshot();

    assertEquals(control.probeReads(), 1);

    control.advance(1000);
    await control.broker.snapshot();

    assertEquals(control.probeReads(), 2);
});

Deno.test("broker — a dead pid is refused before anything else", async () => {
    const { broker, events } = harness({ alive: new Map() });
    const got = await reserve(broker, 1);

    assertEquals(got.code, "pid_not_alive");
    assertEquals(events, []);
});

Deno.test("broker — a pid that can't be checked is refused", async () => {
    const { broker } = harness({ alive: new Map([[WRAPPER, null]]) });
    const got = await reserve(broker, 1);

    assertEquals(got.code, "liveness_unknown");
});

Deno.test("broker — a client that leaves stops its wait", async () => {
    const controller = new AbortController();
    const { broker, events } = harness({
        onSleep: () => controller.abort(),
    });

    const got = await reserve(broker, 40, { signal: controller.signal });

    assertEquals(got.code, "abandoned");
    assertEquals(kinds(events), ["job:wait", "job:abandon"]);
});

Deno.test("broker — an unknown ceiling refuses at once", async () => {
    const { broker, sleeps } = harness({ ceilingBytes: null });
    const got = await reserve(broker, 1);

    assertEquals(got.admitted, false);
    assertStringIncludes(got.reason, "ceiling is unknown");
    assertEquals(sleeps, []);
});

Deno.test("broker — ceiling_gib fills an unknown ceiling", async () => {
    const { broker } = harness({
        ceilingBytes: null,
        config: {
            memory: {
                margin_gib: 8,
                wait_timeout_s: 10,
                heartbeat_interval_s: 10,
                ceiling_gib: 96,
            },
        },
    });

    const got = await reserve(broker, 1);

    assert(got.admitted);
    assertStringIncludes(got.budget.ceilingSource, "memory.ceiling_gib");
});

Deno.test("broker — a backend that cannot answer refuses jobs", async () => {
    const { broker, setLoaded, sleeps } = harness();

    setLoaded(new Error("Could not reach Ollama"));

    const got = await reserve(broker, 1);

    assertEquals(got.admitted, false);
    assertStringIncludes(got.reason, "Could not reach Ollama");

    //  It may answer on the next poll, so the job waits for it.
    assert(sleeps.length > 0);
});

Deno.test("broker — a job is admitted once the backend answers", async () => {
    const control = harness({
        onSleep: (count) => {
            if (count === 2) {
                control.setLoaded([QWEN]);
            }
        },
    });

    control.setLoaded(new Error("Could not reach Ollama"));

    const got = await reserve(control.broker, 1);

    assert(got.admitted);
    assertEquals(control.sleeps.length, 2);
});

Deno.test("broker — a pinned model with no size blocks jobs", async () => {
    const { broker } = harness({
        config: {
            catalog: { "gemma4:31b-128k": { pinned: true } },
            semantic: undefined,
        },
        loaded: [],
    });

    const got = await reserve(broker, 1);

    assertEquals(got.admitted, false);
    assertStringIncludes(got.reason, "'gemma4:31b-128k' has no known size");
});

Deno.test("broker — a measured size outlives the unload", async () => {
    const control = harness({
        config: {
            catalog: { "gemma4:31b-128k": { pinned: true } },
            semantic: undefined,
        },
        loaded: [GEMMA],
    });

    //  Seen loaded once...
    await control.broker.snapshot();

    //  ...then unloaded. Its measured 26 GiB still counts.
    control.setLoaded([]);

    const snapshot = await control.broker.snapshot();

    assertEquals(snapshot.budget.pinned[0].source, "measured");
    assertEquals(snapshot.budget.freeBytes, gibToBytes(96 - 8 - 26));
});

//  =====================================================================
//  Re-registering, releasing, reaping
//  =====================================================================

function job(id = "kept-id") {
    return {
        id,
        bytes: gibToBytes(60),
        pid: WRAPPER,
        childPid: CHILD,
        label: "sleep",
    };
}

Deno.test("broker — a running job re-registers over budget", async () => {
    const { broker, events } = harness();
    const got = await broker.reregister(job());

    assert(got.admitted);
    assertEquals(got.reservation.id, "kept-id");
    assertEquals(kinds(events), ["job:reregister"]);
    assertStringIncludes(events[0].reason, "over budget");
});

Deno.test("broker — re-registering a known id is a heartbeat", async () => {
    const { broker, events } = harness();

    await broker.reregister(job());
    await broker.reregister(job());

    assertEquals(kinds(events), ["job:reregister"]);
});

Deno.test("broker — re-registering with no live pid is refused", async () => {
    const { broker } = harness({ alive: new Map() });
    const got = await broker.reregister(job());

    assertEquals(got.code, "pid_not_alive");
});

Deno.test("broker — releasing frees the memory and logs it", async () => {
    const { broker, events } = harness();
    const got = await reserve(broker, 1);

    assertEquals(broker.release(got.reservation.id)?.id, got.reservation.id);
    assertEquals(broker.hasJobs(), false);
    assertEquals(kinds(events), ["job:admit", "job:release"]);
});

Deno.test("broker — releasing an unknown id returns null", () => {
    assertEquals(harness().broker.release("ghost"), null);
});

Deno.test("broker — a job is kept while its child lives", async () => {
    const control = harness({
        alive: new Map([[WRAPPER, true], [CHILD, true]]),
    });

    const got = await reserve(control.broker, 1);

    control.broker.heartbeat(got.reservation.id, CHILD);

    //  The wrapper was killed with SIGKILL; its child runs on.
    control.alive.set(WRAPPER, false);
    await control.broker.sweep();

    assertEquals(control.broker.hasJobs(), true);
});

Deno.test("broker — a job is reaped once every pid has exited", async () => {
    const control = harness({
        alive: new Map([[WRAPPER, true], [CHILD, true]]),
    });

    const got = await reserve(control.broker, 1);

    control.broker.heartbeat(got.reservation.id, CHILD);
    control.alive.set(WRAPPER, false);
    control.alive.set(CHILD, false);
    await control.broker.sweep();

    assertEquals(control.broker.hasJobs(), false);
    assertEquals(kinds(control.events), ["job:admit", "job:reap"]);
    assertStringIncludes(control.events[1].reason, "4242 and 4243");
});

Deno.test("broker — a job that can't be checked is kept", async () => {
    const control = harness();

    await reserve(control.broker, 1);
    control.alive.set(WRAPPER, null);
    await control.broker.sweep();

    assertEquals(control.broker.hasJobs(), true);
    assertEquals(control.warnings.length, 1);
});

//  =====================================================================
//  Model loads
//  =====================================================================

function gate(broker, model) {
    return broker.gateLoad(model, { requestId: "req_test" });
}

Deno.test("load — a loaded model passes with no hold or row", async () => {
    const { broker, events } = harness();

    await reserve(broker, 1);

    const got = await gate(broker, "qwen3.8:27b");

    assert(got.admitted);
    assertEquals(got.hold, null);
    assertEquals(kinds(events), ["job:admit"]);
});

Deno.test("load — with no job held, nothing is checked", async () => {
    const { broker, events } = harness();
    const got = await gate(broker, "voxtral:32k");

    assert(got.admitted);
    assertEquals(events, []);
});

Deno.test("load — a model that fits is held until released", async () => {
    const { broker, events } = harness();

    await reserve(broker, 1);

    const got = await gate(broker, "voxtral:32k");

    assert(got.admitted);
    assertEquals(kinds(events), ["job:admit", "load:admit"]);

    const held = await broker.snapshot();

    assertEquals(held.budget.reservedBytes, gibToBytes(11));

    got.hold.release();

    const freed = await broker.snapshot();

    assertEquals(freed.budget.reservedBytes, gibToBytes(1));
});

Deno.test("load — two requests for one model share its hold", async () => {
    const { broker, events, sleeps } = harness();

    //  32 free - 20 reserved = 12; voxtral takes 10 of it, once.
    await reserve(broker, 20);

    const first = await gate(broker, "voxtral:32k");
    const second = await gate(broker, "voxtral:32k");

    async function reserved() {
        return (await broker.snapshot()).budget.reservedBytes;
    }

    assert(second.admitted);
    assertEquals(sleeps, []);
    assertStringIncludes(events[2].reason, "sharing its hold");
    assertEquals(await reserved(), gibToBytes(30));

    first.hold.release();

    assertEquals(await reserved(), gibToBytes(30));

    second.hold.release();

    assertEquals(await reserved(), gibToBytes(20));
});

Deno.test("load — a hold keeps a second model off its space", async () => {
    const { broker } = harness();

    //  32 free - 20 reserved = 12; voxtral takes 10 of it.
    await reserve(broker, 20);
    await gate(broker, "voxtral:32k");

    const got = await gate(broker, "other:7b");

    assertEquals(got.admitted, false);
});

Deno.test("load — a model that won't fit waits, then fails", async () => {
    const { broker, events } = harness();

    await reserve(broker, 30);

    const got = await gate(broker, "voxtral:32k");

    assertEquals(got.admitted, false);
    assertEquals(got.code, "memory_unavailable");
    assertStringIncludes(got.reason, "'voxtral:32k' needs 10.0 GiB");
    assertEquals(kinds(events), ["job:admit", "load:wait", "load:refuse"]);
    assertEquals(events[2].requestId, "req_test");
});

Deno.test("load — a pinned model passes even while unloaded", async () => {
    const { broker } = harness();

    await reserve(broker, 30);

    const got = await gate(broker, "gemma4:31b-128k");

    assert(got.admitted);
    assertEquals(got.hold, null);
});

Deno.test("load — an unknown model passes once the job ends", async () => {
    let reservationId = null;

    const { broker, events } = harness({
        onSleep: (count, control) => {
            if (count === 1) {
                control.broker.release(reservationId);
            }
        },
    });

    reservationId = (await reserve(broker, 1)).reservation.id;

    const got = await gate(broker, "never-seen:1b");

    assert(got.admitted);
    assertEquals(kinds(events), [
        "job:admit",
        "load:wait",
        "job:release",
        "load:admit",
    ]);
    assertStringIncludes(events[3].reason, "no reservation is held");
});

Deno.test("load — an untagged name matches its loaded model", async () => {
    const { broker } = harness({
        loaded: [{ name: "bge-m3:latest", bytes: gibToBytes(1) }],
    });

    await reserve(broker, 1);

    const got = await gate(broker, "bge-m3");

    assert(got.admitted);
    assertEquals(got.hold, null);
});
