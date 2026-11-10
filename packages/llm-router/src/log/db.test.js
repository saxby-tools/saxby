import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { openDecisionLog } from "./db.js";
import { MIGRATIONS } from "./schema.js";

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

//  The least a routed request needs for record().
function entryFor(log, prompt) {
    return log.hashPrompt(prompt).then((promptHash) => ({
        requestId: "req_0001",
        receivedAt: "2026-10-28T00:00:00.000Z",
        client: { id: "curl", signature: "curl", userAgent: "curl/8.0" },
        requestedModel: "saxby",
        stream: true,
        decision: {
            tier: 2,
            route: "capability",
            model: "model-a",
            candidates: ["model-a"],
            scores: [],
            skipped: [],
            abstentions: [],
            exhausted: false,
        },
        intent: {
            override: null,
            tags: [],
            features: {},
            histogram: {},
            metrics: { estimatedTokens: 2, chars: 5, lines: 1, codeRatio: 0 },
        },
        prompt,
        promptHash,
        semantic: null,
        systemPrefix: null,
    }));
}

//  A log as v0.9.6 left it: schema v4, one row with a plain hash.
function writeV4Log(path) {
    const db = new DatabaseSync(path);

    for (const migration of MIGRATIONS.slice(0, 4)) {
        db.exec(migration);
    }

    db.exec("PRAGMA user_version = 4");

    db.prepare(`
        INSERT INTO decision_log (
            log_id, request_id, received_at, client_id, client_signature,
            requested_model, tier, route, selected_model, tags, candidates,
            abstentions, exhausted, features, est_tokens, chars, lines,
            code_ratio, prompt_sha256
        ) VALUES (
            'old-1', 'req_0000', '2026-10-01T00:00:00.000Z', 'curl', 'curl',
            'saxby', '2', 'capability', 'model-a', '[]', '["model-a"]',
            '[]', 0, '{}', 2, 5, 1, 0.0, 'abc123'
        )
    `).run();

    db.close();
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
    fn: async () => {
        const log = await openLog();

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
    fn: async () => {
        const log = await openLog();

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
    fn: async () => {
        const log = await openLog();

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
    fn: async () => {
        const log = await openLog();

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
    fn: async () => {
        const log = await openLog();

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

        const log = await openDecisionLog(path, { log_prompts: false });

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
        const again = await openDecisionLog(path, { log_prompts: false });

        assertEquals(again.tightened, []);

        again.close();
        await Deno.remove(dir, { recursive: true });
    },
});

Deno.test({
    name: "log — setLogPrompts changes what the next row stores",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();

        log.record(await entryFor(log, "before"));
        log.setLogPrompts(true);
        log.record(await entryFor(log, "kept"));
        log.setLogPrompts(false);
        log.record(await entryFor(log, "after"));
        log.flush();

        //  Read back by hash: log ids do not sort by arrival.
        const find = log.db.prepare(
            "SELECT prompt FROM decision_log WHERE prompt_hash = ?",
        );

        const stored = [];

        for (const text of ["before", "kept", "after"]) {
            stored.push(find.get(await log.hashPrompt(text)).prompt);
        }

        assertEquals(stored, [null, "kept", null]);
    },
});

Deno.test({
    name: "log — the prompt hash is keyed and stamped with its scheme",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();

        log.record(await entryFor(log, "hello"));
        log.flush();

        const row = log.db.prepare(
            "SELECT prompt_hash, prompt_hash_scheme, prompt FROM decision_log",
        ).get();

        assertEquals(row.prompt_hash, await log.hashPrompt("hello"));
        assertEquals(row.prompt_hash_scheme, "hmac-sha256");
        assertEquals(row.prompt, null);

        log.close();
    },
});

Deno.test({
    name: "log — the key file is made once, owner-only, and reused",
    sanitizeResources: false,
    fn: async () => {
        const dir = await Deno.makeTempDir();
        const path = join(dir, "decision-log.db");
        const keyPath = join(dir, "prompt-hash.key");

        const first = await openDecisionLog(path, {}, keyPath);
        const hashA = await first.hashPrompt("hello");

        first.close();

        assertEquals(modeOf(keyPath), 0o600);
        assertEquals(
            /^[0-9a-f]{64}$/.test((await Deno.readTextFile(keyPath)).trim()),
            true,
        );

        const second = await openDecisionLog(path, {}, keyPath);

        assertEquals(await second.hashPrompt("hello"), hashA);

        second.close();

        //  No key path: a key for this process only.
        const ephemeral = await openLog();

        assertNotEquals(await ephemeral.hashPrompt("hello"), hashA);

        ephemeral.close();
        await Deno.remove(dir, { recursive: true });
    },
});

Deno.test({
    name: "log — rows from before the keyed hash keep their scheme",
    sanitizeResources: false,
    fn: async () => {
        const dir = await Deno.makeTempDir();
        const path = join(dir, "decision-log.db");

        writeV4Log(path);

        const log = await openDecisionLog(path, { log_prompts: false });

        assertEquals(log.migration.from, 4);
        assertEquals(log.migration.to, 7);

        const old = log.db.prepare(
            "SELECT prompt_hash, prompt_hash_scheme FROM decision_log",
        ).get();

        assertEquals(old.prompt_hash, "abc123");
        assertEquals(old.prompt_hash_scheme, "sha256");

        //  New rows land beside it under the new scheme.
        log.record(await entryFor(log, "hello"));
        log.flush();

        const schemes = log.db.prepare(
            "SELECT prompt_hash_scheme AS s FROM decision_log ORDER BY id",
        ).all().map((row) => row.s);

        assertEquals(schemes, ["sha256", "hmac-sha256"]);

        log.close();
        await Deno.remove(dir, { recursive: true });
    },
});

Deno.test({
    name: "log — fields Saxby added for a client land on the row",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();
        const added = await entryFor(log, "hello");
        const plain = await entryFor(log, "hello");

        added.clientDefaults = { reasoning_effort: "none" };

        log.record(added);
        log.record(plain);
        log.flush();

        const rows = log.db.prepare(
            "SELECT client_defaults AS d FROM decision_log ORDER BY id",
        ).all().map((row) => row.d);

        assertEquals(JSON.parse(rows[0]), { reasoning_effort: "none" });
        assertEquals(rows[1], null);

        log.close();
    },
});

