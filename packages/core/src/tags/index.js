//  =====================================================================
//  Canonical tag vocabulary
//  =====================================================================
//  Lives in core because BOTH sides of the contract need it:
//    - llm-router EMITS tags from the extractor
//    - cli CLAIMS tags when seeding catalog capabilities
//
//  Without a shared source of truth the two drift silently: the
//  extractor emits TAG_CODER, nothing claims TAG_CODER, Tier 2 scores
//  zero models, and every request falls through to the global default
//  with no error at all. That is the failure that shipped in M3.

export const TAGS = {
    CODER: "TAG_CODER",
    MULTI_FILE: "TAG_MULTI_FILE",
    DEBUG: "TAG_DEBUG",
    DATA: "TAG_DATA",
    MATH: "TAG_MATH",
    REASONING: "TAG_REASONING",
    WRITER: "TAG_WRITER",
    LONG_CONTEXT: "TAG_LONG_CONTEXT",
    BACKGROUND: "TAG_BACKGROUND",
    //  REQUIREMENTS, not preferences. These filter the candidate set
    //  in resolve.js rather than contributing to a score — a model
    //  that cannot see is not a worse choice for an image, it is a
    //  broken one.
    //
    //  Split deliberately: gemma4 does vision AND audio,
    //  mistral-small3.2 does vision only. One combined tag would
    //  route an audio prompt to a model that cannot hear.
    VISION: "TAG_VISION",
    AUDIO: "TAG_AUDIO",
};

//  Every tag the extractor actually emits — listed by hand, not
//  derived from TAGS. TAG_WRITER and TAG_LONG_CONTEXT are in the
//  vocabulary but nothing emits them yet, and deriving this set from
//  TAGS let configs claim them with no warning: a routing rule that
//  looked real and never fired. Add a tag here in the same change
//  that makes extract.js emit it.
export const EMITTABLE_TAGS = new Set([
    TAGS.CODER,
    TAGS.MULTI_FILE,
    TAGS.DEBUG,
    TAGS.DATA,
    TAGS.MATH,
    TAGS.REASONING,
    TAGS.BACKGROUND,
    TAGS.VISION,
    TAGS.AUDIO,
]);

//  In the vocabulary, not yet emitted. Claiming one is not a typo, so
//  it gets its own warning.
const KNOWN_TAGS = new Set(Object.values(TAGS));

//  Default tag sets for the personas the generator scaffolds.
export const PERSONA_TAG_DEFAULTS = {
    coder: [TAGS.CODER, TAGS.MULTI_FILE, TAGS.DEBUG],
    //  Empty until something emits TAG_WRITER: writer is reached
    //  through Tier 3 exemplars.
    writer: [],
    reasoner: [TAGS.REASONING, TAGS.MATH],
    data: [TAGS.DATA],
    utility: [TAGS.BACKGROUND],
    //  Negative class for Tier 3 — no tags on purpose, so it is
    //  unreachable structurally and can only win semantically.
    general: [],
};

/**
 * Collects every tag claimed anywhere in the config.
 */
function collectClaimedTags(config) {
    const claimed = new Set();

    for (const model of Object.values(config.catalog)) {
        for (const tag of model.capabilities || []) {
            claimed.add(tag);
        }
    }

    for (const persona of Object.values(config.personas)) {
        for (const tag of persona.tags || []) {
            claimed.add(tag);
        }
    }

    return claimed;
}

/**
 * Validates the tag contract in both directions.
 *
 * Returns warnings rather than throwing: an unclaimed tag is a
 * degraded router, not a broken one. It must be LOUD, because the
 * symptom (everything falls back) looks like working software.
 *
 * @returns {string[]} human-readable warnings
 */
export function validateTagContract(config) {
    const warnings = [];
    const claimed = collectClaimedTags(config);

    //  Direction 1: a claimed tag the extractor never emits will never
    //  match anything — reserved, or a typo.
    for (const tag of claimed) {
        if (EMITTABLE_TAGS.has(tag)) {
            continue;
        }

        if (KNOWN_TAGS.has(tag)) {
            warnings.push(
                `Tag '${tag}' is reserved: nothing emits it yet, so ` +
                    `claiming it never matches. Remove the claim.`,
            );
            continue;
        }

        warnings.push(
            `Tag '${tag}' is claimed in config but the extractor never ` +
                `emits it. Check for a typo — it will never match.`,
        );
    }

    //  Direction 2: nothing claims ANY tag that can match. Tier 2 is
    //  dead weight and every structural match silently falls through.
    //  Reserved claims do not count: they can never match either.
    const live = [...claimed].filter((tag) => EMITTABLE_TAGS.has(tag));

    if (live.length === 0) {
        warnings.push(
            "No model or persona claims any capability tag. Tier 2 " +
                "routing is disabled — every request will fall through " +
                "to global_default_model. Run 'saxby config generate' " +
                "or add 'capabilities' to catalog entries.",
        );

        return warnings;
    }

    //  Direction 3: specific high-value tags with no home.
    const importantTags = [TAGS.CODER, TAGS.BACKGROUND];

    for (const tag of importantTags) {
        if (claimed.has(tag)) {
            continue;
        }

        warnings.push(
            `Nothing claims ${tag}. Prompts matching it will fall ` +
                `through to global_default_model.`,
        );
    }

    return warnings;
}
