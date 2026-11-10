import { assertEquals } from "@std/assert";
import { openDecisionLog } from "../log/db.js";
import { hashExemplar, warmExemplars } from "./exemplars.js";
import { toBlob } from "./vector.js";

//  The vector cache lives in the decision log's file, so an in-memory
//  log gives a real table. Every exemplar here is cached first, so no
//  embedder is called and the upstream URL is never used.

const PROFILE = { model: "embedder-a", dim: 2, threshold: 0.5 };
const NOWHERE = "http://unused.test";

function cacheVector(db, persona, exemplar) {
    db.prepare(`
        INSERT INTO exemplar_vectors
            (embedding_model, persona, exemplar, exemplar_hash, dim,
             vector, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        PROFILE.model,
        persona,
        exemplar,
        hashExemplar(exemplar),
        2,
        toBlob(new Float32Array([1, 0])),
        "2026-11-09T00:00:00.000Z",
    );
}

function configWith(personas) {
    return { personas };
}

Deno.test({
    name: "exemplars — a cached exemplar is reused, not embedded",
    sanitizeResources: false,
    fn: async () => {
        const log = await openDecisionLog(":memory:", {});

        cacheVector(log.db, "coder", "refactor this");

        const warmed = await warmExemplars(
            log.db,
            configWith({ coder: { exemplars: ["refactor this"] } }),
            PROFILE,
            NOWHERE,
        );

        assertEquals(warmed.embedded, 0);
        assertEquals(warmed.reused, 1);
        assertEquals(warmed.candidates[0].label, "coder");
    },
});

Deno.test({
    name: "exemplars — one moved to another persona takes its label",
    sanitizeResources: false,
    fn: async () => {
        const log = await openDecisionLog(":memory:", {});

        cacheVector(log.db, "coder", "refactor this");

        //  The same text, now under `reviewer`. The vector is still
        //  good; the persona it answers for is the config's.
        const warmed = await warmExemplars(
            log.db,
            configWith({
                coder: { exemplars: [] },
                reviewer: { exemplars: ["refactor this"] },
            }),
            PROFILE,
            NOWHERE,
        );

        assertEquals(warmed.embedded, 0);
        assertEquals(warmed.candidates.map((c) => c.label), ["reviewer"]);
    },
});
