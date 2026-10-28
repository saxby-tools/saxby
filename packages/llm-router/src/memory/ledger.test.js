import { assertEquals } from "@std/assert";
import { createLedger } from "./ledger.js";

const GIB = 2 ** 30;

function clock(startMs = 0) {
    let ms = startMs;

    return {
        now: () => ms,
        advance: (by) => {
            ms += by;
        },
    };
}

function job(overrides = {}) {
    return { bytes: GIB, label: "sleep", pid: 4242, ...overrides };
}

Deno.test("ledger — jobs and holds both count as reserved", () => {
    const ledger = createLedger();

    ledger.addJob(job({ bytes: 2 * GIB }));
    ledger.addHold({ bytes: GIB, model: "voxtral:32k", requestId: "r1" });

    assertEquals(ledger.reservedBytes(), 3 * GIB);
    assertEquals(ledger.jobs().length, 1);
    assertEquals(ledger.holds().length, 1);
});

Deno.test("ledger — a hold alone is not a job", () => {
    const ledger = createLedger();

    ledger.addHold({ bytes: GIB, model: "voxtral:32k", requestId: "r1" });

    assertEquals(ledger.hasJobs(), false);
});

Deno.test("ledger — removing an entry frees its bytes", () => {
    const ledger = createLedger();
    const entry = ledger.addJob(job());

    assertEquals(ledger.remove(entry.id)?.id, entry.id);
    assertEquals(ledger.reservedBytes(), 0);
    assertEquals(ledger.hasJobs(), false);
});

Deno.test("ledger — removing an unknown id returns null", () => {
    assertEquals(createLedger().remove("ghost"), null);
});

Deno.test("ledger — a heartbeat stamps the time and the child", () => {
    const time = clock(1000);
    const ledger = createLedger(time.now);
    const entry = ledger.addJob(job());

    time.advance(10_000);

    const beat = ledger.heartbeat(entry.id, 4243);

    assertEquals(beat?.childPid, 4243);
    assertEquals(beat?.lastHeartbeatAt, new Date(11_000).toISOString());
});

Deno.test("ledger — a heartbeat without a child keeps the known one", () => {
    const ledger = createLedger();
    const entry = ledger.addJob(job({ childPid: 4243 }));

    assertEquals(ledger.heartbeat(entry.id)?.childPid, 4243);
});

Deno.test("ledger — an unknown heartbeat returns null", () => {
    assertEquals(createLedger().heartbeat("ghost"), null);
});

Deno.test("ledger — a hold cannot be heartbeated", () => {
    const ledger = createLedger();
    const hold = ledger.addHold({ bytes: GIB, model: "m", requestId: "r1" });

    assertEquals(ledger.heartbeat(hold.id), null);
});

Deno.test("ledger — a shared hold counts once, outlives one release", () => {
    const ledger = createLedger();
    const hold = ledger.addHold({ bytes: GIB, model: "m", requestId: "r1" });

    assertEquals(ledger.findHold("m")?.id, hold.id);
    assertEquals(ledger.retainHold(hold.id)?.holders, 2);
    assertEquals(ledger.reservedBytes(), GIB);

    assertEquals(ledger.releaseHold(hold.id), null);
    assertEquals(ledger.reservedBytes(), GIB);

    assertEquals(ledger.releaseHold(hold.id)?.id, hold.id);
    assertEquals(ledger.reservedBytes(), 0);
    assertEquals(ledger.findHold("m"), null);
});

Deno.test("ledger — only holds can be shared", () => {
    const ledger = createLedger();
    const entry = ledger.addJob(job());

    assertEquals(ledger.retainHold(entry.id), null);
    assertEquals(ledger.releaseHold(entry.id), null);
    assertEquals(ledger.findHold("sleep"), null);
});

Deno.test("ledger — a re-registered job keeps its id", () => {
    const ledger = createLedger();
    const entry = ledger.addJob(job({ id: "kept-id" }));

    assertEquals(entry.id, "kept-id");
    assertEquals(ledger.get("kept-id")?.pid, 4242);
});

Deno.test("ledger — entries list oldest first", () => {
    const time = clock();
    const ledger = createLedger(time.now);

    const second = ledger.addJob(job({ id: "b" }));

    time.advance(-500);

    const first = ledger.addJob(job({ id: "a" }));

    assertEquals(ledger.list().map((entry) => entry.id), [
        first.id,
        second.id,
    ]);
});
