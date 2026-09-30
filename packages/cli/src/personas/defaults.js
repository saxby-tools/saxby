//  =====================================================================
//  Curated persona defaults
//  =====================================================================
//  What a fresh `shunt config generate` scaffolds. These exemplars
//  were validated against bge-m3 with a live router, not guessed.
//
//  THREE RULES, each learned by watching a probe get it wrong:
//
//    1. Personas differ by VOCABULARY, not by adjective.
//       "what's the cleanest way to structure this" (coder) stole
//       "what's the best way to word this" from writer — eleven-token
//       sentences sharing nine tokens of scaffolding. For short
//       prompts, sentence SHAPE outweighs subject matter, so each
//       persona needs nouns the others never use: headline, tone,
//       proofread for writer; unit test, error handling, off-by-one
//       for coder.
//
//    2. Cover BOTH requests and symptoms.
//       "refactor this" is a request; "the loop runs one too many
//       times" is an observation with no verb at all. They occupy
//       different regions, and a persona covering only requests loses
//       every symptom prompt to whichever persona has casual
//       declarative sentences.
//
//    3. A negative class beats a threshold.
//       bge-m3 is a retrieval model: it ranks well and calibrates
//       poorly, so absolute cosine scores are not comparable across
//       prompts. Before `general` existed, "remind me to buy milk"
//       scored 0.602 against writer while a real coder question
//       scored 0.481 — no single cutoff separates those. Giving
//       off-topic prompts somewhere to LAND turns the question from
//       "is this above the line" into "which of these is nearest",
//       which is the question embeddings actually answer.
//
//  Tuning loop when a prompt misroutes: add an exemplar matching that
//  specific phrasing. Do NOT add a general one, and do NOT lower the
//  threshold — a missing exemplar looks exactly like a threshold set
//  too high, and lowering it lets junk through instead.

import { TAGS } from "@shuntd/core";

export const PERSONA_DEFAULTS = {
    coder: {
        description: "Programming, debugging and software architecture.",

        tags: [TAGS.CODER, TAGS.MULTI_FILE, TAGS.DEBUG],

        exemplars: [
            //  Requests
            "Refactor this function",
            "Write a unit test",
            "add error handling to this",
            "is there a better pattern for this",
            "walk me through what this does",
            "how can I make this DRY",

            //  Symptoms — no request verb, and the half most often
            //  lost to other personas without these.
            "why is this returning undefined",
            "fix the off by one",
            "this is throwing but I can't tell where",
            "it fails in CI but passes locally",
            "this gets slow with large inputs",
            "it crashes on the second run",
        ],
    },

    writer: {
        description: "Prose, editing and tone.",

        tags: [TAGS.WRITER],

        exemplars: [
            //  Requests
            "Summarize this article",
            "Draft an email",
            "rewrite this for a general audience",
            "give me a few options for the headline",
            "proofread this paragraph",
            "give me a shorter version",

            //  Judgements about prose
            "make this sound less stiff",
            "this reads like a robot wrote it",
            "is this too formal",
            "what tone should I use here",
            "how should I phrase this",
        ],
    },

    //  The negative class. Deliberately claims NO tags, so it is
    //  unreachable from Tier 2 and can only win semantically — a
    //  classifier target, not a structural routing destination.
    general: {
        description: "Everything that is neither code nor prose work.",

        tags: [],

        exemplars: [
            "what time does the store close",
            "remind me to buy milk",
            "who won the game last night",
            "what's the weather like",
            "how tall is the eiffel tower",
            "tell me a joke",
            "what's a good recipe for dinner",
            "how do I get to the airport",
            "what year did that movie come out",
            "help me plan a weekend trip",
        ],
    },
};

//  Starting thresholds, per embedding model. NOT comparable across
//  models: a cosine of 0.60 means different semantic distances under
//  different embedders, because each occupies a differently shaped
//  region of the space.
//
//  0.60 for bge-m3 is validated against a live probe. The nomic value
//  is an untested scale-down and should be treated as a guess.
export const SEMANTIC_DEFAULTS = {
    "bge-m3": { dim: 1024, threshold: 0.6 },
    "nomic-embed-text": { dim: 768, threshold: 0.55 },
};

/**
 * Looks up starting values for an embedding model id.
 *
 * NOTE for a future nomic implementation: nomic-embed-text expects
 * task prefixes ("search_query:" / "search_document:") on its inputs,
 * and similarity behaves differently without them. Switching profiles
 * would need a prefix field in the profile and handling in embed.js.
 */
export function suggestSemanticDefaults(modelId) {
    const id = modelId.toLowerCase();

    for (const [pattern, values] of Object.entries(SEMANTIC_DEFAULTS)) {
        if (!id.includes(pattern)) {
            continue;
        }

        return values;
    }

    return { dim: null, threshold: 0.6 };
}
