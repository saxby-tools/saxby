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

import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION, VIEWS } from "./schema.js";

//  Flush when either threshold trips, whichever comes first.
const FLUSH_MAX_ROWS = 50;
const FLUSH_INTERVAL_MS = 500;

//  WAL lets the dashboard read while the daemon writes. NORMAL
//  synchronous is the standard WAL pairing: a crash can lose the last
//  transaction, which for an observability log is an acceptable trade
//  against an fsync per batch.
const PRAGMAS = [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA busy_timeout = 5000",
];

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
    "prompt_sha256",
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
 */
export function openDecisionLog(path, config) {
    const db = new DatabaseSync(path);

    for (const pragma of PRAGMAS) {
        db.exec(pragma);
    }

    const migration = migrate(db);

    refreshViews(db);
    stampMeta(db);

    const insertStmt = db.prepare(INSERT_SQL);
    const completeStmt = db.prepare(COMPLETE_SQL);

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
                if (op.kind === "insert") {
                    insertStmt.run(...op.values);
                    continue;
                }

                completeStmt.run(...op.values);
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

            prompt_sha256: entry.promptHash,
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
    return { record, complete, flush, close, stats, migration, db };
}
