//  =====================================================================
//  Decision log schema
//  =====================================================================
//  The transparent archive. Every routing decision shuntd makes lands
//  here, with the reasoning attached — not just what was chosen, but
//  what was observed and why every other tier declined.
//
//  Three rules the shape enforces:
//
//    1. STRICT tables. SQLite's default type affinity would silently
//       coerce a bad write. For an archive whose whole value is being
//       trustworthy, a loud failure beats a quiet coercion.
//
//    2. Two-phase. A row is INSERTed when the routing decision is
//       made and UPDATEd when the response finishes. A row with a
//       NULL completed_at is a request that never finished — that is
//       real signal (the 195s abandoned background tasks), not a gap
//       to hide.
//
//    3. Store narrowly. Derived counts, booleans and JSON summaries.
//       Never an AST, never a full message array.
//
//  Timestamps are ISO8601 UTC TEXT rather than epoch integers. They
//  sort correctly, SQLite's date functions accept them, and — the
//  deciding factor — they are readable when you open the file with
//  `sqlite3` at 2am. A transparent archive you cannot read by eye is
//  not transparent.

export const SCHEMA_VERSION = 2;

//  Applied in order; index is the version they upgrade TO.
//  Never edit a shipped migration — append a new one.
export const MIGRATIONS = [
    //  ---- v1 --------------------------------------------------------
    `
    CREATE TABLE decision_log (
        id                INTEGER PRIMARY KEY,
        log_id            TEXT    NOT NULL UNIQUE,

        --  Ties a row to the [req_7f3a] lines on stdout, so a live
        --  trace and the archive can be cross-referenced.
        request_id        TEXT    NOT NULL,

        --  ---- Timing ------------------------------------------------
        received_at       TEXT    NOT NULL,
        completed_at      TEXT,
        ttfb_ms           INTEGER,
        duration_ms       INTEGER,

        --  completed | aborted | upstream_error | router_error
        --  NULL means the row was never closed: shuntd died mid
        --  request, which is itself worth being able to count.
        outcome           TEXT,

        --  ---- Who asked ------------------------------------------------
        client_id         TEXT NOT NULL,   -- friendly name after mapping
        client_signature  TEXT NOT NULL,   -- normalized token the map keys on
        user_agent        TEXT,            -- raw, so mappings can be backfilled

        --  ---- What was asked for ------------------------------------
        requested_model   TEXT    NOT NULL,

        --  0 | 1 | NULL. NULL means the client omitted the field,
        --  which is distinct from explicitly false.
        stream            INTEGER,

        --  ---- The decision ------------------------------------------
        --  TEXT, not INTEGER: "fallback" is a tier and is not a number.
        tier              TEXT    NOT NULL,
        route             TEXT    NOT NULL,
        selected_model    TEXT    NOT NULL,
        override_persona  TEXT,

        tags              TEXT    NOT NULL,   -- JSON array
        candidates        TEXT    NOT NULL,   -- JSON array
        scores            TEXT,               -- JSON array
        skipped           TEXT,               -- JSON array

        --  Why every declining tier declined. The single most useful
        --  column when a route looks wrong six months from now.
        abstentions       TEXT    NOT NULL,   -- JSON array

        exhausted         INTEGER NOT NULL,

        --  ---- Evidence ----------------------------------------------
        features          TEXT    NOT NULL,   -- JSON object
        histogram         TEXT,               -- JSON object
        est_tokens        INTEGER NOT NULL,
        chars             INTEGER NOT NULL,
        lines             INTEGER NOT NULL,
        code_ratio        REAL    NOT NULL,

        --  ---- Semantic (Milestone 5) --------------------------------
        --  NULL until Tier 3 lands. Present now because adding a
        --  column later is cheap but BACKFILLING one is impossible,
        --  and comparability across the boundary is the whole point.
        --
        --  embedding_model and embedding_dim are stamped on every row
        --  so an A/B between bge-m3 and an alternative is a GROUP BY
        --  rather than an archaeology project. Cosine scores are NOT
        --  comparable across models; outcome metrics are.
        confidence        REAL,
        embedding_model   TEXT,
        embedding_dim     INTEGER,

        --  ---- Usage -------------------------------------------------
        --  From the upstream's usage block when it provides one.
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,

        --  ---- Prompt ------------------------------------------------
        --  The hash is always stored: it groups repeats and regenerates
        --  without retaining text. The text itself is config-gated
        --  (log_prompts), because someone else running shuntd may not
        --  want their whole working corpus on disk.
        prompt_sha256     TEXT    NOT NULL,
        prompt            TEXT
    ) STRICT;

    CREATE INDEX idx_decision_logid ON decision_log (log_id);
    CREATE INDEX idx_decision_received  ON decision_log (received_at);
    CREATE INDEX idx_decision_client    ON decision_log (client_id);
    CREATE INDEX idx_decision_model     ON decision_log (selected_model);
    CREATE INDEX idx_decision_tier      ON decision_log (tier);
    CREATE INDEX idx_decision_hash      ON decision_log (prompt_sha256);

    --  Discoverable from any SQL client, unlike PRAGMA user_version.
    --  The dashboard and any DuckDB query can read this directly.
    CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    ) STRICT;
    `,
    //  ---- v2 --------------------------------------------------------
    //  Tier 3 exemplar vectors.
    //
    //  Keyed by embedding model, so switching semantic.active to a
    //  different profile and back does not throw away either set —
    //  an A/B between embedders becomes a config line rather than a
    //  re-embed. Dimensions differ between models (bge-m3 is 1024,
    //  nomic-embed-text is 768), which is exactly why one shared
    //  table without the model in the key would be unusable.
    //
    //  exemplar_hash detects edited text: change an exemplar and its
    //  hash changes, the old row stops matching, and the new text is
    //  embedded on next boot.
    //
    //  Vectors are stored NORMALISED as Float32 blobs, so every read
    //  is comparison-ready and cosine() is a plain dot product.
    `
    CREATE TABLE exemplar_vectors (
        embedding_model TEXT    NOT NULL,
        persona         TEXT    NOT NULL,
        exemplar        TEXT    NOT NULL,
        exemplar_hash   TEXT    NOT NULL,
        dim             INTEGER NOT NULL,
        vector          BLOB    NOT NULL,
        created_at      TEXT    NOT NULL,

        PRIMARY KEY (embedding_model, persona, exemplar_hash)
    ) STRICT;

    CREATE INDEX idx_exemplar_model ON exemplar_vectors (embedding_model);
    `,
];