//  =====================================================================
//  The time note
//  =====================================================================

Deno.test({
    name: "log — the row says the note was on and what gap it named",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();
        const resumed = await entryFor(log, "hello");
        const fresh = await entryFor(log, "hello");
        const off = await entryFor(log, "hello");

        resumed.messagePrefix = { gapHours: 27.5 };
        fresh.messagePrefix = { gapHours: null };
        off.messagePrefix = null;

        log.record(resumed);
        log.record(fresh);
        log.record(off);
        log.flush();

        const rows = log.db.prepare(
            "SELECT message_prefix AS p, message_prefix_gap_hours AS g " +
                "FROM decision_log ORDER BY id",
        ).all();

        assertEquals(rows, [
            { p: 1, g: 27.5 },
            { p: 1, g: null },
            { p: 0, g: null },
        ]);

        log.close();
    },
});

Deno.test({
    name: "log — a message keeps the time it was first seen",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();

        log.rememberFirstSeen("conv-a", ["m1", "m2"], "2026-10-26T06:30:00Z");
        log.rememberFirstSeen("conv-a", ["m2", "m3"], "2026-10-27T09:00:00Z");
        log.rememberFirstSeen("conv-b", ["m1"], "2026-10-28T00:00:00Z");
        log.flush();

        const seen = log.findFirstSeen("conv-a");

        assertEquals([...seen.entries()], [
            ["m1", "2026-10-26T06:30:00Z"],
            ["m2", "2026-10-26T06:30:00Z"],
            ["m3", "2026-10-27T09:00:00Z"],
        ]);

        //  The same hash in another conversation is another row.
        assertEquals(
            log.findFirstSeen("conv-b").get("m1"),
            "2026-10-28T00:00:00Z",
        );
        assertEquals(log.findFirstSeen("conv-c").size, 0);

        log.close();
    },
});

Deno.test({
    name: "log — a conversation idle for ninety days is dropped whole",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();
        const insert = log.db.prepare(
            "INSERT INTO message_seen VALUES (?, ?, ?)",
        );

        //  An old conversation, and one that was old but came back.
        insert.run("old", "m1", "2026-01-01T00:00:00.000Z");
        insert.run("old", "m2", "2026-01-02T00:00:00.000Z");
        insert.run("back", "m1", "2026-01-01T00:00:00.000Z");
        insert.run("back", "m2", new Date().toISOString());

        //  The first write after open queues the sweep.
        log.rememberFirstSeen("new", ["m1"], new Date().toISOString());
        log.flush();

        const keys = log.db.prepare(
            "SELECT DISTINCT conversation_key AS k FROM message_seen " +
                "ORDER BY k",
        ).all().map((row) => row.k);

        assertEquals(keys, ["back", "new"]);
        assertEquals(log.findFirstSeen("back").size, 2);

        log.close();
    },
});
