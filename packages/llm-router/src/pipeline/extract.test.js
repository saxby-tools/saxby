//  =====================================================================
//  Intent extraction cases
//  =====================================================================
//  The background-task rows here are a regression guard. Open WebUI's
//  title, tag and follow-up generators send non-streaming requests
//  whose prompts contain headings, lists and example file paths. Those
//  belong to the TEMPLATE, not the user — reading intent from them
//  sent a follow-up generator to a 51GB coding model.

import { assert, assertEquals } from "@std/assert";
import { extractIntent, replaceMessageText } from "./extract.js";
import { EMITTABLE_TAGS } from "@saxby/core";

const CONFIG = {
    personas: {
        coder: { default_model: "coder-model", tags: ["TAG_CODER"] },
    },
};

function ask(content, extra = {}) {
    return extractIntent(
        { model: "saxby", messages: [{ role: "user", content }], ...extra },
        CONFIG,
    );
}

//  ---------------------------------------------------------------------
//  Background tasks
//  ---------------------------------------------------------------------

Deno.test("background — explicit stream:false is sufficient", () => {
    const result = ask("Generate a title", { stream: false });

    assertEquals(result.tags, ["TAG_BACKGROUND"]);
});

Deno.test("background — template structure never leaks through", () => {
    //  Shaped like a real Open WebUI follow-up prompt.
    const prompt = "### Task\n" +
        "Suggest follow-ups.\n\n" +
        "- review src/main.js\n" +
        "- explain app/util.js\n\n" +
        "<chat_history>hello</chat_history>";

    const result = ask(prompt, { stream: false });

    //  Would have been [TAG_CODER, TAG_MULTI_FILE, TAG_BACKGROUND].
    assertEquals(result.tags, ["TAG_BACKGROUND"]);
});

Deno.test("background — a streaming turn is never a background task", () => {
    const result = ask("hello", { stream: true });

    assert(!result.tags.includes("TAG_BACKGROUND"));
});

Deno.test("background — an omitted stream field is not background", () => {
    //  curl and scripts routinely omit it; only an EXPLICIT false
    //  counts, or every ad-hoc request gets misfiled.
    const result = ask("refactor src/main.js");

    assert(!result.tags.includes("TAG_BACKGROUND"));
});

//  Regression: the short-circuit used to return BACKGROUND alone,
//  dropping requirements that were already gathered.
function askWithParts(parts, extra = {}) {
    return extractIntent(
        {
            model: "saxby",
            messages: [{
                role: "user",
                content: [{ type: "text", text: "describe this" }, ...parts],
            }],
            ...extra,
        },
        CONFIG,
    );
}

Deno.test("background — an image keeps its vision requirement", () => {
    const image = { type: "image_url", image_url: { url: "data:," } };
    const result = askWithParts([image], { stream: false });

    assertEquals(result.tags, ["TAG_VISION", "TAG_BACKGROUND"]);
});

Deno.test("background — audio keeps its audio requirement", () => {
    const audio = { type: "input_audio", input_audio: { data: "" } };
    const result = askWithParts([audio], { stream: false });

    assertEquals(result.tags, ["TAG_AUDIO", "TAG_BACKGROUND"]);
});

//  ---------------------------------------------------------------------
//  Normal extraction still works
//  ---------------------------------------------------------------------

Deno.test("streaming — a code fence still tags coder", () => {
    const result = ask("review\n```js\nx=1\n```", { stream: true });

    assert(result.tags.includes("TAG_CODER"));
});

Deno.test("override — a slash command is stripped from the prompt", () => {
    const result = ask("/coder write a parser", { stream: true });

    assertEquals(result.override, "coder");
    assertEquals(result.cleanPrompt, "write a parser");
});

//  ---------------------------------------------------------------------
//  Tag contract
//  ---------------------------------------------------------------------
//  EMITTABLE_TAGS in core is a hand-written list of what this file
//  emits. The boot-time contract check trusts it, so if the two drift
//  a config can claim a tag that never fires, with no warning. One
//  request per tag; the union must equal the list exactly.

