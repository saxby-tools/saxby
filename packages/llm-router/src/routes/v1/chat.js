/**
 * Registers all /v1/chat endpoints directly onto the Hono app.
 * @param {import("hono").Hono} app
 */
export function registerChatRoutes(app) {
    app.post("/v1/chat/completions", async (c) => {
        const config = c.get("config");
        const body = await c.req.json();
        const rawModel = body.model || "";

        let targetModel = rawModel; // Default to passing through exactly what they asked for

        // 1. If they request the smart router, fallback to default (until Milestone 3)
        if (rawModel === "shuntd") {
            targetModel = config.global_default_model;
        } // 2. If they explicitly bypassed the router (e.g., shuntd/gemma4)
        else if (rawModel.startsWith("shuntd/")) {
            targetModel = rawModel.replace("shuntd/", "");
        }

        // Apply the resolved model
        body.model = targetModel;

        if (rawModel !== targetModel) {
            console.log(`\n➡️ Proxying request to: ${targetModel}`);
            console.log(`   (Routed '${rawModel}' -> '${targetModel}')`);
        } else {
            console.log(`\n➡️ Proxying raw request to: ${targetModel}`);
        }

        const upstreamReq = new Request(
            `${config.upstream_url}/v1/chat/completions`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(c.req.header("Authorization") && {
                        Authorization: c.req.header("Authorization"),
                    }),
                },
                body: JSON.stringify(body),
            },
        );

        const upstreamRes = await fetch(upstreamReq);

        const headers = new Headers(upstreamRes.headers);

        headers.delete("content-encoding");
        headers.delete("content-length");

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers,
        });
    });
}
