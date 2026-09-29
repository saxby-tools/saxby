//  =====================================================================
//  Exemplar vector cache
//  =====================================================================
//  Persona exemplars are embedded once and cached in SQLite, keyed by
//  embedding model. Two consequences, both deliberate:
//
//    1. Restarts are free. Nothing re-embeds unless the exemplar text
//       or the model changed.
//    2. Switching profiles is reversible. Flip `semantic.active` to
//       another profile and back, and both sets of vectors are still
//       there — an A/B is a config line, not a re-embed.
//
//  Cache keys are (model, persona, exemplar hash). Editing an
//  exemplar changes its hash, so the old row is ignored and the new
//  text is embedded. Stale rows are pruned rather than left to
//  accumulate, since a vector nobody can reach is just weight.
//
//  Vectors are stored NORMALISED. Every read is comparison-ready and
//  there is no path where a raw vector reaches cosine().

import { embedMany } from "./embed.js";
import { fromBlob, normalize, toBlob } from "./vector.js";

const SELECT_SQL = `
    SELECT persona, exemplar, exemplar_hash, vector
    FROM exemplar_vectors
    WHERE embedding_model = ?
`;

const INSERT_SQL = `
    INSERT INTO exemplar_vectors
        (embedding_model, persona, exemplar, exemplar_hash, dim,
         vector, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(embedding_model, persona, exemplar_hash)
    DO UPDATE SET vector = excluded.vector, dim = excluded.dim
`;

const PRUNE_SQL = `
    DELETE FROM exemplar_vectors
    WHERE embedding_model = ?
      AND exemplar_hash NOT IN (SELECT value FROM json_each(?))
`;

/**
 * Stable short hash of an exemplar string.
 *
 * Only needs to detect a change, not resist an attacker, so FNV-1a is
 * plenty and avoids making the whole warm-up path async.
 */
function hashExemplar(text) {
    let hash = 0x811c9dc5;

    for (let i = 0; i < text.length; i++) {
        hash = hash ^ text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Flattens personas into the exemplars Tier 3 can match against.
 */
function collectExemplars(config) {
    const wanted = [];

    for (const [name, persona] of Object.entries(config.personas)) {
        for (const exemplar of persona.exemplars || []) {
            const text = String(exemplar).trim();

            if (text.length === 0) {
                continue;
            }

            wanted.push({
                persona: name,
                exemplar: text,
                hash: hashExemplar(text),
            });
        }
    }

    return wanted;
}

/**
 * Reads every cached vector for one embedding model.
 */
function readCached(db, model) {
    const rows = db.prepare(SELECT_SQL).all(model);
    const cached = new Map();

    for (const row of rows) {
        cached.set(row.exemplar_hash, {
            persona: row.persona,
            exemplar: row.exemplar,
            vector: fromBlob(row.vector),
        });
    }

    return cached;
}

/**
 * Embeds and stores whatever is missing, then prunes what is stale.
 *
 * @returns {{candidates, embedded, reused, pruned}}
 *   candidates are {label, exemplar, vector}, ready for bestMatch()
 */
export async function warmExemplars(db, config, profile, upstreamUrl) {
    const wanted = collectExemplars(config);

    if (wanted.length === 0) {
        return { candidates: [], embedded: 0, reused: 0, pruned: 0 };
    }

    const cached = readCached(db, profile.model);

    const missing = wanted.filter((item) => !cached.has(item.hash));

    let embedded = 0;

    if (missing.length > 0) {
        const vectors = await embedMany(
            missing.map((item) => item.exemplar),
            profile,
            upstreamUrl,
        );

        const insert = db.prepare(INSERT_SQL);
        const now = new Date().toISOString();

        db.exec("BEGIN");

        try {
            for (let i = 0; i < missing.length; i++) {
                const item = missing[i];
                const vector = normalize(vectors[i]);

                insert.run(
                    profile.model,
                    item.persona,
                    item.exemplar,
                    item.hash,
                    vector.length,
                    toBlob(vector),
                    now,
                );

                cached.set(item.hash, {
                    persona: item.persona,
                    exemplar: item.exemplar,
                    vector,
                });
            }

            db.exec("COMMIT");
            embedded = missing.length;
        } catch (err) {
            db.exec("ROLLBACK");

            throw new Error(
                `Failed to cache exemplar vectors: ${err.message}`,
            );
        }
    }

    //  Drop vectors for exemplars that no longer exist in config.
    const liveHashes = wanted.map((item) => item.hash);

    const pruned = db
        .prepare(PRUNE_SQL)
        .run(profile.model, JSON.stringify(liveHashes));

    const candidates = wanted.map((item) => {
        const entry = cached.get(item.hash);

        return {
            label: entry.persona,
            exemplar: entry.exemplar,
            vector: entry.vector,
        };
    });

    return {
        candidates,
        embedded,
        reused: wanted.length - embedded,
        pruned: pruned.changes ?? 0,
    };
}
