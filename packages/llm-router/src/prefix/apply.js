//  =====================================================================
//  Applying the time note
//  =====================================================================
//  Puts the note on every user message the model will receive, and the
//  explainer in the system prompt. The chat route runs it after the
//  /command strip and the catalog's system_prefix, in both the routed
//  and the bypass branches, so the note sits on exactly what goes
//  upstream. Never on a request that is not chat: explain never sees
//  it.
//
//  Saxby holds nothing between requests and sees the whole message
//  list on each one, so the time it can put on an earlier message is
//  the time of the first request that carried it. That lives in the
//  decision log's message_seen table (log/schema.js, v7), keyed by
//  conversation and message hash under the prompt hash's keyed scheme:
//  no text. The latest message gets the request's arrival time; a
//  message pasted in from elsewhere gets its paste time, which is
//  right.
//
//  The conversation key is the first user message's hash. Two
//  conversations that open with the same words share a key, and then
//  share a first-seen time for any later message that repeats, word
//  for word, in both. A client that trims the oldest message from the
//  history changes the key, and every message is stamped with that
//  request's time, as on a first request. Both are taken over anything
//  that needs a client to send a conversation id.
//
//  The table is observability's, never load-bearing. With no decision
//  log, or one that cannot be read, every message gets the arrival
//  time, and the trace says so.

import { readMessageContent, replaceMessageText } from "../pipeline/extract.js";
import { EXPLAINER, formatNote, gapHoursBetween } from "./note.js";

const ROLE_USER = "user";
const ROLE_SYSTEM = "system";
const PART_TEXT = "text";

//  Between the note and the message, and between a system prompt and
//  the explainer, as the lab's harness joined them.
const NOTE_JOIN = " ";
const EXPLAINER_JOIN = "\n\n";

//  Hours as logged: two decimals, enough to tell 27.5 from 27.
const GAP_DECIMALS = 100;

const REASON_NO_LOG = "no decision log";

//  ---------------------------------------------------------------------
//  Reading the conversation
//  ---------------------------------------------------------------------

/**
 * The user messages, in order.
 * @param {Object} body
 * @returns {Object[]}
 */
function userMessages(body) {
    return (body.messages || []).filter(
        (message) => message?.role === ROLE_USER,
    );
}

/**
 * Lists each user message's text as the client sent it, in order.
 *
 * Called before anything rewrites a message. The /command strip and
 * the note itself both change what goes upstream, but the client
 * keeps its own copy and sends that back next turn, so the hashes
 * must be of the text as it arrived. Texts only, no positions: a
 * system_prefix may add a message in front before the note is
 * applied, and the user messages are found again by role then.
 * @param {Object} body - the parsed request body
 * @returns {string[]}
 */
export function readConversation(body) {
    return userMessages(body).map(
        (message) => readMessageContent(message.content).text,
    );
}

/**
 * One keyed hash per user message, in order.
 * @returns {Promise<string[]>}
 */
function hashConversation(conversation, log) {
    return Promise.all(conversation.map((text) => log.hashPrompt(text)));
}

/**
 * The conversation's first-seen rows, or why there are none.
 * @returns {{ seen: Map<string, string> | null, reason: string | null }}
 */
function lookupFirstSeen(log, conversationKey) {
    if (!log) {
        return { seen: null, reason: REASON_NO_LOG };
    }

    try {
        return { seen: log.findFirstSeen(conversationKey), reason: null };
    } catch (err) {
        return { seen: null, reason: err.message };
    }
}

//  ---------------------------------------------------------------------
//  Working out the times
//  ---------------------------------------------------------------------

/**
 * The instant each note names. The latest message is this request's
 * arrival; an earlier one is when it was first seen, or the arrival
 * when nothing says.
 * @returns {number[]} epoch milliseconds, one per user message
 */
function stampTimes(conversation, hashes, seen, receivedMs) {
    const times = [];
    const last = conversation.length - 1;

    for (let i = 0; i < conversation.length; i++) {
        if (i === last) {
            times.push(receivedMs);
            continue;
        }

        const firstSeen = seen?.get(hashes[i]);

        if (firstSeen === undefined) {
            times.push(receivedMs);
            continue;
        }

        times.push(Date.parse(firstSeen));
    }

    return times;
}

/**
 * Hours since the previous user message was first seen, for the
 * latest note's sentence. Null when there is nothing to say: the
 * sentence is off, the conversation is new, the previous message is
 * not in the table, or under an hour has passed.
 * @returns {number | null}
 */
function gapFor(settings, hashes, seen, receivedMs) {
    if (!settings.gap_sentence) {
        return null;
    }

    if (seen === null) {
        return null;
    }

    if (hashes.length < 2) {
        return null;
    }

    const previous = seen.get(hashes[hashes.length - 2]);

    if (previous === undefined) {
        return null;
    }

    const hours = gapHoursBetween(Date.parse(previous), receivedMs);

    if (hours === null) {
        return null;
    }

    return Math.round(hours * GAP_DECIMALS) / GAP_DECIMALS;
}

