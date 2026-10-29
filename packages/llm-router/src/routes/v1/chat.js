import { extractIntent } from "../../pipeline/extract.js";
import { resolvePipeline } from "../../pipeline/resolve.js";
import { classifyModel } from "../../pipeline/model-name.js";
import { startTrace } from "../../observability/trace.js";
import { observeResponse } from "../../observability/stream.js";
import { identifyClient } from "../../log/client.js";
import { CODE_ABANDONED } from "../../memory/broker.js";

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
        const broker = c.get("broker");

        const body = await c.req.json();
        const rawModel = body.model || "";
        const requested = classifyModel(rawModel);

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

        //  ---- Direct hardware bypass: saxby/<model> -----------------
        if (requested.mode === "bypass") {
            targetModel = requested.target;
            body.model = targetModel;
            tracer.proxy(`bypass ${targetModel}`);
        }

        //  ---- Smart routing: model === "saxby" ----------------------
        if (requested.mode === "route") {
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
                promptHash: await log?.hashPrompt(extracted.cleanPrompt),

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
        //
        //  Gated on the request's mode, never on logId. With no
        //  decision log, logId stays empty for a routed request too,
        //  and this block once ran a second time: the system_prefix
        //  went in twice and the trace called the request raw.
        if (requested.mode !== "route") {
            systemPrefix = applySystemPrefix(body, targetModel, config);

            const passthroughTier = requested.mode;

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
                promptHash: await log?.hashPrompt(""),
                semantic: null,
                systemPrefix,
            });
        }

        requestUsageReporting(body);

        //  ---- Closing the row ---------------------------------------

        //  Set when the memory broker let a model load through. Freed
        //  at the first byte, when the backend lists the model and its
        //  size counts as loaded instead, or when the request ends.
        let loadHold = null;

        function releaseLoadHold() {
            if (!loadHold) {
                return;
            }

            loadHold.release();
            loadHold = null;
        }

        function closeRow(outcome) {
            releaseLoadHold();

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

        //  ---- Memory gate -------------------------------------------
        //  A model that is not loaded loads when this request reaches
        //  the backend. While a job holds a reservation, that load must
        //  fit first (docs/memory-broker.md). Bypass and raw requests
        //  are gated too: they load models just the same. With no job
        //  held, the check is one synchronous call and no await.
        if (broker.hasJobs()) {
            const gate = await broker.gateLoad(targetModel, {
                requestId: tracer.id,
                signal: c.req.raw.signal,
            });

            if (gate.code === CODE_ABANDONED) {
                tracer.aborted();
                closeRow("aborted");

                return c.body(null, 499);
            }

            //  A new decision-log outcome beside 'refused': routing
            //  found a model, but memory could not hold it. The
            //  memory_events row with this request_id says why.
            if (!gate.admitted) {
                tracer.warn(gate.reason);
                closeRow("memory_refused");

                return c.json({
                    error: {
                        message: `Saxby is holding GPU memory for a ` +
                            `running job: ${gate.reason}`,
                        type: "server_error",
                        code: gate.code,
                    },
                }, 503);
            }

            loadHold = gate.hold;
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
            //  backend was down, or that Saxby itself is fine.
            return c.json({
                error: {
                    message: `Saxby could not reach its upstream at ` +
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
                releaseLoadHold();
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