Deno.test("contract — EMITTABLE_TAGS is exactly what extract emits", () => {
    const traceback = [
        "Traceback (most recent call last):",
        '  File "app.py", line 3, in <module>',
        "    main()",
        "ValueError: bad input",
    ].join("\n");

    const results = [
        ask("```js\nconst x = 1;\n```"),
        ask("move the parser out of app/alpha.js into app/beta.js"),
        ask(traceback),
        ask('{"name": "saxby", "tags": [1, 2, 3]}'),
        ask("$$x^2 + y^2 = z^2$$"),
        ask("Generate a title", { stream: false }),
        extractIntent({
            model: "saxby",
            messages: [{
                role: "user",
                content: [
                    { type: "image_url", image_url: { url: "data:," } },
                    { type: "input_audio", input_audio: { data: "" } },
                ],
            }],
        }, CONFIG),
    ];

    const emitted = new Set(results.flatMap((result) => result.tags));

    assertEquals([...emitted].sort(), [...EMITTABLE_TAGS].sort());
});

//  ---------------------------------------------------------------------
//  Payload weight
//  ---------------------------------------------------------------------
//  The estimate drives the context-fit check in selectModel. It once
//  counted the latest user turn twice, so the same text weighed
//  double as a question and single as a system prompt.

const PROSE = "x ".repeat(4000);

Deno.test("weight — the current turn is counted once", () => {
    const result = ask(PROSE);

    assertEquals(result.metrics.estimatedTokens, 2000);
});

Deno.test("weight — the same text weighs the same anywhere", () => {
    const asQuestion = ask(PROSE).metrics.estimatedTokens;

    const asSystem = extractIntent({
        model: "saxby",
        messages: [
            { role: "system", content: PROSE },
            { role: "user", content: "" },
        ],
    }, CONFIG).metrics.estimatedTokens;

    assertEquals(asQuestion, asSystem);
});

//  ---------------------------------------------------------------------
//  Rewriting a message's text
//  ---------------------------------------------------------------------
//  The /command strip writes the clean prompt back into the message.
//  A message that arrived as parts must keep its images and audio, or
//  a `/coder` prompt with a screenshot reaches the model blind.

Deno.test("replace — a string is replaced whole", () => {
    assertEquals(replaceMessageText("/coder fix it", "fix it"), "fix it");
});

Deno.test("replace — parts keep their image and get the new text", () => {
    const image = { type: "image_url", image_url: { url: "data:x" } };
    const parts = [{ type: "text", text: "/coder what is this" }, image];

    const result = replaceMessageText(parts, "what is this");

    assertEquals(result, [{ type: "text", text: "what is this" }, image]);
});

Deno.test("replace — several text parts collapse to one", () => {
    const image = { type: "image_url", image_url: { url: "data:x" } };
    const parts = [
        { type: "text", text: "/coder" },
        image,
        { type: "text", text: "what is this" },
    ];

    const result = replaceMessageText(parts, "what is this");

    assertEquals(result, [{ type: "text", text: "what is this" }, image]);
});

Deno.test("replace — content of another shape is left alone", () => {
    assertEquals(replaceMessageText(null, "x"), null);
    assertEquals(replaceMessageText(42, "x"), 42);
});

//  Agent clients send every tool's JSON schema with every request,
//  and a prior turn that was a tool call keeps its name and arguments
//  outside `content`. Neither was counted, and est_tokens ran a third
//  under Ollama's prompt_tokens on agent payloads (#46). Both are
//  JSON, so both are charged at the code rate.

const TOOLS = [{
    type: "function",
    function: {
        name: "read_file",
        description: "Reads one file from the workspace.",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        },
    },
}];

Deno.test("weight — tool schemas add to the estimate", () => {
    const bare = ask(PROSE).metrics.estimatedTokens;
    const withTools = ask(PROSE, { tools: TOOLS }).metrics.estimatedTokens;

    assert(withTools > bare);
});

Deno.test("weight — a tool call with empty content is not empty", () => {
    //  300 characters of arguments plus a 9-character name, at three
    //  characters per token: 103, with nothing else in the payload.
    const args = JSON.stringify({ path: "a".repeat(289) });

    assertEquals(args.length, 300);

    const result = extractIntent({
        model: "saxby",
        messages: [
            {
                role: "assistant",
                content: "",
                tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: args },
                }],
            },
            { role: "user", content: "" },
        ],
    }, CONFIG);

    assertEquals(result.metrics.estimatedTokens, 103);
});

Deno.test("weight — tools that are not an array are ignored", () => {
    const bare = ask(PROSE).metrics.estimatedTokens;

    for (const tools of ["read_file", 7, { name: "read_file" }, null]) {
        const result = ask(PROSE, { tools });

        assertEquals(result.metrics.estimatedTokens, bare);
    }
});
