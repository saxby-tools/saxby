//  =====================================================================
//  Routing gauntlet cases
//  =====================================================================
//  Pure unit tests against a FIXTURE catalog. No running daemon, no
//  user config, no network — so these are safe in CI and safe for a
//  contributor whose machine has none of the same models.
//
//  Assertions about real model ids ("multi-file goes to devstral")
//  belong in a personal smoke test, not here: they encode one user's
//  hardware. What belongs here is the ALGORITHM — overlap scoring,
//  tie-break order, persona fallback, capability requirements,
//  context fit, and the Tier 3 threshold.
//
//  Tier 3 is tested with an INJECTED embedder. resolvePipeline takes
//  the embed function off the semantic context, so a test supplies a
//  fake and never touches the network.
//
//  Run:  deno test packages/llm-router/src/pipeline/

import { assert, assertEquals } from "@std/assert";
import { resolveIntent, resolvePipeline, selectModel } from "./resolve.js";

//  ---------------------------------------------------------------------
//  Fixtures
//  ---------------------------------------------------------------------

const BIG_CONTEXT = 100000;

//  `specialist` and `generalist-coder` deliberately overlap on
//  TAG_CODER so tie-break behaviour is exercised. Only `specialist`
//  claims TAG_MULTI_FILE. Only `seeing-model` claims TAG_VISION.
function makeConfig(overrides = {}) {
    return {
        global_default_model: "fallback-model",
        upstream_url: "http://127.0.0.1:11434",
        catalog: {
            "fallback-model": {
                name: "fallback-model",
                max_context: BIG_CONTEXT,
                capabilities: ["TAG_WRITER"],
            },
            "generalist-coder": {
                name: "generalist-coder",
                max_context: BIG_CONTEXT,
                capabilities: ["TAG_CODER", "TAG_DEBUG"],
            },
            "specialist": {
                name: "specialist",
                max_context: BIG_CONTEXT,
                capabilities: ["TAG_CODER", "TAG_MULTI_FILE", "TAG_DEBUG"],
            },
            "seeing-model": {
                name: "seeing-model",
                max_context: BIG_CONTEXT,
                capabilities: ["TAG_WRITER", "TAG_VISION"],
            },
            "tiny-model": {
                name: "tiny-model",
                max_context: 100,
                capabilities: ["TAG_BACKGROUND"],
            },
        },
        personas: {
            coder: {
                default_model: "generalist-coder",
                tags: ["TAG_CODER"],
            },
            writer: {
                default_model: "fallback-model",
                tags: ["TAG_WRITER"],
            },
        },
        ...overrides,
    };
}

//  Minimal shape of what extractIntent returns.
function makeExtracted(tags, options = {}) {
    return {
        override: options.override || null,
        tags,
        cleanPrompt: options.prompt || "test prompt",
        promptIndex: 0,
        features: {},
        metrics: { estimatedTokens: options.tokens ?? 10 },
        histogram: {},
        shape: {},
    };
}

//  ---------------------------------------------------------------------
//  Semantic fixtures
//  ---------------------------------------------------------------------
//  Three orthogonal unit vectors, so a prompt vector's similarity to
//  each is just its own component. That makes every expected score
//  readable by eye instead of needing a calculator.

const CODER_VECTOR = Float32Array.from([1, 0, 0]);
const WRITER_VECTOR = Float32Array.from([0, 1, 0]);

function makeSemantic(promptVector, options = {}) {
    return {
        profile: {
            model: "fake-embedder",
            dim: 3,
            threshold: options.threshold ?? 0.6,
        },
        candidates: [
            { label: "coder", exemplar: "refactor", vector: CODER_VECTOR },
            { label: "writer", exemplar: "summarise", vector: WRITER_VECTOR },
        ],
        upstreamUrl: "http://127.0.0.1:11434",

        //  The injected embedder. Ignores the prompt and returns
        //  whatever vector the test wants to simulate.
        embed: () => {
            if (options.fail) {
                return Promise.reject(new Error(options.fail));
            }

            return Promise.resolve(promptVector);
        },
    };
}

