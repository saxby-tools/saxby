import {
    classifyModel,
    SAXBY_MODEL,
    SAXBY_PREFIX,
} from "../../pipeline/model-name.js";

/**
 * Builds one OpenAI-style model entry.
 */
function modelEntry(id) {
    return {
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: SAXBY_MODEL,
    };
}

/**
 * Registers all /v1/models endpoints directly onto the Hono app.
 * @param {import("hono").Hono} app
 */
export function registerModelsRoutes(app) {
    app.get("/v1/models", (c) => {
        const config = c.get("config");

        // 1. The main smart router endpoint
        const models = [modelEntry(SAXBY_MODEL)];

        // 2. The direct-access hardware models
        for (const modelId of Object.keys(config.catalog)) {
            models.push(modelEntry(`${SAXBY_PREFIX}${modelId}`));
        }

        return c.json({ object: "list", data: models });
    });

    //  Reads the name the way the chat route does: `saxby` is the
    //  router, `saxby/<model>` and a bare name both look up <model>.
    app.get("/v1/models/:model{.*}", (c) => {
        const config = c.get("config");
        const requested = classifyModel(c.req.param("model"));

        if (requested.mode === "route") {
            return c.json(modelEntry(SAXBY_MODEL));
        }

        const modelId = requested.target;

        if (!config.catalog[modelId]) {
            return c.json({
                error: { message: `Model '${modelId}' not found` },
            }, 404);
        }

        return c.json(modelEntry(`${SAXBY_PREFIX}${modelId}`));
    });
}