//  ---------------------------------------------------------------------
//  Rewriting the messages
//  ---------------------------------------------------------------------

/**
 * Puts the note in front of one message's text, as the text is NOW:
 * the /command strip has run since the conversation was read. Parts
 * keep their images and audio; a message with no text part, an image
 * alone, gets a text part holding the note, since the note has to
 * land somewhere the model reads.
 */
function prependNote(message, note) {
    const text = readMessageContent(message.content).text;
    const joined = text ? `${note}${NOTE_JOIN}${text}` : note;
    const content = replaceMessageText(message.content, joined);

    if (typeof content === "string") {
        message.content = content;
        return;
    }

    if (!Array.isArray(content)) {
        message.content = note;
        return;
    }

    if (!content.some((part) => part?.type === PART_TEXT)) {
        content.unshift({ type: PART_TEXT, text: note });
    }

    message.content = content;
}

/**
 * One note per user message, the gap on the latest. The messages are
 * found by role now, since applySystemPrefix may have put a message
 * in front of them since the conversation was read.
 */
function prependNotes(body, times, timezone, gapHours) {
    const targets = userMessages(body);
    const last = targets.length - 1;

    for (let i = 0; i < targets.length; i++) {
        const note = formatNote({
            at: times[i],
            timezone,
            gapHours: i === last ? gapHours : null,
        });

        prependNote(targets[i], note);
    }
}

/**
 * Adds the explainer to the system prompt. After an existing system
 * message's text, where the lab put it, so a catalog system_prefix
 * merged in front stays in front; or as a new first message when
 * there is none to add to, as applySystemPrefix does.
 */
function addExplainer(body) {
    const messages = body.messages || [];
    const first = messages[0];

    if (first?.role === ROLE_SYSTEM) {
        if (typeof first.content === "string") {
            first.content = `${first.content}${EXPLAINER_JOIN}${EXPLAINER}`;
            return;
        }
    }

    messages.unshift({ role: ROLE_SYSTEM, content: EXPLAINER });
    body.messages = messages;
}

//  ---------------------------------------------------------------------
//  Remembering what was seen
//  ---------------------------------------------------------------------

/**
 * Queues a first-seen row for every message not already in the
 * table. Nothing is written when the table could not be read: a
 * write would likely fail the same way, and a row with the wrong
 * time is worse than none.
 * @returns {number} how many rows were queued
 */
function rememberNew(log, conversationKey, hashes, seen, receivedAt) {
    if (seen === null) {
        return 0;
    }

    const fresh = [...new Set(hashes.filter((hash) => !seen.has(hash)))];

    if (fresh.length === 0) {
        return 0;
    }

    log.rememberFirstSeen(conversationKey, fresh, receivedAt);

    return fresh.length;
}

//  ---------------------------------------------------------------------
//  Entry point
//  ---------------------------------------------------------------------

/**
 * Stamps every user message with the time it was first seen and puts
 * the explainer in the system prompt. Returns what the decision log
 * records, or null when the feature is off or there is no user
 * message to stamp.
 *
 * @param {Object} body - the request body, as it will go upstream;
 *   rewritten in place
 * @param {string[]} conversation - from readConversation, read before
 *   any rewrite
 * @param {Object} options
 * @param {Object} options.config - the running config
 * @param {Object | null} options.log - the decision log, or none
 * @param {string} options.receivedAt - the request's arrival, ISO
 * @param {Object} [options.tracer] - the request's tracer
 * @returns {Promise<{ gapHours: number | null } | null>}
 */
export async function applyMessagePrefix(body, conversation, options) {
    const settings = options.config.message_prefix;

    if (!settings?.enabled) {
        return null;
    }

    if (conversation.length === 0) {
        return null;
    }

    const receivedMs = Date.parse(options.receivedAt);

    let hashes = [];
    let conversationKey = null;
    let lookup = { seen: null, reason: REASON_NO_LOG };

    if (options.log) {
        hashes = await hashConversation(conversation, options.log);
        conversationKey = hashes[0];
        lookup = lookupFirstSeen(options.log, conversationKey);
    }

    const times = stampTimes(conversation, hashes, lookup.seen, receivedMs);
    const gapHours = gapFor(settings, hashes, lookup.seen, receivedMs);

    prependNotes(body, times, settings.timezone, gapHours);
    addExplainer(body);

    const added = rememberNew(
        options.log,
        conversationKey,
        hashes,
        lookup.seen,
        options.receivedAt,
    );

    if (lookup.reason !== null) {
        options.tracer?.note(
            `first-seen times unavailable (${lookup.reason}); ` +
                `arrival time on every message`,
        );
    }

    options.tracer?.note(
        `zone=${settings.timezone} messages=${conversation.length} ` +
            `new=${added} gap=${gapHours ?? "none"}`,
    );

    return { gapHours };
}
