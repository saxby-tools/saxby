//  =====================================================================
//  Intent extraction cases
//  =====================================================================
//  The background-task rows here are a regression guard. Open WebUI's
//  title, tag and follow-up generators send non-streaming requests
//  whose prompts contain headings, lists and example file paths. Those
//  belong to the TEMPLATE, not the user — reading intent from them
//  sent a follow-up generator to a 51GB coding model.

import { assert, assertEquals } from "@std/assert";
import { extractIntent } from "./extract.js";
import { EMITTABLE_TAGS } from "@shuntd/core";

const CONFIG = {
    personas: {
        coder: { default_model: "coder-model", tags: ["TAG_CODER"] },
    },
};

function ask(content, extra = {}) {
    return extractIntent(
        { model: "shuntd", messages: [{ role: "user", content }], ...extra },
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
            model: "shuntd",
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
        ask('{"name": "shuntd", "tags": [1, 2, 3]}'),
        ask("$$x^2 + y^2 = z^2$$"),
        ask("Generate a title", { stream: false }),
        extractIntent({
            model: "shuntd",
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
