//  =====================================================================
//  Decision log writer
//  =====================================================================
//  node:sqlite is built into Deno (since 2.2), so this adds no
//  dependency, no native build, and nothing that would complicate
//  `deno compile` across four targets.
//
//  DatabaseSync is SYNCHRONOUS. A write in the request path would
//  block the event loop on every request, so nothing here is called
//  inline: rows are queued and flushed in batches inside a single
//  transaction. A batch of fifty is sub-millisecond; a write per
//  request would not be.
//
//  Two-phase, as the schema describes:
//
//    record(entry)        INSERT when the routing decision is made
//    complete(id, result) UPDATE when the response finishes
//
//  Both go through ONE FIFO queue. That ordering is load-bearing — an
//  UPDATE flushed before its INSERT would silently match no rows.
//
//  The memory broker's events and measured model sizes ride the same
//  queue (memory, saveModelSize), so they never write inline either.

import { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path";
import { MIGRATIONS, SCHEMA_VERSION, VIEWS } from "./schema.js";
import { createPromptHasher, PROMPT_HASH_SCHEME } from "./client.js";

//  Flush when either threshold trips, whichever comes first.
const FLUSH_MAX_ROWS = 50;
const FLUSH_INTERVAL_MS = 500;

//  WAL lets the dashboard read while the daemon writes. NORMAL
//  synchronous is the standard WAL pairing: a crash can lose the last
//  transaction, which for an observability log is an acceptable trade
//  against an fsync per batch.
//
//  secure_delete zero-fills what a DELETE or UPDATE frees. Without it
//  a prompt blanked with `SET prompt = NULL` stays in the file's free
//  pages until a VACUUM. Deno's bundled SQLite ships with it off.
const PRAGMAS = [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA secure_delete = ON",
];

//  Owner-only. The log holds prompts whenever log_prompts is on, and
//  the -wal file holds the latest batches either way. SQLite gives
//  -wal and -shm the main file's mode, so fixing the main file once
//  covers every later open; both are fixed here too for the open
//  that finds them already there.
const MODE_FILE = 0o600;
const MODE_DIR = 0o700;
const MODE_MASK = 0o777;
const IN_MEMORY = ":memory:";

//  The prompt hash key: 32 random bytes as 64 hex characters, made on
//  first open and never rotated by Saxby. Deleting the file starts a
//  new key, and grouping starts over from there.
const KEY_BYTES = 32;
const KEY_HEX = /^[0-9a-f]{64}$/;

//  Single source of truth for the INSERT. The SQL and the value array
//  are both generated from this list, so they cannot drift — the
//  failure mode of a hand-maintained 30-placeholder statement is a
//  silent column shift, which would poison the archive invisibly.
const INSERT_COLUMNS = [
    "log_id",
    "request_id",
    "received_at",
    "client_id",
    "client_signature",
    "user_agent",
    "requested_model",
    "stream",
    "tier",
    "route",
    "selected_model",
    "override_persona",
    "tags",
    "candidates",
    "scores",
    "skipped",
    "abstentions",
    "exhausted",
    "features",
    "histogram",
    "est_tokens",
    "chars",
    "lines",
    "code_ratio",
    "confidence",
    "embedding_model",
    "embedding_dim",
    "prompt_hash",
    "prompt_hash_scheme",
    "prompt",
    "system_prefix",
];

const INSERT_SQL = `
    INSERT INTO decision_log (${INSERT_COLUMNS.join(", ")})
    VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})
`;

const COMPLETE_SQL = `
    UPDATE decision_log SET
        completed_at      = ?,
        ttfb_ms           = ?,
        duration_ms       = ?,
        outcome           = ?,
        prompt_tokens     = ?,
        completion_tokens = ?
    WHERE log_id = ?
`;

//  Memory broker events. Generated the same way as INSERT_SQL, for the
//  same reason.
const MEMORY_COLUMNS = [
    "at",
    "subject",
    "event",
    "reason",
    "reservation_id",
    "request_id",
    "model",
    "label",
    "pid",
    "child_pid",
    "bytes",
    "wait_ms",
    "ceiling_bytes",
    "margin_bytes",
    "pinned_bytes",
    "loaded_bytes",
    "reserved_bytes",
    "free_bytes",
    "used_bytes",
    "budget",
];

const MEMORY_SQL = `
    INSERT INTO memory_events (${MEMORY_COLUMNS.join(", ")})
    VALUES (${MEMORY_COLUMNS.map(() => "?").join(", ")})
`;

const SIZE_UPSERT_SQL = `
    INSERT INTO model_sizes (model, bytes, measured_at) VALUES (?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
        bytes       = excluded.bytes,
        measured_at = excluded.measured_at
`;

const SIZE_SELECT_SQL = `
    SELECT model, bytes, measured_at FROM model_sizes
`;

//  ---------------------------------------------------------------------
//  Serialisation helpers
//  ---------------------------------------------------------------------
//  STRICT tables reject a JS object, so every JSON column is stringified
//  exactly once, here. Doing it at the call site is how you end up with
//  half the rows holding "[object Object]".

function toJson(value) {
    if (value === null) {
        return null;
    }

    if (value === undefined) {
        return null;
    }

    return JSON.stringify(value);
}

function toBool(value) {
    if (value === null) {
        return null;
    }

    if (value === undefined) {
        return null;
    }

    return value ? 1 : 0;
}

//  ---------------------------------------------------------------------
//  File modes
//  ---------------------------------------------------------------------

/**
 * Sets one path to the mode, if it exists and differs. Returns
 * whether anything changed. A platform that reports no mode (Windows)
 * is left alone.
 */
function tightenMode(target, mode) {
    let current;

    try {
        current = Deno.statSync(target).mode;
    } catch {
        return false;
    }

    if (current === null) {
        return false;
    }

    if ((current & MODE_MASK) === mode) {
        return false;
    }

    Deno.chmodSync(target, mode);

    return true;
}

/**
 * Makes the log, its WAL files and the folder holding them owner-only.
 * Returns the paths it changed. Never throws: a mode that cannot be
 * set costs a warning, not the log.
 */
function tightenModes(path) {
    if (path === IN_MEMORY) {
        return [];
    }

    const targets = [
        [dirname(path), MODE_DIR],
        [path, MODE_FILE],
        [`${path}-wal`, MODE_FILE],
        [`${path}-shm`, MODE_FILE],
    ];

    const changed = [];

    for (const [target, mode] of targets) {
        try {
            if (tightenMode(target, mode)) {
                changed.push(target);
            }
        } catch (err) {
            console.warn(
                `⚠️  could not make ${target} owner-only: ${err.message}`,
            );
        }
    }

    return changed;
}

//  ---------------------------------------------------------------------
//  Prompt hash key
//  ---------------------------------------------------------------------

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);

    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }

    return bytes;
}