//  ---------------------------------------------------------------------
//  Tier 1 — overrides
//  ---------------------------------------------------------------------

Deno.test("tier 1 — a slash override wins outright", () => {
    const config = makeConfig();
    const extracted = makeExtracted(["TAG_CODER"], { override: "coder" });

    const intent = resolveIntent(extracted, config);

    assertEquals(intent.tier, 1);
    assertEquals(intent.route, "override:coder");
    assertEquals(intent.candidates, ["generalist-coder"]);
});

Deno.test("tier 1 — override beats a stronger structural match", () => {
    const config = makeConfig();

    //  Tags point at `specialist`, but the user asked for `writer`.
    const extracted = makeExtracted(
        ["TAG_CODER", "TAG_MULTI_FILE"],
        { override: "writer" },
    );

    const intent = resolveIntent(extracted, config);

    assertEquals(intent.candidates, ["fallback-model"]);
});

//  ---------------------------------------------------------------------
//  Tier 2a — catalog capability scoring
//  ---------------------------------------------------------------------

Deno.test("tier 2a — higher overlap wins", () => {
    const config = makeConfig();
    const extracted = makeExtracted(["TAG_CODER", "TAG_MULTI_FILE"]);

    const intent = resolveIntent(extracted, config);

    assertEquals(intent.tier, 2);
    assertEquals(intent.candidates[0], "specialist");
});

Deno.test("tier 2a — ties break toward the persona default", () => {
    const config = makeConfig();

    //  Both coder models claim TAG_CODER and TAG_DEBUG: a 2-2 tie.
    //  `generalist-coder` is the coder persona's default_model.
    const extracted = makeExtracted(["TAG_CODER", "TAG_DEBUG"]);

    const intent = resolveIntent(extracted, config);

    assertEquals(intent.candidates[0], "generalist-coder");
});

//  The bug this guards: ties used to fall to Object.entries order, so
//  reordering the config file changed routing.
Deno.test("tier 2a — catalog key order does not change the winner", () => {
    const forward = makeConfig();

    const reversed = makeConfig({
        catalog: Object.fromEntries(
            Object.entries(forward.catalog).reverse(),
        ),
    });

    const extracted = makeExtracted(["TAG_CODER", "TAG_DEBUG"]);

    const a = resolveIntent(extracted, forward);
    const b = resolveIntent(extracted, reversed);

    assertEquals(a.candidates[0], b.candidates[0]);
});

Deno.test("tier 2a — a specialist tag is not diluted by a generalist", () => {
    const config = makeConfig();
    const extracted = makeExtracted(["TAG_MULTI_FILE"]);

    const intent = resolveIntent(extracted, config);

    //  Only one model claims it, so no tiebreak is involved.
    assertEquals(intent.candidates, ["specialist"]);
});

//  ---------------------------------------------------------------------
//  Capability requirements
//  ---------------------------------------------------------------------
//  TAG_VISION and TAG_AUDIO FILTER the candidate set rather than
//  scoring it. A model that cannot see is not a worse choice for an
//  image prompt, it is a broken one.

Deno.test("requirements — vision removes models that cannot see", () => {
    const config = makeConfig();
    const extracted = makeExtracted(["TAG_VISION"]);

    const intent = resolveIntent(extracted, config);

    assertEquals(intent.candidates, ["seeing-model"]);
});

//  The case the filter exists for: a high-scoring text model must NOT
//  win an image prompt just because it matched more tags.
Deno.test("requirements — a stronger text match cannot beat vision", () => {
    const config = makeConfig();

    //  `specialist` claims both coder tags and would score 2.
    //  `seeing-model` claims only TAG_VISION and scores 1.
    const extracted = makeExtracted([
        "TAG_VISION",
        "TAG_CODER",
        "TAG_MULTI_FILE",
    ]);

    const intent = resolveIntent(extracted, config);

    assertEquals(intent.candidates, ["seeing-model"]);
});

