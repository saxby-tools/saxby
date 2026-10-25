//  =====================================================================
//  Intent extraction
//  =====================================================================
//  Takes the WHOLE request body, not just the prompt text, because
//  some of the strongest signals live in the request shape rather
//  than the prose (an explicitly non-streaming request is a
//  background utility task, in any language, from any client).

import { extractFeatures } from "./detect.js";
import { TAGS } from "@saxby/core";

//  A response under this many tokens is a utility task, not a chat
//  turn. Open WebUI's title/tag/follow-up generators all sit here.
const BACKGROUND_MAX_TOKENS = 256;

//  Multimodal messages send `content` as an array of parts rather
//  than a string. Collapsing that with String() yields
//  "[object Object]", which then gets feature-extracted, embedded
//  and logged as if it were the prompt.
function readMessageContent(content) {
    if (typeof content === "string") {
        return { text: content, images: 0, audio: 0 };
    }

    if (!Array.isArray(content)) {
        return { text: "", images: 0, audio: 0 };
    }

    const texts = [];

    let images = 0;
    let audio = 0;

    for (const part of content) {
        if (part?.type === "text") {
            texts.push(part.text ?? "");
            continue;
        }

        if (part?.type === "image_url") {
            images++;
            continue;
        }

        if (part?.type === "input_audio") {
            audio++;
        }
    }

    return { text: texts.join("\n"), images, audio };
}

/**
 * Finds the last user message and its index.
 */
function findLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== "user") {
            continue;
        }

        return { message: messages[i], index: i };
    }

    return { message: null, index: -1 };
}

/**
 * Reads routing signals off the request envelope.
 *
 * These are structural and client-agnostic — no English boilerplate
 * matching, which would break on the next Open WebUI release and on
 * every non-English UI.
 */
function readRequestShape(body) {
    const shape = {
        //  OpenAI defaults stream to false when omitted, so only an
        //  EXPLICIT false counts. Otherwise every curl test without a
        //  stream field gets flagged as a background task.
        explicitlyNonStreaming: body.stream === false,
        wantsStructuredOutput: Boolean(body.response_format),
        maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
    };

    shape.smallBudget = shape.maxTokens !== null &&
        shape.maxTokens <= BACKGROUND_MAX_TOKENS;

    return shape;
}

/**
 * An interactive chat turn streams. A request that explicitly
 * asks NOT to stream is a utility call — a title, a tag set, a
 * follow-up list.
 *
 * This originally also required a response_format or a small
 * max_tokens. Open WebUI's task requests send neither, so the
 * AND never fired and every background task was intent-routed
 * off its own boilerplate. Two weak signals ANDed together are
 * weaker than one good one.
 */
function looksLikeBackgroundTask(shape) {
    return shape.explicitlyNonStreaming;
}

/**
 * Maps structural features and request shape to canonical tags.
 */
function mapToTags(parts, features, shape, config) {
    const tags = new Set();

    //  Capability requirements, emitted first so nothing can drop
    //  them.
    if (parts.images > 0) {
        tags.add(TAGS.VISION);
    }

    if (parts.audio > 0) {
        tags.add(TAGS.AUDIO);
    }

    //  ---- Background tasks short-circuit ----------------------------
    //  A utility prompt is an INSTRUCTION ABOUT a conversation, not a
    //  user request. Its headings, lists and example file paths belong
    //  to the template, so reading intent from them sent a title
    //  generator to a 51GB coding model. Structure is noise here.
    //
    //  The requirements gathered above survive the short-circuit: a
    //  non-streaming request with an image still needs a model that
    //  can see it. Returning BACKGROUND alone once dropped them.
    if (config.route_background_tasks !== false) {
        if (looksLikeBackgroundTask(shape)) {
            return [...tags, TAGS.BACKGROUND];
        }
    }

    //  ---- Code and engineering --------------------------------------
    if (features.fencedCode) {
        tags.add(TAGS.CODER);
    }

    if (features.inlineCode) {
        tags.add(TAGS.CODER);
    }

    if (features.diff) {
        tags.add(TAGS.CODER);
    }

    if (features.stackTrace) {
        tags.add(TAGS.CODER);
        tags.add(TAGS.DEBUG);
    }

    //  ---- Multi-file: the devstral vs qwen distinction --------------
    if (features.filePaths) {
        tags.add(TAGS.CODER);

        if (features.filePaths.count >= 2) {
            tags.add(TAGS.MULTI_FILE);
        }
    }

    //  ---- Data and formatting ---------------------------------------
    if (features.json) {
        tags.add(TAGS.DATA);
    }

    if (features.tabular) {
        tags.add(TAGS.DATA);
    }

    if (features.table) {
        tags.add(TAGS.DATA);
    }

    //  ---- Mathematics -----------------------------------------------
    if (features.math) {
        tags.add(TAGS.MATH);
        tags.add(TAGS.REASONING);
    }

    return [...tags];
}

/**
 * Strips a leading /command, returning the persona and clean prompt.
 */
function parseOverride(prompt, config) {
    const trimmed = prompt.trim();

    if (!trimmed.startsWith("/")) {
        return { override: null, cleanPrompt: trimmed };
    }

    const words = trimmed.split(/\s+/);
    const requested = words[0].slice(1).toLowerCase();

    if (!config.personas[requested]) {
        //  Unknown command: leave the text alone rather than silently
        //  eating it. The user should see their own typo echoed back.
        return { override: null, cleanPrompt: trimmed };
    }

    return {
        override: requested,
        cleanPrompt: words.slice(1).join(" ").trim(),
    };
}

//  Weight is a property of the WHOLE payload, not the current turn.
//  Intent comes from the last user message; context pressure comes
//  from everything the upstream will actually have to prefill —
//  system prompt, injected memory, and every prior turn. An agent
//  sends 20 messages and a two-line question; estimating from the
//  question alone was wrong by three orders of magnitude.
function measurePayload(messages) {
    let chars = 0;
    let images = 0;
    let audio = 0;

    for (const message of messages) {
        const parts = readMessageContent(message.content);

        chars += parts.text.length;
        images += parts.images;
        audio += parts.audio;
    }

    return { chars, images, audio };
}

/**
 * Extracts intent from a full OpenAI-shaped request body.
 *
 * @param {Object} body - the parsed request body
 * @param {Object} config - the Saxby configuration
 */
export function extractIntent(body, config) {
    const messages = body.messages || [];
    const { message, index } = findLastUserMessage(messages);
    const parts = message
        ? readMessageContent(message.content)
        : { text: "", images: 0, audio: 0 };

    const rawPrompt = parts.text;
    const { override, cleanPrompt } = parseOverride(rawPrompt, config);

    //  Features are extracted even when overridden, so the decision
    //  log records what was asked alongside what was routed.
    const { features, metrics, histogram } = extractFeatures(cleanPrompt);

    const payload = measurePayload(messages);

    //  Features and histogram stay scoped to the current turn.
    //  Metrics are rescaled to the full conversation: every OTHER
    //  message at the prose rate, plus the current turn's own
    //  code-aware estimate. Adding that estimate to a count that
    //  already included the turn once charged it twice.
    const priorChars = payload.chars - rawPrompt.length;

    const payloadMetrics = {
        ...metrics,
        chars: payload.chars,
        estimatedTokens: Math.ceil(priorChars / 4) +
            metrics.estimatedTokens,
    };

    const shape = readRequestShape(body);
    const tags = mapToTags(parts, features, shape, config);

    return {
        override,
        tags,
        cleanPrompt,
        promptIndex: index,
        features,
        metrics: payloadMetrics,
        histogram,
        shape,
    };
}
