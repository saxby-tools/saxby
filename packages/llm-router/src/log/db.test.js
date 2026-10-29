import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openDecisionLog } from "./db.js";

//  An in-memory database needs no file permission and leaves nothing
//  behind. The writer adds signal listeners for a clean shutdown, so
//  the resource sanitizer is off for these cases. The file-mode cases
//  use a temp folder, which is why `deno task test` may read and write.

const GIB = 2 ** 30;

function openLog() {
    return openDecisionLog(":memory:", { log_prompts: false });
}

function modeOf(path) {
    return Deno.statSync(path).mode & 0o777;
}

const BUDGET = {
    ceilingBytes: 96 * GIB,
    ceilingSource: "iogpu.wired_limit_mb",
    marginBytes: 8 * GIB,
    pinnedBytes: 31 * GIB,
    loadedBytes: 25 * GIB,
    reservedBytes: 0,
    freeBytes: 32 * GIB,
    usedBytes: 24 * GIB,
    usedSource: "vm_stat wired",
    pinned: [{ model: "gemma4:31b-128k", bytes: 26 * GIB, source: "loaded" }],
    loaded: [{ model: "qwen3.8:27b", bytes: 25 * GIB }],
    unknowns: [],
};

Deno.test({
    name: "log — a memory event lands with its budget",
    sanitizeResources: false,
    fn: () => {
        const log = openLog();

        log.memory({
            at: "2026-10-27T23:00:00.000Z",
            subject: "job",
            event: "admit",
            reason: "1.0 GiB fits",
            reservationId: "res-1",
            label: "sleep",
            pid: 4242,
            bytes: GIB,
            waitMs: 0,
            budget: BUDGET,
        });

        log.flush();

        const row = log.db.prepare("SELECT * FROM memory_events").get();

        assertEquals(row.event, "admit");
        assertEquals(row.free_bytes, 32 * GIB);
        assertEquals(row.used_bytes, 24 * GIB);
        assertEquals(row.child_pid, null);
        assertEquals(JSON.parse(row.budget).pinned[0].source, "loaded");

        log.close();
    },
});

Deno.test({
    name: "log — an event with no budget leaves its terms empty",
    sanitizeResources: false,
    fn: () => {
        const log = openLog();

        log.memory({
            at: "2026-10-27T23:00:00.000Z",
            subject: "job",
            event: "reap",
            reason: "no process left",
            reservationId: "res-1",
            pid: 4242,
            bytes: GIB,
        });

        log.flush();

        const row = log.db.prepare("SELECT * FROM memory_events").get();

        assertEquals(row.ceiling_bytes, null);
        assertEquals(row.budget, null);

        log.close();
    },
});

Deno.test({
    name: "log — the GiB view reads by eye",
    sanitizeResources: false,
    fn: () => {
        const log = openLog();

        log.memory({
            at: "2026-10-27T23:00:00.000Z",
            subject: "load",
            event: "refuse",
            reason: "'voxtral:32k' needs 10.0 GiB",
            model: "voxtral:32k",
            requestId: "req_7f3a",
            bytes: 10 * GIB,
            budget: BUDGET,
        });

        log.flush();

        const row = log.db.prepare("SELECT * FROM v_memory_events").get();

        assertEquals(row.what, "voxtral:32k");
        assertEquals(row.gib, 10);
        assertEquals(row.free_gib, 32);

        log.close();
    },
});

Deno.test({
    name: "log — model sizes save and load back",
    sanitizeResources: false,
    fn: () => {
        const log = openLog();

        log.saveModelSize("bge-m3:latest", GIB, "2026-10-27T23:00:00.000Z");
        log.saveModelSize("bge-m3:latest", 2 * GIB, "2026-10-27T23:05:00.000Z");
        log.flush();

        assertEquals(log.loadModelSizes(), [{
            model: "bge-m3:latest",
            bytes: 2 * GIB,
            measuredAt: "2026-10-27T23:05:00.000Z",
        }]);

        log.close();
    },
});

//  =====================================================================
//  Privacy
//  =====================================================================

Deno.test({
    name: "log — freed text is zeroed, not left in free pages",
    sanitizeResources: false,
    fn: () => {
        const log = openLog();

        const row = log.db.prepare("PRAGMA secure_delete").get();

        assertEquals(row.secure_delete, 1);

        log.close();
    },
});

Deno.test({
    name: "log — the file and its folder become owner-only",
    sanitizeResources: false,
    fn: async () => {
        const dir = await Deno.makeTempDir();
        const path = join(dir, "decision-log.db");

        await Deno.chmod(dir, 0o755);

        const log = openDecisionLog(path, { log_prompts: false });

        log.flush();

        assertEquals(modeOf(dir), 0o700);
        assertEquals(modeOf(path), 0o600);
        assertEquals(log.tightened.includes(dir), true);
        assertEquals(log.tightened.includes(path), true);

        //  WAL files take the main file's mode once it is set.
        for (const suffix of ["-wal", "-shm"]) {
            try {
                assertEquals(modeOf(`${path}${suffix}`), 0o600);
            } catch (err) {
                if (!(err instanceof Deno.errors.NotFound)) {
                    throw err;
                }
            }
        }

        log.close();

        //  A second open finds nothing to fix.
        const again = openDecisionLog(path, { log_prompts: false });

        assertEquals(again.tightened, []);

        again.close();
        await Deno.remove(dir, { recursive: true });
    },
});
