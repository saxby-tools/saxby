import { extractIntent } from "../../pipeline/extract.js";
import { resolvePipeline } from "../../pipeline/resolve.js";
import { startTrace } from "../../observability/trace.js";
import { observeResponse } from "../../observability/stream.js";
import { hashPrompt, identifyClient } from "../../log/client.js";

const SHUNTD_MODEL = "shuntd";
const SHUNTD_PREFIX = "shuntd/";

//  ---------------------------------------------------------------------
//  Header construction
//  ---------------------------------------------------------------------

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

//  ---------------------------------------------------------------------
//  Usage reporting
//  ---------------------------------------------------------------------

/**
 * Asks the upstream to report token usage on a streamed response.
 *
 * Only meaningful when streaming — a non-streaming response carries
 * usage already. Never overrides a client that set it itself.
 */
function requestUsageReporting(body) {
    if (body.stream !== true) {
        return;
    }

    if (body.stream_options) {
        return;
    }

    body.stream_options = { include_usage: true };
}

//  ---------------------------------------------------------------------
//  Route
//  ---------------------------------------------------------------------

export function registerChatRoutes(app) {
    app.post("/v1/chat/completions", async (c) => {
        const config = c.get("config");
        const log = c.get("log");

        const body = await c.req.json();
        const rawModel = body.model || "";

        const startedAt = performance.now();
        const receivedAt = new Date().toISOString();

        const tracer = startTrace("chat");
        tracer.ingest(body);

        const client = identifyClient(
            (name) => c.req.header(name),
            config,
        );

        let targetModel = rawModel;
        let logId = null;
        let ttfbMs = null;
        let usage = { promptTokens: null, completionTokens: null };

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

            //  Phase 1 of the log. Written before the upstream call so
            //  a request that never returns still leaves a row.
            logId = log?.record({
                requestId: tracer.id,
                receivedAt,
                client,
                requestedModel: rawModel,
                stream: body.stream ?? null,
                decision,
                intent: extracted,
                prompt: extracted.cleanPrompt,
                promptHash: await hashPrompt(extracted.cleanPrompt),
            });
        }

        //  ---- Unmanaged passthrough ---------------------------------
        if (rawModel !== SHUNTD_MODEL) {
            if (!rawModel.startsWith(SHUNTD_PREFIX)) {
                tracer.proxy(`raw ${targetModel}`);
            }
        }

        //  Bypass and raw passthrough are not routing decisions, but
        //  they ARE traffic. Excluding them makes client mix and
        //  latency stats silently wrong.
        if (!logId) {
            const passthroughTier = rawModel.startsWith(SHUNTD_PREFIX)
                ? "bypass"
                : "raw";

            logId = log?.record({
                requestId: tracer.id,
                receivedAt,
                client,
                requestedModel: rawModel,
                stream: body.stream ?? null,
                decision: {
                    tier: passthroughTier,
                    route: passthroughTier,
                    model: targetModel,
                    candidates: [targetModel],
                    scores: [],
                    skipped: [],
                    abstentions: [],
                    exhausted: false,
                },
                intent: {
                    override: null,
                    tags: [],
                    features: {},
                    histogram: {},
                    metrics: {
                        estimatedTokens: 0,
                        chars: 0,
                        lines: 0,
                        codeRatio: 0,
                    },
                },
                prompt: null,
                promptHash: await hashPrompt(""),
            });
        }

        requestUsageReporting(body);

        //  ---- Closing the row ---------------------------------------
        //  Every exit path below closes it exactly once, with an
        //  outcome that distinguishes a finished stream from an
        //  abandoned one. A row left open means shuntd itself died.

        function closeRow(outcome) {
            if (!logId) {
                return;
            }

            log?.complete(logId, {
                outcome,
                ttfbMs,
                durationMs: Math.round(performance.now() - startedAt),
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
            });

            logId = null;
        }

        const upstreamUrl = `${config.upstream_url}/v1/chat/completions`;

        let upstreamRes;

        try {
            upstreamRes = await fetch(upstreamUrl, {
                method: "POST",
                headers: buildUpstreamHeaders(c),
                body: JSON.stringify(body),
                //  Propagate client disconnects upstream. Without this
                //  an abandoned background task keeps generating on the
                //  GPU long after nobody wants it.
                signal: c.req.raw.signal,
            });
        } catch (err) {
            if (err.name === "AbortError") {
                tracer.aborted();
                closeRow("aborted");

                return c.body(null, 499);
            }

            tracer.warn(`upstream error: ${err.message}`);
            closeRow("upstream_error");

            return c.json(
                { error: { message: `Upstream unreachable: ${err.message}` } },
                502,
            );
        }

        if (!upstreamRes.ok) {
            closeRow("upstream_error");
        }

        const observed = observeResponse(upstreamRes.body, {
            onFirstByte: () => {
                tracer.firstByte();
                ttfbMs = Math.round(performance.now() - startedAt);
            },

            onUsage: (reported) => {
                usage = reported;
            },

            //  Fires when the body finishes OR is cancelled, so an
            //  abandoned stream closes its row rather than hanging
            //  open forever.
            onEnd: () => {
                tracer.done(upstreamRes.status);
                closeRow("completed");
            },
        });

        return new Response(observed, {
            status: upstreamRes.status,
            headers: buildDownstreamHeaders(upstreamRes),
        });
    });
}
