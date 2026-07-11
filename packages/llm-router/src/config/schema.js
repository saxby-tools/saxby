import * as v from "valibot";

// 1. Capability Tags (e.g., ["TAG_CODER", "TAG_MULTI_FILE"])
// We enforce uppercase strings to prevent weird matching bugs later.
export const TagSchema = v.pipe(
    v.string(),
    v.regex(
        /^[A-Z0-9_]+$/,
        "Tags must be uppercase alphanumeric with underscores.",
    ),
);

// 2. The Model Catalog Entry
// Represents physical models on the hardware (or cloud)
export const ModelSchema = v.object({
    name: v.string("Model name is required (e.g., devstral-small-2)"),
    description: v.optional(v.string()),
    max_context: v.pipe(
        v.number(),
        v.minValue(1, "max_context must be greater than 0"),
    ),
    capabilities: v.optional(v.array(TagSchema), []),
});

// 3. The Persona Entry
// Represents the intent class (e.g., "coder", "writer")
export const PersonaSchema = v.object({
    description: v.optional(v.string()),
    // Exemplars for Tier 3 Semantic Routing (e.g., "Refactor this file")
    exemplars: v.optional(v.array(v.string()), []),
    // The ultimate fallback model if no capabilities match
    default_model: v.string(
        "Every persona must have a default fallback model ID",
    ),
});

// 4. The Root Config Document
export const ShuntdConfigSchema = v.object({
    // Upstream OpenAI-compatible endpoint
    upstream_url: v.optional(v.string(), "http://127.0.0.1:11434"),

    // Fallback model if the router completely fails
    global_default_model: v.string(),

    // Dictionaries keyed by ID for deep merging
    personas: v.record(v.string(), PersonaSchema),
    catalog: v.record(v.string(), ModelSchema),
});

/**
 * Validates a raw config object against the schema.
 * Throws a clean error if validation fails.
 */
export function validateConfig(rawConfig) {
    try {
        return v.parse(ShuntdConfigSchema, rawConfig);
    } catch (err) {
        // We will want to format Valibot errors nicely for the CLI later,
        // but for now, fail loud so we don't swallow config typos.
        console.error("❌ Config Validation Failed:");
        console.error(err.issues);
        throw new Error("Invalid shuntd configuration.");
    }
}
