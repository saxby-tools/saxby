import { assert, assertEquals } from "@std/assert";
import { TAGS } from "@saxby/core";
import { suggestCapabilities } from "./defaults.js";

//  =====================================================================
//  Requirement tags never come from a name
//  =====================================================================
//  A family name covers sizes with and without vision or audio, so the
//  curated defaults must never suggest TAG_VISION or TAG_AUDIO.
//  `config generate` adds them from what the backend reports.

const REQUIREMENTS = [TAGS.VISION, TAGS.AUDIO];

const NAMES = [
    "gemma4:31b",
    "gemma4:e4b",
    "gemma3:1b",
    "mistral-small:24b",
    "mistral-small3.2:24b",
    "devstral-small-2:24b",
    "qwen3-coder-next:latest",
    "llama3.2:3b",
];

for (const name of NAMES) {
    Deno.test(`${name} gets no requirement tags from its name`, () => {
        const { tags } = suggestCapabilities(name);

        for (const requirement of REQUIREMENTS) {
            assert(
                !tags.includes(requirement),
                `${name} was given ${requirement}`,
            );
        }
    });
}

Deno.test("family patterns keep their preference tags", () => {
    assertEquals(suggestCapabilities("gemma4:31b").tags, []);
    assertEquals(suggestCapabilities("mistral-small3.2:24b").tags, [
        TAGS.DATA,
    ]);
});

//  =====================================================================
//  TAG_REASONING reaches reasoning specialists only
//  =====================================================================
//  A preference tag that several models claim stops telling them
//  apart, so a generalist name must not suggest TAG_REASONING. A
//  generalist that should take reasoning work gets the tag by hand.

const GENERALISTS = [
    "gemma4:31b",
    "llama3.2:3b",
    "mistral:7b",
];

const REASONING_SPECIALISTS = [
    "deepseek-r1:8b",
    "qwq:32b",
    "mathstral:7b",
];

for (const name of GENERALISTS) {
    Deno.test(`${name} gets no TAG_REASONING from its name`, () => {
        const { tags } = suggestCapabilities(name);

        assert(
            !tags.includes(TAGS.REASONING),
            `${name} was given ${TAGS.REASONING}`,
        );
    });
}

for (const name of REASONING_SPECIALISTS) {
    Deno.test(`${name} keeps TAG_REASONING`, () => {
        const { tags } = suggestCapabilities(name);

        assert(
            tags.includes(TAGS.REASONING),
            `${name} was not given ${TAGS.REASONING}`,
        );
    });
}
