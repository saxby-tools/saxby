//  =====================================================================
//  Request tracing
//  =====================================================================
//  Deliberately SEPARATE from the Milestone 4 decision log. The log is
//  a durable, queryable record for analysis. This is ephemeral stdout
//  for a human watching a terminal right now. They answer different
//  questions and they should not share a code path.
//
//  Verbosity:
//    off      normal one-line summary per request
//    verbose  full lifecycle: ingest, extract, resolve, proxy, done
//    trace    verbose plus abstention reasons and feature evidence
//
//  Enable with SHUNTD_VERBOSE=1 / SHUNTD_TRACE=1, or --verbose /
//  --trace on the daemon.

const LEVEL_OFF = 0;
const LEVEL_VERBOSE = 1;
const LEVEL_TRACE = 2;

//  Cheap request ids. Collision-resistant enough to disambiguate
//  concurrent requests in a scrollback, which is all they are for.
const ID_ALPHABET = "0123456789abcdef";
const ID_LENGTH = 4;

let currentLevel = LEVEL_OFF;

/**
 * Resolves verbosity from flags and environment, flags winning.
 */
export function initTracing(args = []) {
    if (args.includes("--trace")) {
        currentLevel = LEVEL_TRACE;
        return currentLevel;
    }

    if (args.includes("--verbose")) {
        currentLevel = LEVEL_VERBOSE;
        return currentLevel;
    }

    if (args.includes("-v")) {
        currentLevel = LEVEL_VERBOSE;
        return currentLevel;
    }

    if (Deno.env.get("SHUNTD_TRACE")) {
        currentLevel = LEVEL_TRACE;
        return currentLevel;
    }

    if (Deno.env.get("SHUNTD_VERBOSE")) {
        currentLevel = LEVEL_VERBOSE;
        return currentLevel;
    }

    currentLevel = LEVEL_OFF;

    return currentLevel;
}

export function isVerbose() {
    return currentLevel >= LEVEL_VERBOSE;
}

function newRequestId() {
    let id = "";

    for (let i = 0; i < ID_LENGTH; i++) {
        const pick = Math.floor(Math.random() * ID_ALPHABET.length);
        id += ID_ALPHABET[pick];
    }

    return `req_${id}`;
}

function emit(id, stage, detail) {
    console.log(`[${id}] ${stage.padEnd(7)} ${detail}`);
}

/**
 * Creates a tracer bound to one request.
 */
export function startTrace(label) {
    const id = newRequestId();
    const startedAt = performance.now();

    let firstByteAt = null;

    function elapsed() {
        return Math.round(performance.now() - startedAt);
    }

    return {
        id,

        ingest(body) {
            if (currentLevel < LEVEL_VERBOSE) {
                return;
            }

            const messages = body.messages || [];
            const stream = body.stream === undefined
                ? "unset"
                : String(body.stream);

            emit(
                id,
                "INGEST",
                `model=${body.model || "(none)"} msgs=${messages.length} ` +
                    `stream=${stream} label=${label}`,
            );
        },

        extract(extracted) {
            if (currentLevel < LEVEL_VERBOSE) {
                return;
            }

            const tags = extracted.tags.length > 0
                ? extracted.tags.join(",")
                : "(none)";

            emit(
                id,
                "EXTRACT",
                `override=${extracted.override || "null"} tags=[${tags}] ` +
                    `tokens~${extracted.metrics.estimatedTokens}`,
            );

            if (currentLevel < LEVEL_TRACE) {
                return;
            }

            const featureNames = Object.keys(extracted.features);
            const shown = featureNames.length > 0
                ? featureNames.join(",")
                : "(none)";

            emit(id, "FEATURE", shown);
        },

        resolve(decision) {
            if (currentLevel < LEVEL_VERBOSE) {
                return;
            }

            emit(
                id,
                "RESOLVE",
                `tier=${decision.tier} route=${decision.route} ` +
                    `target=${decision.model}`,
            );

            if (decision.systemPrefix) {
                emit(id, "PREFIX", `"${decision.systemPrefix}"`);
            }

            if (decision.semantic) {
                const s = decision.semantic;

                emit(
                    id,
                    "SEMANTIC",
                    s.error
                        ? `unavailable: ${s.error}`
                        : `${s.label} ${s.score.toFixed(3)} ` +
                            `(margin ${s.margin?.toFixed(3) ?? "n/a"}, ` +
                            `vs ${s.runnerUp ?? "none"})`,
                );
            }

            if (currentLevel < LEVEL_TRACE) {
                return;
            }

            //  WHY each tier passed. This is the line that would have
            //  found the empty-capabilities bug on the first request.
            for (const skip of decision.abstentions) {
                emit(id, "ABSTAIN", `tier ${skip.tier}: ${skip.reason}`);
            }

            for (const skip of decision.skipped) {
                emit(id, "SKIP", `${skip.modelId}: ${skip.reason}`);
            }
        },

        //  Warnings are emitted at EVERY level, including off. A
        //  degraded router must never be quiet.
        warn(detail) {
            emit(id, "WARN", detail);
        },

        proxy(url) {
            if (currentLevel < LEVEL_VERBOSE) {
                return;
            }

            emit(id, "PROXY", `-> ${url} (${elapsed()}ms)`);
        },

        firstByte() {
            if (firstByteAt !== null) {
                return;
            }

            firstByteAt = elapsed();

            if (currentLevel < LEVEL_VERBOSE) {
                return;
            }

            emit(id, "TTFB", `${firstByteAt}ms`);
        },

        done(status) {
            if (currentLevel < LEVEL_VERBOSE) {
                return;
            }

            const ttfb = firstByteAt === null ? "n/a" : `${firstByteAt}ms`;

            emit(
                id,
                "DONE",
                `status=${status} ttfb=${ttfb} total=${elapsed()}ms`,
            );
        },

        aborted() {
            emit(id, "ABORT", `client disconnected after ${elapsed()}ms`);
        },

        //  Compact single line for non-verbose operation.
        summary(decision) {
            if (currentLevel >= LEVEL_VERBOSE) {
                return;
            }

            console.log(
                `[${id}] tier=${decision.tier} route=${decision.route} ` +
                    `-> ${decision.model ?? "refused"}`,
            );
        },
    };
}
