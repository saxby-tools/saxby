import { assert, assertEquals } from "@std/assert";
import { TAGS, validateTagContract } from "./index.js";

function configClaiming(capabilities, personaTags = []) {
    return {
        catalog: { model: { capabilities } },
        personas: { persona: { tags: personaTags } },
    };
}

function mentions(warnings, text) {
    return warnings.some((warning) => warning.includes(text));
}

Deno.test("contract — a reserved tag warns as reserved, not a typo", () => {
    const warnings = validateTagContract(
        configClaiming([TAGS.CODER, TAGS.BACKGROUND, TAGS.WRITER]),
    );

    assert(mentions(warnings, "'TAG_WRITER' is reserved"));
    assert(!mentions(warnings, "Check for a typo"));
});

Deno.test("contract — an unknown tag warns as a typo", () => {
    const warnings = validateTagContract(
        configClaiming([TAGS.CODER, TAGS.BACKGROUND, "TAG_CODR"]),
    );

    assert(mentions(warnings, "'TAG_CODR' is claimed"));
    assert(mentions(warnings, "Check for a typo"));
});

Deno.test("contract — reserved claims alone leave Tier 2 idle", () => {
    const warnings = validateTagContract(
        configClaiming([TAGS.WRITER], [TAGS.LONG_CONTEXT]),
    );

    assert(mentions(warnings, "Tier 2 routing is disabled"));
});

Deno.test("contract — a healthy config has no warnings", () => {
    const warnings = validateTagContract(
        configClaiming([TAGS.CODER, TAGS.BACKGROUND]),
    );

    assertEquals(warnings, []);
});
