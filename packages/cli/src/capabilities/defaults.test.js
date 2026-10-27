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
    assertEquals(suggestCapabilities("gemma4:31b").tags, [TAGS.REASONING]);
    assertEquals(suggestCapabilities("mistral-small3.2:24b").tags, [
        TAGS.DATA,
    ]);
});
