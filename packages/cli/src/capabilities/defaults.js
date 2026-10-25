//  =====================================================================
//  Curated capability defaults
//  =====================================================================
//  Reliable per-model CAPABILITY metadata does not exist in any
//  scrapeable form — registry tags are vague and leaderboards rank
//  quality, not "can this handle multiple files". So capabilities are
//  curated here, the way a distro curates package metadata.
//
//  IMPORTANT FRAMING: a tag is a ROUTING PREFERENCE, not a capability
//  claim. qwen3-coder is perfectly capable of multi-file work, but it
//  does NOT claim TAG_MULTI_FILE, because devstral is the model we
//  want multi-file prompts to reach. If two models claim the same
//  tag, the tag stops differentiating and the tiebreak decides —
//  which defeats the point of having the tag at all.
//
//  Only tags the extractor emits are suggested. TAG_WRITER and
//  TAG_LONG_CONTEXT are reserved — nothing emits them yet — and
//  seeding them wrote routing rules into every generated config that
//  could never fire.

import { TAGS } from "@saxby/core";

const PATTERNS = [
    //  ---- Code specialists ------------------------------------------
    {
        match: "devstral",
        tags: [TAGS.CODER, TAGS.MULTI_FILE, TAGS.DEBUG],
        why: "built for exploring codebases and multi-file edits",
    },
    {
        //  Deliberately NOT TAG_MULTI_FILE — see framing note above.
        match: "qwen3-coder",
        tags: [TAGS.CODER, TAGS.DEBUG],
        why: "general code specialist with a long context window",
    },
    {
        match: "codellama",
        tags: [TAGS.CODER, TAGS.DEBUG],
        why: "code specialist",
    },
    {
        match: "codestral",
        tags: [TAGS.CODER, TAGS.DEBUG],
        why: "code specialist",
    },
    {
        match: "starcoder",
        tags: [TAGS.CODER],
        why: "code completion model",
    },
    {
        match: "coder",
        tags: [TAGS.CODER, TAGS.DEBUG],
        why: "name indicates a code specialist",
    },

    //  ---- Reasoning / math ------------------------------------------
    {
        match: "deepseek-r1",
        tags: [TAGS.REASONING, TAGS.MATH, TAGS.CODER],
        why: "reasoning-tuned",
    },
    {
        match: "qwq",
        tags: [TAGS.REASONING, TAGS.MATH],
        why: "reasoning-tuned",
    },
    {
        match: "mathstral",
        tags: [TAGS.MATH, TAGS.REASONING],
        why: "mathematics specialist",
    },

    //  ---- Data -------------------------------------------------------
    {
        match: "mistral-small",
        tags: [TAGS.DATA, TAGS.VISION],
        why: "large context window, good for bulk data tasks",
    },

    //  ---- Generalists -----------------------------------------------
    {
        match: "gemma",
        tags: [TAGS.REASONING, TAGS.VISION, TAGS.AUDIO],
        why: "general-purpose generalist",
    },
    {
        match: "llama",
        tags: [TAGS.REASONING],
        why: "general-purpose generalist",
    },
    {
        match: "mistral",
        tags: [TAGS.REASONING],
        why: "general-purpose generalist",
    },
    {
        match: "phi",
        tags: [TAGS.BACKGROUND],
        why: "small and fast — background utility tasks",
    },
];

//  Sorted once, longest pattern first, so 'qwen3-coder' beats 'coder'
//  and 'mistral-small' beats 'mistral'.
const SORTED = [...PATTERNS].sort((a, b) => b.match.length - a.match.length);

//  Model ids that are embedding models, not chat models. They must
//  never be tagged or catalogued, because a catalogued model is
//  selectable as a chat target and an embedder cannot serve a
//  completion.
const EMBEDDING_HINTS = ["embed", "bge-", "gte-", "e5-", "minilm"];

//  Parameter-count heuristic for background tasks: anything under
//  this is cheap enough to absorb title/tag/follow-up generation
//  without evicting a large model.
const BACKGROUND_PARAM_CEILING_B = 9;

/**
 * True when a model id looks like an embedding model.
 */
export function isEmbeddingModel(modelId) {
    const id = modelId.toLowerCase();

    for (const hint of EMBEDDING_HINTS) {
        if (id.includes(hint)) {
            return true;
        }
    }

    return false;
}

/**
 * Reads a parameter count out of a model id (e.g. "gemma4:31b" -> 31).
 */
function parseParamCount(modelId) {
    const match = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);

    if (!match) {
        return null;
    }

    return Number(match[1]);
}

/**
 * Suggests capability tags for a model id.
 *
 * @returns {{tags: string[], why: string|null}}
 */
export function suggestCapabilities(modelId) {
    if (isEmbeddingModel(modelId)) {
        return { tags: [], why: "embedding model — not a routing target" };
    }

    const id = modelId.toLowerCase();

    let tags = [];
    let why = null;

    for (const pattern of SORTED) {
        if (!id.includes(pattern.match)) {
            continue;
        }

        tags = [...pattern.tags];
        why = pattern.why;
        break;
    }

    //  Small models earn TAG_BACKGROUND regardless of family — size is
    //  the property that matters for utility work.
    const params = parseParamCount(id);

    if (params === null) {
        return { tags, why };
    }

    if (params > BACKGROUND_PARAM_CEILING_B) {
        return { tags, why };
    }

    if (!tags.includes(TAGS.BACKGROUND)) {
        tags.push(TAGS.BACKGROUND);
    }

    return { tags, why };
}
