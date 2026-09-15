import { extractIntent } from "../../pipeline/extract.js";
import { resolvePipeline } from "../../pipeline/resolve.js";
import { observeStream, startTrace } from "../../observability/trace.js";

const SHUNTD_MODEL = "shuntd";
const SHUNTD_PREFIX = "shuntd/";

/**
 * Builds upstream headers. Deliberately minimal: forwarding the
 * client's headers wholesale sends a stale Content-Length (the body
 * is rewritten) and an Accept-Encoding that makes the upstream gzip
 * a stream we then re-frame.
 */
function buildUpstreamHeaders(c) {
    const headers = { "Content-Type": "application/json" };

    const auth = c.req.header("Authorization");

    if (!auth) {
        return headers;
    }

    headers.Authorization = auth;

    return headers;
}

/**
 * Strips headers that break a re-piped stream. fetch() already
 * decompressed the body, so a surviving content-encoding tells the
 * client to gunzip plaintext.
 */
function buildDownstreamHeaders(upstreamRes) {
    const headers = new Headers(upstreamRes.headers);

    headers.delete("content-encoding");
    headers.delete("content-length");

    return headers;
}

export function registerChatRoutes(app) {
    app.post("/v1/chat/completions", async (c) => {
        const config = c.get("config");
        const body = await c.req.json();
        const rawModel = body.model || "";

        const tracer = startTrace("chat");
        tracer.ingest(body);

        let targetModel = rawModel;

        //  ---- Direct hardware bypass: shuntd/<model> ----------------
        if (rawModel.startsWith(SHUNTD_PREFIX)) {
            targetModel = rawModel.slice(SHUNTD_PREFIX.length);
            body.model = targetModel;
            tracer.proxy(`bypass ${targetModel}`);
        }

        //  ---- Smart routing: model === "shuntd" ---------------------
        if (rawModel === SHUNTD_MODEL) {
            const extracted = extractIntent(body, config);
            tracer.extract(extracted);

            const decision = resolvePipeline(extracted, config);
            tracer.resolve(decision);
            tracer.summary(decision);

            //  A tier that wanted to fire but found no home is a
            //  CONFIG problem wearing the costume of normal operation.
            //  Surface it at every verbosity level.
            if (decision.tier === "fallback") {
                if (extracted.tags.length > 0) {
                    tracer.warn(
                        `tags [${extracted.tags.join(",")}] matched ` +
                            `nothing; check catalog 'capabilities'`,
                    );
                }
            }

            if (decision.exhausted) {
                tracer.warn(
                    `every candidate was too small for ` +
                        `~${extracted.metrics.estimatedTokens} tokens`,
                );
            }

            targetModel = decision.model;
            body.model = targetModel;

            //  Strip the /command so the model never sees it.
            if (extracted.override) {
                if (extracted.promptIndex >= 0) {
                    body.messages[extracted.promptIndex].content =
                        decision.prompt;
                }
            }
        }

        //  ---- Unmanaged passthrough ---------------------------------
        if (rawModel !== SHUNTD_MODEL) {
            if (!rawModel.startsWith(SHUNTD_PREFIX)) {
                tracer.proxy(`raw ${targetModel}`);
            }
        }

        const upstreamUrl = `${config.upstream_url}/v1/chat/completions`;

        let upstreamRes;

        try {
            upstreamRes = await fetch(upstreamUrl, {
                method: "POST",
                headers: buildUpstreamHeaders(c),
                body: JSON.stringify(body),
                //  Propagate client disconnects upstream. Without this
                //  an abandoned Open WebUI background task keeps
                //  generating on the GPU long after nobody wants it.
                signal: c.req.raw.signal,
            });
        } catch (err) {
            if (err.name === "AbortError") {
                tracer.aborted();
                return c.body(null, 499);
            }

            tracer.warn(`upstream error: ${err.message}`);

            return c.json(
                { error: { message: `Upstream unreachable: ${err.message}` } },
                502,
            );
        }

        tracer.done(upstreamRes.status);

        return new Response(observeStream(upstreamRes.body, tracer), {
            status: upstreamRes.status,
            headers: buildDownstreamHeaders(upstreamRes),
        });
    });
}
