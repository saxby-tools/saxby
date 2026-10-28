import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BrokerUnreachable } from "./client.js";
import {
    EXIT_INTERRUPTED,
    EXIT_NOT_FOUND,
    EXIT_TEMPFAIL,
    EXIT_UNAVAILABLE,
    runReserved,
} from "./run.js";

//  =====================================================================
//  Harness
//  =====================================================================
//  A fake client, spawner, signal table and timer. Nothing here makes
//  a request or starts a process.

const GIB = 2 ** 30;
const WRAPPER = 4242;
const CHILD = 4243;

const RESERVATION = {
    id: "0b6c1a6e-8f8e-4c55-9d1a-2f4f6f0e9a11",
    bytes: GIB,
};

const ADMITTED = {
    status: 201,
    body: {
        reservation: RESERVATION,
        heartbeat_interval_s: 10,
        ceiling_bytes: 96 * GIB,
        ceiling_source: "iogpu.wired_limit_mb",
        waited_ms: 0,
    },
};

function plan(overrides = {}) {
    return {
        gib: 1,
        timeoutS: 120,
        label: "sleep",
        command: "sleep",
        args: ["5"],
        useBroker: true,
        ...overrides,
    };
}

const FAKE_LIMITER = {
    displayName: "Fake cap",
    environment: ({ reservedBytes, ceilingBytes, ceilingSource }) => ({
        env: {
            FAKE_RATIO: String(reservedBytes / ceilingBytes),
            FAKE_SOURCE: ceilingSource,
        },
    }),
};

function harness(options = {}) {
    const calls = { create: [], heartbeat: [], release: [], spawn: [] };
    const lines = [];
    const handlers = new Map();
    const timers = [];

    let finishChild;

    const client = {
        create: (request, signal) => {
            calls.create.push(request);

            if (options.onCreate) {
                return options.onCreate(request, signal, control);
            }

            return Promise.resolve(ADMITTED);
        },
        heartbeat: (id, childPid) => {
            calls.heartbeat.push({ id, childPid });

            return Promise.resolve(options.heartbeatReply ?? { status: 200 });
        },
        release: (id) => {
            calls.release.push(id);

            return Promise.resolve({ status: 200 });
        },
    };

    const deps = {
        client,
        probe: {
            read: () =>
                Promise.resolve({
                    ceilingBytes: 96 * GIB,
                    ceilingSource: "probe fixture",
                }),
        },
        limiters: [FAKE_LIMITER],
        pid: WRAPPER,
        port: 11436,
        say: (line) => lines.push(line),
        onSignal: (name, handler) => {
            handlers.set(name, handler);

            return () => handlers.delete(name);
        },
        every: (_ms, fn) => {
            timers.push(fn);

            return () => {
                timers.splice(timers.indexOf(fn), 1);
            };
        },
        spawn: (command, args, env) => {
            calls.spawn.push({ command, args, env });

            if (options.spawnError) {
                throw options.spawnError;
            }

            return {
                pid: CHILD,
                status: new Promise((resolve) => {
                    finishChild = resolve;
                }),
                kill: (signal) => calls.spawn.push({ killed: signal }),
            };
        },
    };

    const control = {
        deps,
        calls,
        lines,
        handlers,
        timers,
        exit: (code) => finishChild({ code }),
        output: () => lines.join("\n"),
    };

    return control;
}

//  Lets the run reach its await on the child before the test ends it.
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

//  =====================================================================
//  Failing closed
//  =====================================================================

Deno.test("reserve — no answer from saxbyd means no job", async () => {
    const control = harness({
        onCreate: () =>
            Promise.reject(
                new BrokerUnreachable(11436, new Error("Connection refused")),
            ),
    });

    const code = await runReserved(plan(), control.deps);

    assertEquals(code, EXIT_UNAVAILABLE);
    assertEquals(control.calls.spawn, []);
    assertStringIncludes(control.output(), "refusing to run");
    assertStringIncludes(control.output(), "--no-broker");
});

Deno.test("reserve — a refusal exits 75 and runs nothing", async () => {
    const control = harness({
        onCreate: () =>
            Promise.resolve({
                status: 503,
                body: {
                    error: {
                        code: "memory_unavailable",
                        message: "waited 120 s; 40.0 GiB wanted",
                    },
                },
            }),
    });

    const code = await runReserved(plan({ gib: 40 }), control.deps);

    assertEquals(code, EXIT_TEMPFAIL);
    assertEquals(control.calls.spawn, []);
    assertStringIncludes(control.output(), "40.0 GiB wanted");
});