//  ---------------------------------------------------------------------
//  Convenience views
//  ---------------------------------------------------------------------
//  Rebuilt on every open (CREATE OR REPLACE is not available in
//  SQLite, so they are dropped first). Views are not data, so
//  recreating them is free and keeps them in sync with the code.

export const VIEWS = `
    DROP VIEW IF EXISTS v_routing_funnel;
    CREATE VIEW v_routing_funnel AS
    SELECT
        tier,
        COUNT(*)                                        AS requests,
        ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM decision_log), 1)
                                                        AS pct,
        ROUND(AVG(ttfb_ms))                             AS avg_ttfb_ms
    FROM decision_log
    GROUP BY tier
    ORDER BY requests DESC;

    DROP VIEW IF EXISTS v_client_mix;
    CREATE VIEW v_client_mix AS
    SELECT
        client_id,
        client_signature,
        COUNT(*)                AS requests,
        ROUND(AVG(est_tokens))  AS avg_est_tokens,
        SUM(CASE WHEN tier = 'fallback' THEN 1 ELSE 0 END) AS fell_back
    FROM decision_log
    GROUP BY client_id, client_signature
    ORDER BY requests DESC;

    --  Tags that fired but found no home. If this view has rows, the
    --  catalog is under-tagged and Tier 2 is quietly degraded.
    DROP VIEW IF EXISTS v_unclaimed_tags;
    CREATE VIEW v_unclaimed_tags AS
    SELECT
        tags,
        COUNT(*)      AS requests,
        MAX(received_at) AS last_seen
    FROM decision_log
    WHERE tier = 'fallback'
      AND tags != '[]'
    GROUP BY tags
    ORDER BY requests DESC;

    DROP VIEW IF EXISTS v_incomplete;
    CREATE VIEW v_incomplete AS
    SELECT
        request_id, received_at, client_id, selected_model,
        est_tokens, outcome
    FROM decision_log
    WHERE completed_at IS NULL
       OR outcome != 'completed'
    ORDER BY received_at DESC;

    --  Which embedding profiles have cached vectors, and how many.
    --  Rows for more than one model mean an A/B is in flight.
    DROP VIEW IF EXISTS v_exemplar_cache;
    CREATE VIEW v_exemplar_cache AS
    SELECT
        embedding_model,
        dim,
        COUNT(*)                  AS vectors,
        COUNT(DISTINCT persona)   AS personas,
        MIN(created_at)           AS first_cached,
        MAX(created_at)           AS last_cached
    FROM exemplar_vectors
    GROUP BY embedding_model, dim;
`;
