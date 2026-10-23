import * as v from "valibot";

export const TagSchema = v.pipe(
    v.string(),
    v.regex(
        /^[A-Z0-9_]+$/,
        "Tags must be uppercase alphanumeric with underscores.",
    ),
);

export const ModelSchema = v.strictObject({
    name: v.string("Model name is required"),
    description: v.optional(v.string()),
    max_context: v.pipe(
        v.number(),
        v.minValue(1, "max_context must be greater than 0"),
    ),
    capabilities: v.optional(v.array(TagSchema), []),
    //  Injected as a system message for this model only. Fixes
    //  model-specific behaviour at the cause (decoding) rather than
    //  rewriting the response after the fact.
    system_prefix: v.optional(v.string()),
});

export const PersonaSchema = v.strictObject({
    description: v.optional(v.string()),
    exemplars: v.optional(v.array(v.string()), []),
    //  Tier 2b: personas claim tags too, so a partially tagged
    //  catalog still routes instead of collapsing to the global
    //  default. Catalog capabilities win when both match.
    tags: v.optional(v.array(TagSchema), []),
    default_model: v.string(
        "Every persona must have a default fallback model ID",
    ),
});

export const SemanticProfileSchema = v.strictObject({
    model: v.string("Semantic model name is required"),
    dim: v.pipe(
        v.number("Dimension must be a number"),
        v.minValue(1, "Dimension must be at least 1"),
    ),
    threshold: v.pipe(
        v.number("Threshold must be a number"),
        v.minValue(0, "Threshold must be >= 0.0"),
        v.maxValue(1, "Threshold must be <= 1.0"),
    ),
});

export const SemanticSchema = v.strictObject({
    active: v.string("Active semantic profile is required"),
    profiles: v.record(v.string(), SemanticProfileSchema),
});

export const ShuntdConfigSchema = v.strictObject({
    listen_port: v.optional(
        v.pipe(
            v.number(),
            v.minValue(1024, "Port must be > 1023"),
            v.maxValue(65535, "Port must be < 65536"),
        ),
        11435,
    ),
    upstream_url: v.optional(v.string(), "http://127.0.0.1:11434"),
    //  When true, a request that sets `stream: false` is tagged
    //  TAG_BACKGROUND, plus any TAG_VISION / TAG_AUDIO requirement,
    //  and skips the structural scan (looksLikeBackgroundTask in
    //  extract.js). Utility generators — titles, tags, follow-ups —
    //  are the non-streaming callers.
    route_background_tasks: v.optional(v.boolean(), true),
    global_default_model: v.string("global_default_model is required"),
    semantic: v.optional(SemanticSchema),
    personas: v.record(v.string(), PersonaSchema),
    catalog: v.record(v.string(), ModelSchema),
    log_prompts: v.optional(v.boolean(), true),
    client_names: v.optional(v.record(v.string(), v.string()), {}),
    log_path: v.optional(v.string()),
});

/**
 * Asserts referential integrity across the config object.
 * Ensures all referenced models actually exist in the catalog.
 */
function validateReferentialIntegrity(config) {
    const catalogKeys = new Set(Object.keys(config.catalog));

    // 1. Check global_default_model
    if (!catalogKeys.has(config.global_default_model)) {
        throw new Error(
            `Referential Integrity Error: global_default_model '${config.global_default_model}' is not defined in catalog.`,
        );
    }

    // 2. Check each persona's default_model
    for (const [personaName, persona] of Object.entries(config.personas)) {
        if (!catalogKeys.has(persona.default_model)) {
            throw new Error(
                `Referential Integrity Error: Persona '${personaName}' references default_model '${persona.default_model}', which is not in catalog.`,
            );
        }
    }

    // 3. Check semantic active profile
    if (config.semantic && config.semantic.active) {
        if (!config.semantic.profiles[config.semantic.active]) {
            throw new Error(
                `Referential Integrity Error: Semantic active profile '${config.semantic.active}' is not defined in semantic.profiles.`,
            );
        }
    }
}

/**
 * Validates a raw config object against schema and integrity rules.
 */
export function validateConfig(rawConfig) {
    try {
        const parsed = v.parse(ShuntdConfigSchema, rawConfig);
        validateReferentialIntegrity(parsed);
        return parsed;
    } catch (err) {
        console.error("❌ Config Validation Failed:");
        if (err.issues) {
            console.error(err.issues);
        } else {
            console.error(`- ${err.message}`);
        }
        throw new Error("Invalid shuntd configuration.");
    }
}