/**
 * Reads the instance's key, creating it owner-only on first open.
 * With no path (tests, in-memory logs) the key lives for this process
 * only. A key that cannot be read or written stops the open: a folder
 * that cannot hold a key cannot hold a WAL file either.
 */
function readOrCreateKey(keyPath) {
    if (!keyPath) {
        return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    }

    let hex = null;

    try {
        hex = Deno.readTextFileSync(keyPath).trim();
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            throw err;
        }
    }

    if (hex === null) {
        const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
        const fresh = [...bytes]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");

        Deno.writeTextFileSync(keyPath, `${fresh}\n`, { mode: MODE_FILE });

        return bytes;
    }

    if (!KEY_HEX.test(hex)) {
        throw new Error(
            `${keyPath} is not a prompt hash key (64 hex characters). ` +
                `Move it aside to start a new key.`,
        );
    }

    tightenMode(keyPath, MODE_FILE);

    return hexToBytes(hex);
}

//  ---------------------------------------------------------------------
//  Schema management
//  ---------------------------------------------------------------------

function currentVersion(db) {
    const row = db.prepare("PRAGMA user_version").get();

    return row.user_version ?? 0;
}

function migrate(db) {
    const from = currentVersion(db);

    if (from >= SCHEMA_VERSION) {
        return { from, to: from, applied: 0 };
    }

    let applied = 0;

    //  Migration at index i upgrades the store TO version i + 1.
    for (let i = from; i < MIGRATIONS.length; i++) {
        db.exec("BEGIN");

        try {
            db.exec(MIGRATIONS[i]);
            db.exec(`PRAGMA user_version = ${i + 1}`);
            db.exec("COMMIT");
            applied++;
        } catch (err) {
            db.exec("ROLLBACK");

            throw new Error(
                `Migration to v${i + 1} failed: ${err.message}`,
            );
        }
    }

    return { from, to: SCHEMA_VERSION, applied };
}

