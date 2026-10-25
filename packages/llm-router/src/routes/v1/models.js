/**
 * Registers all /v1/models endpoints directly onto the Hono app.
 * @param {import("hono").Hono} app
 */
export function registerModelsRoutes(app) {
    app.get("/v1/models", (c) => {
        const config = c.get("config");

        // 1. The main smart router endpoint
        const models = [
            {
                id: "saxby",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "saxby",
            },
        ];

        // 2. The direct-access hardware models
        for (const modelId of Object.keys(config.catalog)) {
            models.push({
                id: `saxby/${modelId}`,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "saxby",
            });
        }

        return c.json({ object: "list", data: models });
    });

    app.get("/v1/models/:model{.*}", (c) => {
        const config = c.get("config");
        let modelId = c.req.param("model");

        // Strip the namespace prefix if they query a specific model
        if (modelId.startsWith("saxby/")) {
            modelId = modelId.replace("saxby/", "");
        }

        // If they query the router itself
        if (modelId === "saxby" || modelId === "saxby/") {
            return c.json({
                id: "saxby",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "saxby",
            });
        }

        const model = config.catalog[modelId];
        if (!model) {
            return c.json({
                error: { message: `Model '${modelId}' not found` },
            }, 404);
        }

        return c.json({
            id: `saxby/${modelId}`,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "saxby",
        });
    });
}
