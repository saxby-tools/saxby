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
//  tie-break order, persona fallback, context fit.
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
//  claims TAG_MULTI_FILE.
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

Deno.test("abstentions — every declining tier is recorded", () => {
    const config = makeConfig();
    const intent = resolveIntent(makeExtracted([]), config);

    const tiers = intent.abstentions.map((a) => a.tier);

    assert(tiers.includes(1), "tier 1 abstention missing");
    assert(tiers.includes(2), "tier 2 abstention missing");
    assert(tiers.includes(3), "tier 3 abstention missing");
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

Deno.test("pipeline — carries reasoning alongside the answer", () => {
    const config = makeConfig();
    const extracted = makeExtracted(["TAG_CODER", "TAG_MULTI_FILE"]);

    const decision = resolvePipeline(extracted, config);

    assertEquals(decision.model, "specialist");
    assertEquals(decision.tier, 2);
    assert(Array.isArray(decision.abstentions));
    assert(Array.isArray(decision.scores));
    assertEquals(decision.exhausted, false);
});
