import * as v from "valibot";

//  Memory broker defaults (docs/memory-broker.md says why each).
export const DEFAULT_MARGIN_GIB = 8;
export const DEFAULT_WAIT_TIMEOUT_S = 120;
export const DEFAULT_HEARTBEAT_INTERVAL_S = 10;

export const TagSchema = v.pipe(
    v.string(),
    v.regex(
        /^[A-Z0-9_]+$/,
        "Tags must be uppercase alphanumeric with underscores.",
    ),
);

//  A size in GiB, as people write it. Zero is refused: a model that
//  takes no memory would hide its real size from the budget.
const SizeGibSchema = v.pipe(
    v.number("size_gib must be a number"),
    v.check((gib) => gib > 0, "size_gib must be greater than 0"),
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
    //  The memory broker never lets a job take a pinned model's
    //  space, whether the model is loaded or not.
    pinned: v.optional(v.boolean(), false),
    //  Used only until the backend is seen holding the model loaded;
    //  a measured size always wins.
    size_gib: v.optional(SizeGibSchema),
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
    //  The active embedder is pinned without asking, since Tier 3
    //  loads it for routed requests, and embedders never sit in the
    //  catalog where `pinned` lives.
    size_gib: v.optional(SizeGibSchema),
});

export const SemanticSchema = v.strictObject({
    active: v.string("Active semantic profile is required"),
    profiles: v.record(v.string(), SemanticProfileSchema),
});

export const MemorySchema = v.strictObject({
    //  Kept free beyond every model and reservation.
    margin_gib: v.optional(
        v.pipe(
            v.number("margin_gib must be a number"),
            v.minValue(0, "margin_gib must be >= 0"),
        ),
        DEFAULT_MARGIN_GIB,
    ),
    //  How long a job or a model load waits for room before it is
    //  refused. `saxby reserve --timeout` overrides it for one job.
    wait_timeout_s: v.optional(
        v.pipe(
            v.number("wait_timeout_s must be a number"),
            v.minValue(0, "wait_timeout_s must be >= 0"),
        ),
        DEFAULT_WAIT_TIMEOUT_S,
    ),
    //  How often `saxby reserve` checks in, and how often saxbyd looks
    //  for reservations whose processes have died.
    heartbeat_interval_s: v.optional(
        v.pipe(
            v.number("heartbeat_interval_s must be a number"),
            v.minValue(1, "heartbeat_interval_s must be >= 1"),
        ),
        DEFAULT_HEARTBEAT_INTERVAL_S,
    ),
    //  Used only when the memory probe cannot measure the ceiling.
    ceiling_gib: v.optional(SizeGibSchema),
});

export const SaxbyConfigSchema = v.strictObject({
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
    memory: v.optional(MemorySchema, {}),
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
            `global_default_model '${config.global_default_model}' ` +
                `is not in the catalog`,
        );
    }

    // 2. Check each persona's default_model
    for (const [personaName, persona] of Object.entries(config.personas)) {
        if (!catalogKeys.has(persona.default_model)) {
            throw new Error(
                `personas.${personaName}.default_model ` +
                    `'${persona.default_model}' is not in the catalog`,
            );
        }
    }

    // 3. Check semantic active profile
    if (config.semantic && config.semantic.active) {
        if (!config.semantic.profiles[config.semantic.active]) {
            throw new Error(
                `semantic.active '${config.semantic.active}' is not ` +
                    `one of semantic.profiles`,
            );
        }
    }
}

/**
 * One readable line per valibot issue. The raw issue objects name an
 * unknown field "Expected never but received 1" and bury the field
 * name in a nested path dump.
 */
function describeIssue(issue) {
    const path = (issue.path || []).map((item) => item.key).join(".");

    if (issue.type === "strict_object") {
        return `unknown field '${path}' — check the spelling`;
    }

    if (!path) {
        return issue.message;
    }

    return `${path}: ${issue.message}`;
}

/**
 * Validates a raw config object against schema and integrity rules.
 * Prints nothing; throws one Error listing every problem, one per
 * line, for the loader to attach the file path to.
 */
export function validateConfig(rawConfig) {
    const result = v.safeParse(SaxbyConfigSchema, rawConfig);

    if (!result.success) {
        const lines = result.issues.map((issue) => `- ${describeIssue(issue)}`);

        throw new Error(lines.join("\n"));
    }

    try {
        validateReferentialIntegrity(result.output);
    } catch (err) {
        throw new Error(`- ${err.message}`);
    }

    return result.output;
}
