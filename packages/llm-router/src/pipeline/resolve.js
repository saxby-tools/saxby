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

//  Requirements are filters, not scores: a model that cannot see is
//  not a worse choice for an image, it is a broken one.
const REQUIREMENT_TAGS = ["TAG_VISION", "TAG_AUDIO"];

//  What a requirement is about, for the refusal a client reads.
const REQUIREMENT_NOUNS = {
    TAG_VISION: "images",
    TAG_AUDIO: "audio",
};

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
 * The requirement tags present in a prompt's tags.
 */
function requiredTags(tags) {
    return REQUIREMENT_TAGS.filter((tag) => tags.includes(tag));
}

/**
 * True when a capability list covers every required tag.
 */
function meetsRequirements(capabilities, required) {
    for (const requirement of required) {
        if (!capabilities.includes(requirement)) {
            return false;
        }
    }

    return true;
}

/**
 * Scores catalog models by how many of the prompt's tags they claim.
 * A model missing a required capability is removed, not scored down.
 */
function scoreCatalogByTags(tags, config) {
    const personaDefaults = collectPersonaDefaults(config.personas);
    const required = requiredTags(tags);
    const scored = [];

    for (const [modelId, model] of Object.entries(config.catalog)) {
        const capabilities = model.capabilities || [];

        if (capabilities.length === 0) {
            continue;
        }

        if (!meetsRequirements(capabilities, required)) {
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
 *
 * Requirements hold here too: a persona whose default_model lacks a
 * required capability is skipped. Before this, an audio prompt that
 * also carried TAG_CODER reached the coder persona's deaf model.
 */
function scorePersonasByTags(tags, config) {
    const required = requiredTags(tags);
    const scored = [];

    for (const [name, persona] of Object.entries(config.personas)) {
        const owned = persona.tags || [];

        if (owned.length === 0) {
            continue;
        }

        const model = config.catalog[persona.default_model];
        const capabilities = model?.capabilities || [];

        if (!meetsRequirements(capabilities, required)) {
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
 * Why Tier 2 found nothing. A missing requirement is named outright:
 * "nothing can see this image" is a different problem from "the
 * catalog has no capabilities set".
 */
function describeTier2Miss(tags) {
    const required = requiredTags(tags);

    if (required.length > 0) {
        return {
            tier: 2,
            reason: `no catalog model claims required ` +
                `[${required.join(",")}] — nothing here can serve it`,
        };
    }

    return {
        tier: 2,
        reason: `tags [${tags.join(",")}] matched no catalog ` +
            `capability and no persona tags — check that catalog ` +
            `entries have 'capabilities' set`,
    };
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

        const byPersona = scorePersonasByTags(extracted.tags, config);

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

        abstentions.push(describeTier2Miss(extracted.tags));
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
/**
 * True when a model can take the request at all: it fits the payload
 * and meets every requirement.
 */
function canServe(model, estimatedTokens, required) {
    if (model.max_context < estimatedTokens) {
        return false;
    }

    return meetsRequirements(model.capabilities || [], required);
}

/**
 * The model to use once every candidate was skipped, or null.
 *
 * The global default if it can serve the request; otherwise the
 * capable model with the largest context window, for the most
 * headroom. Before this, exhaustion returned the global default
 * unconditionally — even when it had just been skipped as too small,
 * or could not see the image the request carried.
 */
function lastResort(estimatedTokens, required, config) {
    const preferred = config.catalog[config.global_default_model];

    if (preferred && canServe(preferred, estimatedTokens, required)) {
        return config.global_default_model;
    }

    const usable = Object.entries(config.catalog)
        .filter(([, model]) => canServe(model, estimatedTokens, required))
        .sort(([aId, a], [bId, b]) =>
            b.max_context - a.max_context || aId.localeCompare(bId)
        );

    if (usable.length === 0) {
        return null;
    }

    return usable[0][0];
}

function describeNoFit(estimatedTokens, required, config) {
    const largest = Math.max(
        ...Object.values(config.catalog).map((model) => model.max_context),
    );

    const needs = required.length > 0
        ? ` and claims ${required.join(" and ")}`
        : "";

    return `No model in this Saxby catalog fits a request of about ` +
        `${estimatedTokens} tokens${needs}. The largest context ` +
        `window in the catalog is ${largest}.`;
}

/**
 * Picks the first candidate that fits, falling back to a last resort
 * that can still serve the request, or refusing when none can.
 * @param {string[]} required - Requirement tags the model must meet.
 */
export function selectModel(intent, estimatedTokens, config, required = []) {
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

    const fallback = lastResort(estimatedTokens, required, config);

    if (fallback) {
        return { model: fallback, skipped, exhausted: true };
    }

    return {
        model: null,
        skipped,
        exhausted: true,
        refusal: describeNoFit(estimatedTokens, required, config),
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
/**
 * Required tags that no catalog model claims. When this is not empty,
 * nothing in the catalog can serve the request.
 */
function unmetRequirements(tags, config) {
    const models = Object.values(config.catalog);

    return requiredTags(tags).filter((tag) =>
        !models.some((model) => (model.capabilities || []).includes(tag))
    );
}

function describeRefusal(unmet) {
    const nouns = unmet.map((tag) => REQUIREMENT_NOUNS[tag]).join(" or ");
    const tags = unmet.join(" or ");

    return `No model in this Saxby catalog claims ${tags}, so nothing ` +
        `here can handle ${nouns}. Add ${unmet.join(" and ")} to the ` +
        `capabilities of a model that can.`;
}

/**
 * The decision when nothing can serve a requirement. Tier 3 and the
 * global default are skipped: any model chosen from here would be a
 * broken one, and a silent fallback hides the config gap that caused
 * it.
 */
/**
 * A refused decision. `skipped` lists the candidates that were tried
 * and rejected; a refusal before any were tried lists none, so the
 * decision never names a model that was not considered.
 */
function refuse(intent, extracted, route, refusal, skipped = []) {
    return {
        tier: "refused",
        route,
        model: null,
        candidates: skipped.map((entry) => entry.modelId),
        scores: [],
        abstentions: intent.abstentions,
        skipped,
        exhausted: skipped.length > 0,
        prompt: extracted.cleanPrompt,
        semantic: null,
        refusal,
    };
}

export async function resolvePipeline(extracted, config, semantic = null) {
    let intent = resolveIntent(extracted, config);
    let semanticResult = null;

    //  Only when the cheap tiers found nothing: an explicit Tier 1
    //  choice is the user's and stands.
    if (intent.tier === "fallback") {
        const unmet = unmetRequirements(extracted.tags, config);

        if (unmet.length > 0) {
            intent.abstentions.push({
                tier: 3,
                reason: "skipped — no catalog model can serve a " +
                    "required capability",
            });

            return refuse(
                intent,
                extracted,
                `unmet:[${unmet.join(",")}]`,
                describeRefusal(unmet),
            );
        }
    }

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
        requiredTags(extracted.tags),
    );

    if (selection.refusal) {
        return refuse(
            intent,
            extracted,
            "unmet:context",
            selection.refusal,
            selection.skipped,
        );
    }

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
        refusal: null,
    };
}
