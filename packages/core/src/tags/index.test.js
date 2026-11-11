import { assert, assertEquals } from "@std/assert";
import { TAGS, validateTagContract } from "./index.js";

//  Removed from the vocabulary on Nov. 10, 2026. A config written
//  before that may still claim them; the contract check must treat
//  the claim as one more tag nothing emits, never as a crash.
const DROPPED_CATALOG_TAG = "TAG_WRITER";
const DROPPED_PERSONA_TAG = "TAG_LONG_CONTEXT";

function configClaiming(capabilities, personaTags = []) {
    return {
        catalog: { model: { capabilities } },
        personas: { persona: { tags: personaTags } },
    };
}

function mentions(warnings, text) {
    return warnings.some((warning) => warning.includes(text));
}

Deno.test("contract — an unknown tag warns as a typo", () => {
    const warnings = validateTagContract(
        configClaiming([TAGS.CODER, TAGS.BACKGROUND, "TAG_CODR"]),
    );

    assert(mentions(warnings, "'TAG_CODR' is claimed"));
    assert(mentions(warnings, "Check for a typo"));
});

Deno.test("contract — a dropped tag warns as never emitted", () => {
    const warnings = validateTagContract(
        configClaiming(
            [TAGS.CODER, TAGS.BACKGROUND, DROPPED_CATALOG_TAG],
            [DROPPED_PERSONA_TAG],
        ),
    );

    assert(mentions(warnings, `'${DROPPED_CATALOG_TAG}' is claimed`));
    assert(mentions(warnings, `'${DROPPED_PERSONA_TAG}' is claimed`));
    assert(!mentions(warnings, "reserved"));
});

Deno.test("contract — unemitted claims alone leave Tier 2 idle", () => {
    const warnings = validateTagContract(
        configClaiming([DROPPED_CATALOG_TAG], [DROPPED_PERSONA_TAG]),
    );

    assert(mentions(warnings, "Tier 2 routing is disabled"));
});

Deno.test("contract — a healthy config has no warnings", () => {
    const warnings = validateTagContract(
        configClaiming([TAGS.CODER, TAGS.BACKGROUND]),
    );

    assertEquals(warnings, []);
});