Deno.test("requirements — no capable model falls through loudly", () => {
    const config = makeConfig();
    const extracted = makeExtracted(["TAG_AUDIO"]);

    const intent = resolveIntent(extracted, config);

    //  Nothing claims TAG_AUDIO, so Tier 2 abstains entirely rather
    //  than routing an audio prompt to a deaf model.
    assertEquals(intent.tier, "fallback");
});

//  ---------------------------------------------------------------------
//  Tier 2b — persona tags as the safety net
//  ---------------------------------------------------------------------

Deno.test("tier 2b — persona tags catch an untagged catalog", () => {
    const config = makeConfig();

    //  Simulate the M3 bug: every catalog entry has empty capabilities.
    for (const model of Object.values(config.catalog)) {
        model.capabilities = [];
    }

    const extracted = makeExtracted(["TAG_CODER"]);
    const intent = resolveIntent(extracted, config);

    assertEquals(intent.tier, 2);
    assertEquals(intent.route, "persona:coder");
    assertEquals(intent.candidates, ["generalist-coder"]);
});

//  ---------------------------------------------------------------------
//  Fallback and abstentions
//  ---------------------------------------------------------------------

Deno.test("fallback — no tags means the global default", () => {
    const config = makeConfig();
    const intent = resolveIntent(makeExtracted([]), config);

    assertEquals(intent.tier, "fallback");
    assertEquals(intent.candidates, ["fallback-model"]);
});

Deno.test("fallback — an unclaimed tag names itself in the abstention", () => {
    const config = makeConfig();
    const intent = resolveIntent(makeExtracted(["TAG_MATH"]), config);

    assertEquals(intent.tier, "fallback");

    const tier2 = intent.abstentions.find((a) => a.tier === 2);

    assert(tier2, "tier 2 must record why it declined");
    assert(
        tier2.reason.includes("TAG_MATH"),
        "the abstention must name the tag that found no home",
    );
});

//  resolveIntent covers tiers 1 and 2 ONLY. Tier 3 makes a network
//  call, so it lives in resolvePipeline and is asserted there.
Deno.test("abstentions — the sync tiers each record a reason", () => {
    const config = makeConfig();
    const intent = resolveIntent(makeExtracted([]), config);

    const tiers = intent.abstentions.map((a) => a.tier);

    assert(tiers.includes(1), "tier 1 abstention missing");
    assert(tiers.includes(2), "tier 2 abstention missing");
});

//  ---------------------------------------------------------------------
//  Tier 3 — semantic fallback
//  ---------------------------------------------------------------------

Deno.test("tier 3 — a match above threshold routes to its persona", async () => {
    const config = makeConfig();

    //  Points straight at the coder exemplar: similarity 1.0.
    const semantic = makeSemantic(Float32Array.from([1, 0, 0]));

    const decision = await resolvePipeline(
        makeExtracted([]),
        config,
        semantic,
    );

    assertEquals(decision.tier, 3);
    assertEquals(decision.route, "semantic:coder");
    assertEquals(decision.model, "generalist-coder");
    assertEquals(decision.semantic.score, 1);
});

//  The score is recorded even when it LOSES. That rejected number is
//  what the threshold gets tuned against later — discarding it would
//  leave the threshold a permanent guess.
Deno.test("tier 3 — a near miss is recorded, not acted on", async () => {
    const config = makeConfig();

    //  Mostly coder, but below a 0.6 threshold.
    const semantic = makeSemantic(Float32Array.from([0.5, 0.866, 0]), {
        threshold: 0.9,
    });

    const decision = await resolvePipeline(
        makeExtracted([]),
        config,
        semantic,
    );

    assertEquals(decision.tier, "fallback");
    assertEquals(decision.model, "fallback-model");

    assert(decision.semantic, "the semantic result must still be recorded");
    assert(decision.semantic.score > 0, "the score must be kept");
    assertEquals(decision.semantic.matched, false);

    const tier3 = decision.abstentions.find((a) => a.tier === 3);

    assert(tier3, "tier 3 must record why it declined");
    assert(
        tier3.reason.includes("threshold"),
        "the abstention must name the threshold it failed",
    );
});