function refreshViews(db) {
    //  Views are derived, never data. Rebuilding on every open keeps
    //  them in lockstep with the code rather than with the file.
    db.exec(VIEWS);
}

function stampMeta(db) {
    const upsert = db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    upsert.run("schema_version", String(SCHEMA_VERSION));
    upsert.run("last_opened_at", new Date().toISOString());
}

//  ---------------------------------------------------------------------
//  Read-only access
//  ---------------------------------------------------------------------
//  The dashboard uses this. Read-only by FLAG, not by convention: the
//  observability layer must be structurally incapable of corrupting
//  the archive it observes.

export function openDecisionLogReadOnly(path) {
    return new DatabaseSync(path, { readOnly: true });
}

//  ---------------------------------------------------------------------
//  Writer
//  ---------------------------------------------------------------------

/**
 * Opens (and migrates) the decision log, returning a writer.
 *
 * @param {string} path
 * @param {Object} config - reads config.log_prompts
 * @param {string | null} keyPath - the instance's prompt-hash.key;
 *   null keeps a key for this process only
 */
export async function openDecisionLog(path, config, keyPath = null) {
    const hashPrompt = await createPromptHasher(readOrCreateKey(keyPath));

    const db = new DatabaseSync(path);

    for (const pragma of PRAGMAS) {
        db.exec(pragma);
    }

    const tightened = tightenModes(path);

    const migration = migrate(db);

    refreshViews(db);
    stampMeta(db);

    const insertStmt = db.prepare(INSERT_SQL);
    const completeStmt = db.prepare(COMPLETE_SQL);
    const memoryStmt = db.prepare(MEMORY_SQL);
    const sizeStmt = db.prepare(SIZE_UPSERT_SQL);

    const statements = {
        insert: insertStmt,
        complete: completeStmt,
        memory: memoryStmt,
        size: sizeStmt,
    };

    const queue = [];

    let timer = null;
    let closed = false;
    let written = 0;
    let dropped = 0;

    //  ---- Flush -----------------------------------------------------

    function flush() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }

        if (queue.length === 0) {
            return 0;
        }

        const batch = queue.splice(0, queue.length);

        db.exec("BEGIN");

        try {
            for (const op of batch) {
                statements[op.kind].run(...op.values);
            }

            db.exec("COMMIT");
            written += batch.length;
        } catch (err) {
            db.exec("ROLLBACK");
            dropped += batch.length;

            //  A failed log write must never take the router down.
            //  Loud, not fatal.
            console.error(
                `⚠️  decision log flush failed (${batch.length} rows ` +
                    `dropped): ${err.message}`,
            );
        }

        return batch.length;
    }

    function scheduleFlush() {
        if (queue.length >= FLUSH_MAX_ROWS) {
            flush();
            return;
        }

        if (timer !== null) {
            return;
        }

        timer = setTimeout(flush, FLUSH_INTERVAL_MS);

        //  Never hold the process open just to flush a log.
        Deno.unrefTimer(timer);
    }

    function enqueue(op) {
        if (closed) {
            return;
        }

        queue.push(op);
        scheduleFlush();
    }

    //  ---- Phase 1: the routing decision -----------------------------

    /**
     * Records a routing decision. Returns the log_id used to close it.
     */
    function record(entry) {
        const logId = crypto.randomUUID();

        const row = {
            log_id: logId,
            request_id: entry.requestId,
            received_at: entry.receivedAt,

            client_id: entry.client.id,
            client_signature: entry.client.signature,
            user_agent: entry.client.userAgent,

            requested_model: entry.requestedModel,
            stream: toBool(entry.stream),

            tier: String(entry.decision.tier),
            route: entry.decision.route,
            //  Empty, not NULL, for a refused request: the column is
            //  NOT NULL, and no model was used. Its outcome is
            //  'refused', alongside completed | aborted | upstream_error
            //  | router_error.
            selected_model: entry.decision.model ?? "",
            override_persona: entry.intent.override,

            tags: toJson(entry.intent.tags),
            candidates: toJson(entry.decision.candidates),
            scores: toJson(entry.decision.scores),
            skipped: toJson(entry.decision.skipped),
            abstentions: toJson(entry.decision.abstentions),
            exhausted: toBool(entry.decision.exhausted),

            features: toJson(entry.intent.features),
            histogram: toJson(entry.intent.histogram),
            est_tokens: entry.intent.metrics.estimatedTokens,
            chars: entry.intent.metrics.chars,
            lines: entry.intent.metrics.lines,
            code_ratio: entry.intent.metrics.codeRatio,

            //  Populated by Tier 3 in Milestone 5.
            confidence: entry.semantic?.confidence ?? null,
            embedding_model: entry.semantic?.model ?? null,
            embedding_dim: entry.semantic?.dim ?? null,

            prompt_hash: entry.promptHash,
            prompt_hash_scheme: PROMPT_HASH_SCHEME,
            prompt: config.log_prompts ? entry.prompt : null,

            system_prefix: entry.systemPrefix ?? null,
        };

        enqueue({
            kind: "insert",
            values: INSERT_COLUMNS.map((column) => row[column] ?? null),
        });

        return logId;
    }

    //  ---- Phase 2: the outcome --------------------------------------

    /**
     * Closes a row. A row never closed stays NULL, which is how an
     * abandoned request stays visible instead of vanishing.
     */
    function complete(logId, result) {
        if (!logId) {
            return;
        }

        enqueue({
            kind: "complete",
            values: [
                new Date().toISOString(),
                result.ttfbMs ?? null,
                result.durationMs ?? null,
                result.outcome,
                result.promptTokens ?? null,
                result.completionTokens ?? null,
                logId,
            ],
        });
    }

    //  ---- Memory broker ----------------------------------------------

    //  The parts of a budget no column holds, kept so a row can be
    //  checked by hand: where each pinned size came from, and why a
    //  term was unknown.
    function budgetDetail(budget) {
        return {
            ceiling_source: budget.ceilingSource,
            pinned: budget.pinned,
            loaded: budget.loaded,
            unknowns: budget.unknowns,
            used_source: budget.usedSource,
        };
    }

    /**
     * Records one memory broker event (memory/broker.js shapes it).
     */
    function memory(event) {
        const budget = event.budget ?? null;

        const row = {
            at: event.at,
            subject: event.subject,
            event: event.event,
            reason: event.reason,
            reservation_id: event.reservationId,
            request_id: event.requestId,
            model: event.model,
            label: event.label,
            pid: event.pid,
            child_pid: event.childPid,
            bytes: event.bytes,
            wait_ms: event.waitMs,
            ceiling_bytes: budget?.ceilingBytes,
            margin_bytes: budget?.marginBytes,
            pinned_bytes: budget?.pinnedBytes,
            loaded_bytes: budget?.loadedBytes,
            reserved_bytes: budget?.reservedBytes,
            free_bytes: budget?.freeBytes,
            used_bytes: budget?.usedBytes,
            budget: budget ? toJson(budgetDetail(budget)) : null,
        };

        enqueue({
            kind: "memory",
            values: MEMORY_COLUMNS.map((column) => row[column] ?? null),
        });
    }

    function saveModelSize(model, bytes, measuredAt) {
        enqueue({ kind: "size", values: [model, bytes, measuredAt] });
    }

    /**
     * Every remembered model size, read once at boot. Synchronous, like
     * the exemplar cache's read.
     */
    function loadModelSizes() {
        return db.prepare(SIZE_SELECT_SQL).all().map((row) => ({
            model: row.model,
            bytes: row.bytes,
            measuredAt: row.measured_at,
        }));
    }

    //  ---- Lifecycle --------------------------------------------------

    function close() {
        if (closed) {
            return;
        }

        flush();
        closed = true;
        db.close();
    }

    function stats() {
        return { written, dropped, pending: queue.length, migration };
    }

    //  Queued rows are in memory only. A shutdown that skipped this
    //  would lose up to FLUSH_INTERVAL_MS of history, including the
    //  completion of every in-flight request.
    for (const signal of ["SIGINT", "SIGTERM"]) {
        try {
            Deno.addSignalListener(signal, () => {
                close();
                Deno.exit(0);
            });
        } catch {
            //  Not every signal is available on every platform.
        }
    }

    globalThis.addEventListener("unload", close);

    //  The exemplar vector cache lives in this same file and shares
    //  this connection rather than opening a second one.
    return {
        hashPrompt,
        record,
        complete,
        memory,
        saveModelSize,
        loadModelSizes,
        flush,
        close,
        stats,
        migration,
        tightened,
        db,
    };
}
