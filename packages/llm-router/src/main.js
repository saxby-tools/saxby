import { loadConfig } from "./config/loader.js";
import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { registerRoutes } from "./routes/index.js";
import { validateTagContract } from "@shuntd/core";
import { initTracing, isVerbose } from "./observability/trace.js";

async function main() {
    console.log("🚀 Starting shuntd llm-router...");

    const level = initTracing(Deno.args);

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

    //  A tag nothing claims is a silently degraded router: every
    //  structural match falls through to the global default and looks
    //  like normal operation. Always warn, regardless of verbosity.
    const tagWarnings = validateTagContract(config);

    for (const warning of tagWarnings) {
        console.warn(`⚠️  ${warning}`);
    }

    if (level > 0) {
        console.log(`🔍 Tracing enabled (level ${level}).`);
    }

    const app = new Hono();

    //  Hono's access logger duplicates the tracer when verbose, so it
    //  is only mounted in quiet mode.
    if (!isVerbose()) {
        app.use("*", logger());
    }

    app.use("*", async (c, next) => {
        c.set("config", config);
        await next();
    });

    registerRoutes(app);

    //  Global catch-all for unimplemented OpenAI endpoints.
    app.all("*", async (c) => {
        const url = new URL(c.req.url);
        console.log(`\n➡️ Proxying unhandled endpoint: ${url.pathname}`);

        const isGetOrHead = ["GET", "HEAD"].includes(c.req.method);

        //  Forwarding the client's headers wholesale sends an
        //  Accept-Encoding that makes the upstream gzip a stream we
        //  then re-frame, plus a Content-Length that may not match.
        //  Copy and strip instead.
        const upstreamHeaders = new Headers(c.req.raw.headers);

        upstreamHeaders.delete("accept-encoding");
        upstreamHeaders.delete("content-length");
        upstreamHeaders.delete("host");

        const upstreamReq = new Request(
            `${config.upstream_url}${url.pathname}${url.search}`,
            {
                method: c.req.method,
                headers: upstreamHeaders,
                body: isGetOrHead ? undefined : c.req.raw.body,
                duplex: isGetOrHead ? undefined : "half",
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