Deno.test("reserve — a saxbyd with no broker is refused too", async () => {
    const control = harness({
        onCreate: () => Promise.resolve({ status: 404, body: null }),
    });

    const code = await runReserved(plan(), control.deps);

    assertEquals(code, EXIT_UNAVAILABLE);
    assertStringIncludes(control.output(), "no memory broker");
});

Deno.test("reserve — Ctrl-C while waiting runs nothing", async () => {
    const control = harness({
        onCreate: (_request, signal, harnessControl) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                    reject(new DOMException("stopped", "AbortError"));
                });

                harnessControl.handlers.get("SIGINT")();
            }),
    });

    const code = await runReserved(plan(), control.deps);

    assertEquals(code, EXIT_INTERRUPTED);
    assertEquals(control.calls.spawn, []);
});

//  =====================================================================
//  Running
//  =====================================================================

Deno.test("reserve — an admitted job runs capped, then frees", async () => {
    const control = harness();
    const running = runReserved(plan(), control.deps);

    await settle();

    assertEquals(control.calls.create[0], {
        gib: 1,
        pid: WRAPPER,
        label: "sleep",
        timeout_s: 120,
    });
    assertEquals(control.calls.spawn[0].env, {
        FAKE_RATIO: String(1 / 96),
        FAKE_SOURCE: "iogpu.wired_limit_mb",
    });
    assertEquals(control.calls.heartbeat[0].childPid, CHILD);

    control.exit(3);

    assertEquals(await running, 3);
    assertEquals(control.calls.release, [RESERVATION.id]);
    assertEquals(control.handlers.size, 0);
});

Deno.test("reserve — SIGTERM is passed on to the job", async () => {
    const control = harness();
    const running = runReserved(plan(), control.deps);

    await settle();
    control.handlers.get("SIGTERM")();
    control.exit(143);

    assertEquals(await running, 143);
    assert(control.calls.spawn.some((call) => call.killed === "SIGTERM"));
});

Deno.test("reserve — Ctrl-C while running is left to the job", async () => {
    const control = harness();
    const running = runReserved(plan(), control.deps);

    await settle();
    control.handlers.get("SIGINT")();
    control.exit(130);

    assertEquals(await running, 130);
    assert(!control.calls.spawn.some((call) => call.killed));
});

Deno.test("reserve — a heartbeat 404 registers the job again", async () => {
    const control = harness({ heartbeatReply: { status: 404 } });
    const running = runReserved(plan(), control.deps);

    await settle();

    const again = control.calls.create[1];

    assertEquals(again.reregister, true);
    assertEquals(again.id, RESERVATION.id);
    assertEquals(again.child_pid, CHILD);

    control.exit(0);
    await running;
});

Deno.test("reserve — a refused re-registration is said once", async () => {
    const control = harness({
        heartbeatReply: { status: 404 },
        onCreate: (request) => {
            if (!request.reregister) {
                return Promise.resolve(ADMITTED);
            }

            return Promise.resolve({
                status: 400,
                body: { error: { message: "pid 4242 is not running" } },
            });
        },
    });

    const running = runReserved(plan(), control.deps);

    await settle();

    //  The interval is gone, so later ticks ask nothing more.
    assertEquals(control.timers, []);

    const refusals = control.lines.filter((line) =>
        line.includes("would not take the job back")
    );

    assertEquals(refusals.length, 1);
    assertStringIncludes(refusals[0], "will not be asked again");
    assertEquals(control.calls.create.length, 2);

    control.exit(0);

    assertEquals(await running, 0);
    assertEquals(control.calls.release, [RESERVATION.id]);
});

Deno.test("reserve — a command that can't start is released", async () => {
    const control = harness({
        spawnError: new Deno.errors.NotFound("No such file"),
    });

    const code = await runReserved(plan(), control.deps);

    assertEquals(code, EXIT_NOT_FOUND);
    assertEquals(control.calls.release, [RESERVATION.id]);
});

Deno.test("reserve — --no-broker runs loudly and still caps", async () => {
    const control = harness();
    const running = runReserved(plan({ useBroker: false }), control.deps);

    await settle();
    control.exit(0);

    assertEquals(await running, 0);
    assertEquals(control.calls.create, []);
    assertEquals(control.calls.spawn[0].env, {
        FAKE_RATIO: String(1 / 96),
        FAKE_SOURCE: "probe fixture",
    });
    assertStringIncludes(control.output(), "NOT told about this job");
});
