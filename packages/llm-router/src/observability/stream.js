//  =====================================================================
//  Response stream observation
//  =====================================================================
//  Watches the upstream response on its way to the client so the
//  tracer gets a TTFB and the decision log gets token counts.
//
//  The stream is NEVER buffered and never delayed. Every chunk is
//  enqueued downstream FIRST, then inspected. Observation that adds
//  latency to a token stream would make the router feel worse than
//  no router, which is the one outcome the whole project cannot
//  afford.
//
//  Two response shapes:
//
//    streaming      SSE. Usage arrives in a final `data:` frame, and
//                   only when the request asked for it via
//                   stream_options.include_usage.
//    non-streaming  One JSON object with a usage block. Accumulated
//                   up to a cap, since these are utility-task sized.
//
//  If usage never arrives the columns stay NULL, which is the honest
//  outcome — a guessed token count is worse than no token count.

const SSE_PREFIX = "data: ";
const SSE_DONE = "[DONE]";

//  Non-streaming bodies are accumulated to read usage. Utility tasks
//  are small; this cap stops a pathological response from being held
//  in memory. Past it, usage is simply not recorded.
const MAX_BUFFERED_BYTES = 256 * 1024;

/**
 * Pulls a usage object out of a parsed payload, normalised.
 */
function readUsage(payload) {
    const usage = payload?.usage;

    if (!usage) {
        return null;
    }

    return {
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
    };
}

/**
 * Scans one SSE line for a usage block.
 */
function readSseLine(line) {
    if (!line.startsWith(SSE_PREFIX)) {
        return null;
    }

    const data = line.slice(SSE_PREFIX.length).trim();

    if (data === SSE_DONE) {
        return null;
    }

    if (data.length === 0) {
        return null;
    }

    try {
        return readUsage(JSON.parse(data));
    } catch {
        //  A partial or non-JSON frame. Not an error — the stream is
        //  the product, this is only observation.
        return null;
    }
}

/**
 * Wraps a response body, passing every chunk straight through.
 *
 * @param {ReadableStream|null} body
 * @param {Object} handlers
 * @param {() => void} handlers.onFirstByte
 * @param {(usage) => void} handlers.onUsage
 * @param {() => void} handlers.onEnd
 */
export function observeResponse(body, handlers) {
    if (!body) {
        handlers.onEnd?.();
        return body;
    }

    const decoder = new TextDecoder();

    let sawFirstByte = false;
    let sseBuffer = "";
    let plainBuffer = "";
    let plainBytes = 0;
    let sawSse = false;
    let reportedUsage = false;

    function reportUsage(usage) {
        if (!usage) {
            return;
        }

        if (reportedUsage) {
            return;
        }

        reportedUsage = true;
        handlers.onUsage?.(usage);
    }

    const observer = new TransformStream({
        transform(chunk, controller) {
            //  Downstream first, always.
            controller.enqueue(chunk);

            if (!sawFirstByte) {
                sawFirstByte = true;
                handlers.onFirstByte?.();
            }

            if (reportedUsage) {
                return;
            }

            const text = decoder.decode(chunk, { stream: true });

            //  ---- SSE path ------------------------------------------
            if (text.includes(SSE_PREFIX)) {
                sawSse = true;
            }

            if (sawSse) {
                sseBuffer += text;

                const lines = sseBuffer.split("\n");

                //  Last element may be a partial line; hold it back.
                sseBuffer = lines.pop() ?? "";

                for (const line of lines) {
                    reportUsage(readSseLine(line));
                }

                return;
            }

            //  ---- Non-streaming path --------------------------------
            if (plainBytes > MAX_BUFFERED_BYTES) {
                return;
            }

            plainBytes += chunk.byteLength;
            plainBuffer += text;
        },

        flush() {
            if (!reportedUsage) {
                if (sseBuffer.length > 0) {
                    reportUsage(readSseLine(sseBuffer));
                }
            }

            if (!reportedUsage) {
                if (plainBuffer.length > 0) {
                    try {
                        reportUsage(readUsage(JSON.parse(plainBuffer)));
                    } catch {
                        //  Truncated by the cap, or not JSON at all.
                    }
                }
            }

            handlers.onEnd?.();
        },
    });

    return body.pipeThrough(observer);
}