Deno.test("tier 3 — the runner-up and margin are recorded", async () => {
    const config = makeConfig();

    //  Leans coder but close to writer: a small margin.
    const semantic = makeSemantic(Float32Array.from([0.71, 0.70, 0]));

    const decision = await resolvePipeline(
        makeExtracted([]),
        config,
        semantic,
    );

    assertEquals(decision.semantic.label, "coder");
    assertEquals(decision.semantic.runnerUp, "writer");
    assert(
        decision.semantic.margin < 0.05,
        "a near-tie must report a small margin",
    );
});

//  A missing, slow or broken embedder costs semantic routing. It must
//  never cost the request.
Deno.test("tier 3 — an embedder failure degrades to fallback", async () => {
    const config = makeConfig();

    const semantic = makeSemantic(null, { fail: "connection refused" });

    const decision = await resolvePipeline(
        makeExtracted([]),
        config,
        semantic,
    );

    assertEquals(decision.tier, "fallback");
    assertEquals(decision.model, "fallback-model");

    const tier3 = decision.abstentions.find((a) => a.tier === 3);

    assert(tier3, "a failed embedder must still record an abstention");
    assert(
        tier3.reason.includes("connection refused"),
        "the abstention must carry the underlying error",
    );
});

Deno.test("tier 3 — unconfigured semantics abstain cleanly", async () => {
    const config = makeConfig();

    const decision = await resolvePipeline(makeExtracted([]), config, null);

    assertEquals(decision.tier, "fallback");
    assertEquals(decision.semantic, null);

    const tier3 = decision.abstentions.find((a) => a.tier === 3);

    assert(tier3, "tier 3 must say it was not configured");
});

//  Tier 3 is the expensive tier. It must not run when a cheap tier
//  already answered.
Deno.test("tier 3 — does not run when tier 2 matched", async () => {
    const config = makeConfig();

    let embedCalls = 0;

    const semantic = makeSemantic(Float32Array.from([1, 0, 0]));
    const realEmbed = semantic.embed;

    semantic.embed = (...args) => {
        embedCalls++;
        return realEmbed(...args);
    };

    const decision = await resolvePipeline(
        makeExtracted(["TAG_CODER"]),
        config,
        semantic,
    );

    assertEquals(decision.tier, 2);
    assertEquals(embedCalls, 0);
});

//  ---------------------------------------------------------------------
//  Phase 2 — context fit
//  ---------------------------------------------------------------------

Deno.test("selectModel — a too-small candidate is skipped with a reason", () => {
    const config = makeConfig();

    const intent = {
        candidates: ["tiny-model", "generalist-coder"],
    };

    const result = selectModel(intent, 5000, config);

    assertEquals(result.model, "generalist-coder");
    assertEquals(result.skipped.length, 1);
    assert(result.skipped[0].reason.includes("context"));
});

Deno.test("selectModel — exhausting every candidate is flagged", () => {
    const config = makeConfig();

    const intent = { candidates: ["tiny-model"] };
    const result = selectModel(intent, 5000, config);

    assertEquals(result.model, "fallback-model");
    assertEquals(result.exhausted, true);
});

Deno.test("selectModel — an uncatalogued candidate is skipped, not fatal", () => {
    const config = makeConfig();

    const intent = { candidates: ["ghost-model", "generalist-coder"] };
    const result = selectModel(intent, 10, config);

    assertEquals(result.model, "generalist-coder");
    assertEquals(result.skipped[0].reason, "not in catalog");
});

//  ---------------------------------------------------------------------
//  Full pipeline
//  ---------------------------------------------------------------------

Deno.test("pipeline — carries reasoning alongside the answer", async () => {
    const config = makeConfig();
    const extracted = makeExtracted(["TAG_CODER", "TAG_MULTI_FILE"]);

    const decision = await resolvePipeline(extracted, config);

    assertEquals(decision.model, "specialist");
    assertEquals(decision.tier, 2);
    assert(Array.isArray(decision.abstentions));
    assert(Array.isArray(decision.scores));
    assertEquals(decision.exhausted, false);
});
