import { assertEquals, assertMatch } from "@std/assert";
import { openDecisionLog } from "../log/db.js";
import { EXPLAINER } from "./note.js";
import { applyMessagePrefix, readConversation } from "./apply.js";

//  =====================================================================
//  The note on a conversation
//  =====================================================================
//  A real in-memory decision log, so the first-seen table is the one
//  saxbyd writes. The writer adds signal listeners for a clean
//  shutdown, so the resource sanitizer is off, as in db.test.js.

const ZONE = "America/Chicago";

//  Three requests of one conversation: the first turn, a resume the
//  next day, and a resume twelve days on.
const FIRST_AT = "2026-10-26T06:30:00.000Z";
const NEXT_DAY_AT = "2026-10-27T09:30:00.000Z";
const TWELVE_DAYS_AT = "2026-11-08T09:30:00.000Z";

const NOTE_FIRST = "[It is 1:30 a.m. on Monday, October 26, 2026 " +
    "(America/Chicago).]";
const NOTE_NEXT_DAY = "[It is 4:30 a.m. on Tuesday, October 27, 2026 " +
    "(America/Chicago).]";

function settings(overrides = {}) {
    return {
        message_prefix: {
            enabled: true,
            timezone: ZONE,
            gap_sentence: true,
            ...overrides,
        },
    };
}

function user(content) {
    return { role: "user", content };
}

function assistant(content) {
    return { role: "assistant", content };
}

function openLog() {
    return openDecisionLog(":memory:", { log_prompts: false });
}

function fakeTracer() {
    const notes = [];

    return { notes, tracer: { note: (detail) => notes.push(detail) } };
}

/**
 * Runs one request through the prefix as the chat route does: the
 * conversation is read, then the body is stamped.
 */
async function stamp(body, options) {
    const conversation = readConversation(body);

    const result = await applyMessagePrefix(body, conversation, {
        config: options.config ?? settings(),
        log: options.log ?? null,
        receivedAt: options.receivedAt,
        tracer: options.tracer,
    });

    return { result, messages: body.messages };
}

Deno.test("prefix — off, nothing is touched", async () => {
    const body = { messages: [user("hello")] };

    const { result, messages } = await stamp(body, {
        config: settings({ enabled: false }),
        receivedAt: FIRST_AT,
    });

    assertEquals(result, null);
    assertEquals(messages, [user("hello")]);
});

Deno.test({
    name: "prefix — a first request stamps the arrival on every message",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();
        const body = {
            messages: [user("hello"), assistant("hi"), user("how are you")],
        };

        const { result, messages } = await stamp(body, {
            log,
            receivedAt: FIRST_AT,
        });

        assertEquals(result, { gapHours: null });
        assertEquals(messages, [
            { role: "system", content: EXPLAINER },
            user(`${NOTE_FIRST} hello`),
            assistant("hi"),
            user(`${NOTE_FIRST} how are you`),
        ]);

        log.flush();

        const key = await log.hashPrompt("hello");

        assertEquals(log.findFirstSeen(key).size, 2);

        log.close();
    },
});

Deno.test({
    name: "prefix — a resume keeps each earlier time and names the gap",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();

        await stamp({ messages: [user("hello")] }, {
            log,
            receivedAt: FIRST_AT,
        });

        await stamp({
            messages: [user("hello"), assistant("hi"), user("any news")],
        }, { log, receivedAt: NEXT_DAY_AT });

        log.flush();

        const third = {
            messages: [
                user("hello"),
                assistant("hi"),
                user("any news"),
                assistant("none"),
                user("still none?"),
            ],
        };

        const { result, messages } = await stamp(third, {
            log,
            receivedAt: TWELVE_DAYS_AT,
        });

        assertEquals(result, { gapHours: 288 });
        assertEquals(messages[1].content, `${NOTE_FIRST} hello`);
        assertEquals(messages[3].content, `${NOTE_NEXT_DAY} any news`);
        assertEquals(
            messages[5].content,
            "[It is 3:30 a.m. on Sunday, November 8, 2026 " +
                "(America/Chicago). This conversation resumed after " +
                "12 days away.] still none?",
        );

        log.close();
    },
});

