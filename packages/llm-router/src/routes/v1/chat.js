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

/**
 * Injects a model's system_prefix, if it declares one.
 *
 * Merges into an existing system message rather than adding a second
 * one, because several local models honour only the first. Returns
 * the text applied so it can be traced and logged — an injected
 * prompt that nothing records is a response shaped by something
 * invisible.
 */
function applySystemPrefix(body, targetModel, config) {
    const prefix = config.catalog[targetModel]?.system_prefix;

    if (!prefix) {
        return null;
    }

    const messages = body.messages || [];
    const first = messages[0];

    if (first?.role === "system") {
        if (typeof first.content === "string") {
            first.content = `${prefix}\n\n${first.content}`;
            return prefix;
        }
    }

    messages.unshift({ role: "system", content: prefix });
    body.messages = messages;

    return prefix;
}

//  ---------------------------------------------------------------------
//  Route
//  ---------------------------------------------------------------------

export function registerChatRoutes(app) {
    app.post("/v1/chat/completions", async (c) => {
        const config = c.get("config");
        const log = c.get("log");
        const semantic = c.get("semantic");

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
        let systemPrefix = null;

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

            //  Async now: Tier 3 makes one embedding call, but only
            //  when tiers 1 and 2 both abstained.
            const decision = await resolvePipeline(
                extracted,
                config,
                semantic,
            );

            tracer.resolve(decision);
            tracer.summary(decision);

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

            systemPrefix = applySystemPrefix(body, targetModel, config);

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

                //  Written whether or not Tier 3 won. A rejected score
                //  is what the threshold gets tuned against.
                semantic: decision.semantic
                    ? {
                        confidence: decision.semantic.score,
                        model: decision.semantic.model,
                        dim: decision.semantic.dim,
                    }
                    : null,
                systemPrefix,
            });

            //  Nothing in the catalog can serve a requirement. The row
            //  is closed at once so refusals stay countable, and the
            //  client gets the reason instead of a model that would
            //  fail on its input.
            if (decision.tier === "refused") {
                tracer.warn(decision.refusal);

                if (logId) {
                    log.complete(logId, {
                        outcome: "refused",
                        ttfbMs: null,
                        durationMs: Math.round(performance.now() - startedAt),
                        promptTokens: null,
                        completionTokens: null,
                    });
                }

                return c.json({
                    error: {
                        message: decision.refusal,
                        type: "invalid_request_error",
                        code: "unmet_requirement",
                    },
                }, 400);
            }
        }

        //  ---- Bypass and raw passthrough ----------------------------
        //  Not routing decisions, but they ARE traffic. Excluding them
        //  makes client mix and latency stats silently wrong.
        if (!logId) {
            systemPrefix = applySystemPrefix(body, targetModel, config);

            const passthroughTier = rawModel.startsWith(SHUNTD_PREFIX)
                ? "bypass"
                : "raw";

            if (passthroughTier === "raw") {
                tracer.proxy(`raw ${targetModel}`);
            }

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
                semantic: null,
                systemPrefix,
            });
        }

        requestUsageReporting(body);

        //  ---- Closing the row ---------------------------------------

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
                signal: c.req.raw.signal,
            });
        } catch (err) {
            if (err.name === "AbortError") {
                tracer.aborted();
                closeRow("aborted");

                return c.body(null, 499);
            }

            tracer.warn(`upstream ${config.upstream_url}: ${err.message}`);
            closeRow("upstream_error");

            //  Name the URL: "fetch failed" alone does not say which
            //  backend was down, or that shuntd itself is fine.
            return c.json({
                error: {
                    message: `shuntd could not reach its upstream at ` +
                        `${config.upstream_url}: ${err.message}`,
                },
            }, 502);
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

            onEnd: () => {
                tracer.done(upstreamRes.status);
                closeRow("completed");
            },

            //  The client left mid-response. Same outcome as leaving
            //  before the backend answered, with whatever timing and
            //  usage arrived first.
            onCancel: () => {
                tracer.aborted();
                closeRow("aborted");
            },
        });

        return new Response(observed, {
            status: upstreamRes.status,
            headers: buildDownstreamHeaders(upstreamRes),
        });
    });
}
