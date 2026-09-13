import { extractFeatures } from "./detect.js";

/**
 * Maps structural features to canonical routing tags.
 *
 * @param {Object} features - The structural evidence object from detect.js
 * @returns {string[]} An array of unique canonical tags
 */
function mapFeaturesToTags(features) {
    const tags = new Set();

    // 1. Code & Engineering signals
    if (
        features.fencedCode ||
        features.inlineCode ||
        features.diff ||
        features.stackTrace
    ) {
        tags.add("TAG_CODER");
    }

    if (features.stackTrace) {
        tags.add("TAG_DEBUG");
    }

    // 2. Multi-file context (The devstral vs qwen distinction)
    if (features.filePaths) {
        tags.add("TAG_CODER"); // Paths imply codebase context
        if (features.filePaths.count >= 2) {
            tags.add("TAG_MULTI_FILE");
        }
    }

    // 3. Data & Formatting
    if (features.json || features.tabular || features.table) {
        tags.add("TAG_DATA");
    }

    // 4. Mathematics & Logic
    if (features.math) {
        tags.add("TAG_MATH");
        tags.add("TAG_REASONING");
    }

    return Array.from(tags);
}

/**
 * Extracts intent and structural capabilities from a raw user prompt.
 *
 * @param {string} prompt - The raw user message.
 * @param {Object} config - The shuntd configuration object.
 * @returns {{ override: string | null, tags: string[], cleanPrompt: string, features: Object, metrics: Object, histogram: Object }}
 */
export function extractIntent(prompt, config) {
    let cleanPrompt = prompt.trim();
    let override = null;

    // --- TIER 1: Explicit Overrides ---
    // Look for slash commands (e.g., "/coder", "/writer")
    const words = cleanPrompt.split(/\s+/);
    const firstWord = words[0];

    if (firstWord?.startsWith("/")) {
        const requestedPersona = firstWord.slice(1).toLowerCase();

        // Ensure the requested persona actually exists in the config
        if (config.personas[requestedPersona]) {
            override = requestedPersona;
            // Strip the command so the LLM doesn't receive "/coder" in its context window
            cleanPrompt = words.slice(1).join(" ").trim();
        }
    }

    // --- TIER 2: Structural Extraction ---
    // We always parse features (even if overridden) so the SQLite decision log
    // has a complete record of what was asked vs. what was routed.
    const { features, metrics, histogram } = extractFeatures(cleanPrompt);

    // --- MAPPING LAYER ---
    const tags = mapFeaturesToTags(features);

    return {
        override,
        tags,
        cleanPrompt,
        features,
        metrics,
        histogram,
    };
}
