import { extractIntent } from "../../pipeline/extract.js";
import { resolvePipeline } from "../../pipeline/resolve.js";

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

        // 1. Direct hardware bypass (e.g., shuntd/devstral-small)
        if (rawModel.startsWith("shuntd/")) {
            targetModel = rawModel.replace("shuntd/", "");
            body.model = targetModel;
            console.log(`\n➡️ Proxying direct request to: ${targetModel}`);
        } // 2. Smart Routing Triggered
        else if (rawModel === "shuntd") {
            // Grab the last user message for the extraction layer
            const messages = body.messages || [];
            const lastUserMsg = messages.slice().reverse().find((m) =>
                m.role === "user"
            );
            const rawPrompt = lastUserMsg ? lastUserMsg.content : "";

            // Run the Pipeline
            const extracted = extractIntent(rawPrompt, config);
            const decision = await resolvePipeline(extracted, config);

            targetModel = decision.model;
            body.model = targetModel;

            // Mask explicit slash commands so the LLM doesn't see "/coder"
            if (lastUserMsg && extracted.override) {
                lastUserMsg.content = decision.prompt;
            }

            console.log(`\n🧠 Router Decision:`);
            console.log(`   Tier   : ${decision.tier}`);
            console.log(`   Route  : ${decision.route}`);
            console.log(`➡️ Proxying request to: ${targetModel}`);
        } // 3. Unmanaged model pass-through
        else {
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

        // Strip headers that interfere with streaming or chunked payloads
        headers.delete("content-encoding");
        headers.delete("content-length");

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers,
        });
    });
}
