/**
 * Phase 1: Intent Resolution (resolvePersona)
 * Determines the intended routing path (Overrides -> Tags -> Semantic).
 * Returns an ordered array of candidate model IDs.
 */
export async function resolveIntent(extracted, config) {
    // 1. TIER 1: Explicit Override
    if (extracted.override) {
        const persona = config.personas[extracted.override];
        return {
            tier: 1,
            route: `override:${extracted.override}`,
            candidates: [persona.default_model],
        };
    }

    // 2. TIER 2: Owned Extractor (Capability Tags)
    if (extracted.tags.length > 0) {
        const scoredModels = [];

        for (const [modelId, model] of Object.entries(config.catalog)) {
            if (!model.capabilities || model.capabilities.length === 0) {
                continue;
            }

            let overlap = 0;
            for (const tag of extracted.tags) {
                if (model.capabilities.includes(tag)) overlap++;
            }

            if (overlap > 0) {
                scoredModels.push({ modelId, score: overlap });
            }
        }

        if (scoredModels.length > 0) {
            // Sort by highest capability overlap
            scoredModels.sort((a, b) => b.score - a.score);
            return {
                tier: 2,
                route: `tags:[${extracted.tags.join(",")}]`,
                candidates: scoredModels.map((s) => s.modelId),
            };
        }
    }

    // 3. TIER 3: Semantic Fallback (Milestone 5)
    // If we reached here, the prompt had zero structural tags.
    if (config.semantic && config.semantic.active) {
        // TODO (Milestone 5):
        // 1. Fetch vector via config.semantic.active model.
        // 2. Cosine similarity against persona exemplars.
        // 3. Return matching persona's default_model.
        // For now, we safely abstain and fall through.
    }

    // 4. GLOBAL FALLBACK
    return {
        tier: "fallback",
        route: "global_default",
        candidates: [config.global_default_model],
    };
}

/**
 * Phase 2: Logistics & Hardware Selection (selectModel)
 * Evaluates candidate models against physical hardware constraints.
 */
export function selectModel(intent, estimatedTokens, config) {
    for (const modelId of intent.candidates) {
        const model = config.catalog[modelId];

        if (!model) continue;

        // Context Fit Check: Only route if the model has enough physical context
        if (model.max_context >= estimatedTokens) {
            return modelId;
        }
    }

    // If every candidate model's context window is too small for this prompt,
    // we have no choice but to route to the global default.
    return config.global_default_model;
}

/**
 * The Master Routing Gauntlet.
 * Connects the extracted AST evidence to the final model decision.
 */
export async function resolvePipeline(extracted, config) {
    const intent = await resolveIntent(extracted, config);
    const finalModel = selectModel(
        intent,
        extracted.metrics.estimatedTokens,
        config,
    );

    return {
        tier: intent.tier,
        route: intent.route,
        model: finalModel,
        prompt: extracted.cleanPrompt, // The prompt with /commands stripped
    };
}
