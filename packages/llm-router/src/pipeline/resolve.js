//  =====================================================================
//  Routing gauntlet
//  =====================================================================
//  Two phases, deliberately separate:
//
//    resolveIntent(extracted, config)  -> ordered candidate models
//    selectModel(intent, tokens, …)    -> one concrete model id
//
//  Tiers 1 and 2 are synchronous and cost microseconds. Tier 3 makes
//  ONE network call, so it runs only when the cheap tiers abstain —
//  which is why resolveIntent stays sync and the semantic step sits
//  outside it. The fast path never awaits anything.
//
//  EVERY abstention records a reason, and Tier 3 records its score
//  EVEN WHEN IT LOSES. A rejected 0.58 is the single most useful
//  number for tuning the threshold later; throwing it away would
//  leave the threshold a permanent guess.

import { bestMatch, normalize } from "../semantic/vector.js";
import { embedOne } from "../semantic/embed.js";

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
 * changed when someone reordered their config file.
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

    return a.modelId.localeCompare(b.modelId);
}

/**
 * Scores catalog models by how many of the prompt's tags they claim.
 */
function scoreCatalogByTags(tags, config) {
    const personaDefaults = collectPersonaDefaults(config.personas);
    const scored = [];

    //  Requirements are filters, not scores. A model missing a
    //  required capability is removed from the candidate set.
    const required = [];

    if (tags.includes("TAG_VISION")) {
        required.push("TAG_VISION");
    }

    if (tags.includes("TAG_AUDIO")) {
        required.push("TAG_AUDIO");
    }

    for (const [modelId, model] of Object.entries(config.catalog)) {
        const capabilities = model.capabilities || [];

        if (capabilities.length === 0) {
            continue;
        }

        let meetsRequirements = true;

        for (const requirement of required) {
            if (capabilities.includes(requirement)) {
                continue;
            }

            meetsRequirements = false;
        }

        if (!meetsRequirements) {
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
 * Phase 1 — tiers 1 and 2 only. Synchronous by design.
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
            reason: `tags [${extracted.tags.join(",")}] matched no catalog ` +
                `capability and no persona tags — check that catalog ` +
                `entries have 'capabilities' set`,
        });
    }

    return {
        tier: "fallback",
        route: "global_default",
        candidates: [config.global_default_model],
        scores: [],
        abstentions,
    };
}

/**
 * Tier 3 — semantic similarity against cached persona exemplars.
 *
 * Never throws. A missing, slow or broken embedder must cost a
 * fallback, never a failed request: observability and cleverness are
 * both optional, routing is not.
 *
 * @returns {{matched, label, score, margin, runnerUp, exemplar,
 *            model, dim, error}}
 */
async function resolveSemantic(extracted, semantic) {
    const { profile, candidates, upstreamUrl } = semantic;

    const empty = {
        matched: false,
        label: null,
        score: null,
        margin: null,
        runnerUp: null,
        exemplar: null,
        model: profile.model,
        dim: profile.dim ?? null,
        error: null,
    };

    if (candidates.length === 0) {
        return { ...empty, error: "no exemplars cached" };
    }

    const prompt = extracted.cleanPrompt.trim();

    if (prompt.length === 0) {
        return { ...empty, error: "empty prompt" };
    }
    //  Injectable so Tier 3 can be unit-tested without a network
    //  call or a running embedder. main.js never sets it.
    const embed = semantic.embed || embedOne;

    let raw;

    try {
        raw = await embed(prompt, profile, upstreamUrl);
    } catch (err) {
        return { ...empty, error: err.message };
    }

    let match;

    try {
        match = bestMatch(normalize(raw), candidates);
    } catch (err) {
        //  Dimension mismatch: cached vectors came from a different
        //  model than the one now answering.
        return { ...empty, error: err.message };
    }

    return {
        matched: match.score >= profile.threshold,
        label: match.label,
        score: match.score,
        margin: match.margin,
        runnerUp: match.runnerUp,
        exemplar: match.exemplar,
        model: profile.model,
        dim: raw.length,
        error: null,
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

    return {
        model: config.global_default_model,
        skipped,
        exhausted: true,
    };
}

/**
 * The full pipeline.
 *
 * @param {Object} extracted
 * @param {Object} config
 * @param {Object|null} semantic - {profile, candidates, upstreamUrl},
 *   or null when Tier 3 is unconfigured or failed to warm.
 */
export async function resolvePipeline(extracted, config, semantic = null) {
    let intent = resolveIntent(extracted, config);
    let semanticResult = null;

    //  Tier 3 runs ONLY when the cheap tiers found nothing. A prompt
    //  Tier 2 could read does not need an embedding.
    const cheapTiersAbstained = intent.tier === "fallback";

    if (cheapTiersAbstained) {
        if (!semantic) {
            intent.abstentions.push({
                tier: 3,
                reason: "semantic not configured",
            });
        }

        if (semantic) {
            semanticResult = await resolveSemantic(extracted, semantic);

            if (semanticResult.error) {
                intent.abstentions.push({
                    tier: 3,
                    reason: `semantic unavailable: ${semanticResult.error}`,
                });
            }

            if (semanticResult.matched) {
                const persona = config.personas[semanticResult.label];

                //  A persona can be deleted while its vectors remain
                //  cached until the next warm-up prunes them.
                if (persona) {
                    intent = {
                        tier: 3,
                        route: `semantic:${semanticResult.label}`,
                        candidates: [persona.default_model],
                        scores: [],
                        abstentions: intent.abstentions,
                    };
                }

                if (!persona) {
                    intent.abstentions.push({
                        tier: 3,
                        reason: `matched persona '${semanticResult.label}' ` +
                            `no longer exists in config`,
                    });
                }
            }

            //  Below threshold. Recorded, not acted on — this is the
            //  number the threshold gets tuned against.
            if (!semanticResult.matched) {
                if (!semanticResult.error) {
                    intent.abstentions.push({
                        tier: 3,
                        reason: `best match '${semanticResult.label}' scored ` +
                            `${semanticResult.score.toFixed(3)}, below ` +
                            `threshold ${semantic.profile.threshold}`,
                    });
                }
            }
        }
    }

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
        semantic: semanticResult,
    };
}
