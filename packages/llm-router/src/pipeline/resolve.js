//  =====================================================================
//  Routing gauntlet
//  =====================================================================
//  Two phases, deliberately separate:
//
//    resolveIntent(extracted, config)  -> ordered candidate models
//    selectModel(intent, tokens, …)    -> one concrete model id
//
//  Tier 3 (semantic) will replace only the first. The second stays
//  identical, which is why they are not merged.
//
//  EVERY abstention records a reason. Falling silently from Tier 2 to
//  the global default made a config problem (no model claimed any
//  tag) look like correct behaviour. Silence was the bug; the
//  fallback was only the symptom.

/**
 * Every model named as a persona's default. Used to break scoring
 * ties toward the model the user explicitly chose for that role.
 */
function collectPersonaDefaults(personas) {
    const defaults = new Set();

    for (const persona of Object.values(personas)) {
        if (!persona.default_model) {
            continue;
        }

        defaults.add(persona.default_model);
    }

    return defaults;
}

/**
 * Orders two equally-scoring models deterministically.
 *
 * Without this, ties fell to catalog key order — meaning routing
 * changed when someone reordered their config file. Three levels:
 * overlap, then persona preference, then name.
 */
function compareCandidates(a, b, personaDefaults) {
    if (b.score !== a.score) {
        return b.score - a.score;
    }

    const aPreferred = personaDefaults.has(a.modelId) ? 1 : 0;
    const bPreferred = personaDefaults.has(b.modelId) ? 1 : 0;

    if (bPreferred !== aPreferred) {
        return bPreferred - aPreferred;
    }

    //  Final tiebreak is alphabetical purely for determinism: the
    //  same config must always route the same way.
    return a.modelId.localeCompare(b.modelId);
}

/**
 * Scores catalog models by how many of the prompt's tags they claim.
 */
function scoreCatalogByTags(tags, config) {
    const personaDefaults = collectPersonaDefaults(config.personas);
    const scored = [];

    for (const [modelId, model] of Object.entries(config.catalog)) {
        const capabilities = model.capabilities || [];

        if (capabilities.length === 0) {
            continue;
        }

        let overlap = 0;

        for (const tag of tags) {
            if (!capabilities.includes(tag)) {
                continue;
            }

            overlap++;
        }

        if (overlap === 0) {
            continue;
        }

        scored.push({ modelId, score: overlap });
    }

    scored.sort((a, b) => compareCandidates(a, b, personaDefaults));

    return scored;
}

/**
 * Scores personas by tag overlap, for configs that route by persona
 * rather than by per-model capability.
 */
function scorePersonasByTags(tags, personas) {
    const scored = [];

    for (const [name, persona] of Object.entries(personas)) {
        const owned = persona.tags || [];

        if (owned.length === 0) {
            continue;
        }

        let overlap = 0;

        for (const tag of tags) {
            if (!owned.includes(tag)) {
                continue;
            }

            overlap++;
        }

        if (overlap === 0) {
            continue;
        }

        scored.push({ name, persona, score: overlap });
    }

    scored.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }

        return a.name.localeCompare(b.name);
    });

    return scored;
}

/**
 * Phase 1 — which persona / capability class does this prompt want?
 *
 * @returns {{tier, route, candidates, scores, abstentions}}
 */
export function resolveIntent(extracted, config) {
    const abstentions = [];

    //  ---- TIER 1: explicit override ---------------------------------
    if (extracted.override) {
        const persona = config.personas[extracted.override];

        return {
            tier: 1,
            route: `override:${extracted.override}`,
            candidates: [persona.default_model],
            scores: [],
            abstentions,
        };
    }

    abstentions.push({ tier: 1, reason: "no /command or explicit model" });

    //  ---- TIER 2: structural tags -----------------------------------
    if (extracted.tags.length === 0) {
        abstentions.push({
            tier: 2,
            reason: "no structural features detected",
        });
    }

    if (extracted.tags.length > 0) {
        const byModel = scoreCatalogByTags(extracted.tags, config);

        if (byModel.length > 0) {
            return {
                tier: 2,
                route: `tags:[${extracted.tags.join(",")}]`,
                candidates: byModel.map((s) => s.modelId),
                scores: byModel,
                abstentions,
            };
        }

        //  Catalog claimed nothing. Personas are the second place a
        //  tag can find a home.
        const byPersona = scorePersonasByTags(
            extracted.tags,
            config.personas,
        );

        if (byPersona.length > 0) {
            const best = byPersona[0];

            return {
                tier: 2,
                route: `persona:${best.name}`,
                candidates: [best.persona.default_model],
                scores: [],
                abstentions,
            };
        }

        abstentions.push({
            tier: 2,
            reason:
                `tags [${extracted.tags.join(",")}] matched no catalog ` +
                `capability and no persona tags — check that catalog ` +
                `entries have 'capabilities' set`,
        });
    }

    //  ---- TIER 3: semantic fallback (Milestone 5) -------------------
    if (!config.semantic) {
        abstentions.push({ tier: 3, reason: "semantic not configured" });
    }

    if (config.semantic) {
        abstentions.push({ tier: 3, reason: "semantic not yet implemented" });
    }

    //  ---- GLOBAL FALLBACK -------------------------------------------
    return {
        tier: "fallback",
        route: "global_default",
        candidates: [config.global_default_model],
        scores: [],
        abstentions,
    };
}

/**
 * Phase 2 — which concrete model fits this prompt's weight?
 */
export function selectModel(intent, estimatedTokens, config) {
    const skipped = [];

    for (const modelId of intent.candidates) {
        const model = config.catalog[modelId];

        if (!model) {
            skipped.push({ modelId, reason: "not in catalog" });
            continue;
        }

        if (model.max_context < estimatedTokens) {
            skipped.push({
                modelId,
                reason:
                    `context ${model.max_context} < needed ${estimatedTokens}`,
            });
            continue;
        }

        return { model: modelId, skipped };
    }

    //  Every candidate was too small. The global default is the last
    //  resort, and this is worth surfacing — it means the prompt is
    //  bigger than the whole candidate chain.
    return {
        model: config.global_default_model,
        skipped,
        exhausted: true,
    };
}

/**
 * The full pipeline. Returns everything the tracer, the explain
 * endpoint and the future decision log need — not just the answer,
 * but the reasoning.
 */
export function resolvePipeline(extracted, config) {
    const intent = resolveIntent(extracted, config);

    const selection = selectModel(
        intent,
        extracted.metrics.estimatedTokens,
        config,
    );

    return {
        tier: intent.tier,
        route: intent.route,
        model: selection.model,
        candidates: intent.candidates,
        scores: intent.scores,
        abstentions: intent.abstentions,
        skipped: selection.skipped,
        exhausted: Boolean(selection.exhausted),
        prompt: extracted.cleanPrompt,
    };
}
