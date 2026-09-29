//  =====================================================================
//  Intent extraction
//  =====================================================================
//  Takes the WHOLE request body, not just the prompt text, because
//  some of the strongest signals live in the request shape rather
//  than the prose (a non-streaming request asking for JSON is a
//  background utility task, in any language, from any client).

import { extractFeatures } from "./detect.js";
import { TAGS } from "@shuntd/core";

//  A response under this many tokens is a utility task, not a chat
//  turn. Open WebUI's title/tag/follow-up generators all sit here.
const BACKGROUND_MAX_TOKENS = 256;

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
function mapToTags(features, shape, config) {
    //  ---- Background tasks short-circuit ----------------------------
    //  A utility prompt is an INSTRUCTION ABOUT a conversation, not a
    //  user request. Its headings, lists and example file paths belong
    //  to the template, so reading intent from them sent a title
    //  generator to a 51GB coding model. Structure is noise here.
    if (config.route_background_tasks !== false) {
        if (looksLikeBackgroundTask(shape)) {
            return [TAGS.BACKGROUND];
        }
    }

    const tags = new Set();

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

/**
 * Extracts intent from a full OpenAI-shaped request body.
 *
 * @param {Object} body - the parsed request body
 * @param {Object} config - the shuntd configuration
 */
export function extractIntent(body, config) {
    const messages = body.messages || [];
    const { message, index } = findLastUserMessage(messages);
    const rawPrompt = message ? String(message.content ?? "") : "";

    const { override, cleanPrompt } = parseOverride(rawPrompt, config);

    //  Features are extracted even when overridden, so the decision
    //  log records what was asked alongside what was routed.
    const { features, metrics, histogram } = extractFeatures(cleanPrompt);

    const shape = readRequestShape(body);
    const tags = mapToTags(features, shape, config);

    return {
        override,
        tags,
        cleanPrompt,
        promptIndex: index,
        features,
        metrics,
        histogram,
        shape,
    };
}