Deno.test({
    name: "prefix — the gap sentence can be turned off",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();

        await stamp({ messages: [user("hello")] }, {
            log,
            receivedAt: FIRST_AT,
        });

        log.flush();

        const { result, messages } = await stamp({
            messages: [user("hello"), assistant("hi"), user("any news")],
        }, {
            log,
            config: settings({ gap_sentence: false }),
            receivedAt: NEXT_DAY_AT,
        });

        assertEquals(result, { gapHours: null });
        assertEquals(messages[3].content, `${NOTE_NEXT_DAY} any news`);

        log.close();
    },
});

Deno.test({
    name: "prefix — the hash is of the text as the client sent it",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();
        const body = { messages: [user("/coder what is this")] };

        //  As the chat route does: read, strip, then stamp.
        const conversation = readConversation(body);

        body.messages[0].content = "what is this";

        await applyMessagePrefix(body, conversation, {
            config: settings(),
            log,
            receivedAt: FIRST_AT,
        });

        assertEquals(body.messages[1].content, `${NOTE_FIRST} what is this`);

        log.flush();

        //  Next turn the client sends its own copy, command and all,
        //  and the first time is found under it.
        const { messages } = await stamp({
            messages: [
                user("/coder what is this"),
                assistant("a cat"),
                user("ok"),
            ],
        }, { log, receivedAt: NEXT_DAY_AT });

        assertEquals(
            messages[1].content,
            `${NOTE_FIRST} /coder what is this`,
        );

        log.close();
    },
});

Deno.test({
    name: "prefix — parts keep their image and the note takes the text",
    sanitizeResources: false,
    fn: async () => {
        const log = await openLog();
        const image = { type: "image_url", image_url: { url: "data:x" } };

        const { messages } = await stamp({
            messages: [
                user([{ type: "text", text: "what is this" }, image]),
                assistant("a cat"),
                user([image]),
            ],
        }, { log, receivedAt: FIRST_AT });

        assertEquals(messages[1].content, [
            { type: "text", text: `${NOTE_FIRST} what is this` },
            image,
        ]);

        //  An image alone gets a text part, so the note is read.
        assertEquals(messages[3].content, [
            { type: "text", text: NOTE_FIRST },
            image,
        ]);

        log.close();
    },
});

Deno.test("prefix — with no log, every note is the arrival", async () => {
    const { notes, tracer } = fakeTracer();

    const { result, messages } = await stamp({
        messages: [user("hello"), assistant("hi"), user("any news")],
    }, { receivedAt: NEXT_DAY_AT, tracer });

    assertEquals(result, { gapHours: null });
    assertEquals(messages[1].content, `${NOTE_NEXT_DAY} hello`);
    assertEquals(messages[3].content, `${NOTE_NEXT_DAY} any news`);
    assertMatch(notes[0], /unavailable \(no decision log\)/);
    assertMatch(notes[1], /zone=America\/Chicago messages=2 new=0 gap=none/);
});

Deno.test("prefix — the explainer joins a system prompt", async () => {
    const { messages } = await stamp({
        messages: [
            { role: "system", content: "Be brief.\n\nYou are a helper." },
            user("hello"),
        ],
    }, { receivedAt: FIRST_AT });

    assertEquals(messages.length, 2);
    assertEquals(
        messages[0].content,
        `Be brief.\n\nYou are a helper.\n\n${EXPLAINER}`,
    );
});

Deno.test("prefix — no user message, nothing to stamp", async () => {
    const body = { messages: [{ role: "system", content: "Be brief." }] };

    const { result, messages } = await stamp(body, { receivedAt: FIRST_AT });

    assertEquals(result, null);
    assertEquals(messages, [{ role: "system", content: "Be brief." }]);
});
