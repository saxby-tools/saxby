//  =====================================================================
//  POST /shuntd/v1/explain  —  non-destructive routing audit
//  =====================================================================
//  Takes the same body as /v1/chat/completions, runs the full
//  extract -> resolve pipeline, and returns the decision as JSON.
//
//  It NEVER contacts the upstream. No tokens are generated, no model
//  is loaded, no VRAM moves. That makes it safe to run as a test
//  suite over a table of prompts, and it is the only honest way to
//  assert routing behaviour — asserting on a model's prose output
//  would be testing the model, not the router.
//
//  It is also the reason routing tests do not need realistic paths:
//  shuntd never touches the filesystem. `src/main.js` is a
//  path-SHAPED token, matched by string structure alone. Nothing is
//  resolved, opened, or read.

import { extractIntent } from "../../../pipeline/extract.js";
import { resolvePipeline } from "../../../pipeline/resolve.js";

export function registerExplainRoutes(app) {
    app.post("/shuntd/v1/explain", async (c) => {
        const config = c.get("config");

        let body;

        try {
            body = await c.req.json();
        } catch {
            return c.json(
                { error: { message: "Body must be valid JSON." } },
                400,
            );
        }

        if (!Array.isArray(body.messages)) {
            return c.json(
                {
                    error: {
                        message: "Body must include a 'messages' array, same " +
                            "shape as /v1/chat/completions.",
                    },
                },
                400,
            );
        }

        const semantic = c.get("semantic");

        const extracted = extractIntent(body, config);
        const decision = await resolvePipeline(extracted, config, semantic);

        return c.json({
            requested_model: body.model || null,
            decision: {
                tier: decision.tier,
                route: decision.route,
                selected_model: decision.model,
                candidates: decision.candidates,
                scores: decision.scores,
                exhausted: decision.exhausted,
                //  Set only when tier is "refused": the message the
                //  client would get in a 400.
                refusal: decision.refusal,
            },
            intent: {
                override: extracted.override,
                tags: extracted.tags,
                clean_prompt: extracted.cleanPrompt,
            },
            evidence: {
                features: extracted.features,
                metrics: extracted.metrics,
                histogram: extracted.histogram,
                request_shape: extracted.shape,
            },
            //  Why each tier declined. This is the field that turns a
            //  surprising route into an explainable one.
            abstentions: decision.abstentions,
            semantic: decision.semantic,
            skipped: decision.skipped,
        });
    });
}
