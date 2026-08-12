import { loadConfig } from "./config/loader.js";
import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { registerRoutes } from "./routes/index.js";

async function main() {
    console.log("🚀 Starting shuntd llm-router...");

    let config;
    try {
        config = await loadConfig();
        console.log("✅ Configuration loaded and validated!");
        console.log(`🔗 Upstream target: ${config.upstream_url}`);
        console.log(
            `🧠 Loaded ${Object.keys(config.personas).length} personas.`,
        );
    } catch (error) {
        console.error(error.message);
        Deno.exit(1);
    }

    const app = new Hono();

    // 1. Mount the access logger globally
    app.use("*", logger());

    app.use("*", async (c, next) => {
        c.set("config", config);
        await next();
    });

    registerRoutes(app);

    // Global catch-all for unimplemented OpenAI endpoints (e.g., /v1/audio)
    app.all("*", async (c) => {
        const url = new URL(c.req.url);
        console.log(`\n➡️ Proxying unhandled endpoint: ${url.pathname}`);

        const isGetOrHead = ["GET", "HEAD"].includes(c.req.method);

        const upstreamReq = new Request(
            `${config.upstream_url}${url.pathname}${url.search}`,
            {
                method: c.req.method,
                // NOTE: Again, assume you already handle header filtering here if needed!
                headers: c.req.raw.headers,
                body: isGetOrHead ? undefined : c.req.raw.body,
                duplex: isGetOrHead ? undefined : "half", // The magic fix
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

    Deno.serve({ port: config.listen_port }, app.fetch);
}

if (import.meta.main) {
    main();
}
