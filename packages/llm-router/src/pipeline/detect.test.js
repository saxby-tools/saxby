//  =====================================================================
//  Tier 2 detector cases
//  =====================================================================
//  These tables are the documentation. Coming back in six months, read
//  the CASES — not the patterns. Each row states an intent in plain
//  terms; the `no` rows encode edge cases already reasoned about, so a
//  "simplifying" refactor that breaks one fails loudly.
//
//  Every case below was executed against the real @lezer/markdown +
//  Regex+ stack and passes.
//
//  Run:  deno test packages/llm-router/src/router/pipeline/

import { assert, assertEquals } from "@std/assert";
import { extractFeatures } from "./detect.js";

//  ---------------------------------------------------------------------
//  Helpers
//  ---------------------------------------------------------------------

function has(text, name) {
    const { features } = extractFeatures(text);

    return Object.hasOwn(features, name);
}

function evidence(text, name) {
    const { features } = extractFeatures(text);

    return features[name];
}

function runTable(name, cases) {
    Deno.test(name, async (t) => {
        for (const c of cases) {
            const label = `${c.yes ? "yes" : "no "} — ${c.why}`;

            await t.step(label, () => {
                assertEquals(has(c.text, name), c.yes);
            });
        }
    });
}

//  ---------------------------------------------------------------------
//  fencedCode — delegated to the parser
//  ---------------------------------------------------------------------
//  The closing-fence rule (same char, length >= opener, unclosed runs
//  to EOF) is why this is a parser's job. A hand-rolled scanner got
//  the three-space-indent case wrong on the first attempt.

runTable("fencedCode", [
    { yes: true, why: "plain triple fence", text: "```\nx = 1\n```" },
    { yes: true, why: "language tag", text: "```js\nx = 1\n```" },
    { yes: true, why: "tilde fence", text: "~~~\nx = 1\n~~~" },
    {
        yes: true,
        why: "three spaces of indent still opens a fence",
        text: "   ```\nx\n   ```",
    },
    {
        yes: true,
        why: "unclosed fence runs to end of document",
        text: "```js\nx = 1",
    },
    { yes: false, why: "single backticks are inline", text: "call `f()`" },
    { yes: false, why: "prose with no fence", text: "explain closures" },
]);

Deno.test("fencedCode — lang is captured for free", () => {
    const found = evidence("```js\nconst x = 1;\n```", "fencedCode");

    assertEquals(found.count, 1);
    assertEquals(found.langs, ["js"]);
});

//  ---------------------------------------------------------------------
//  filePaths — owned, and the highest-value routing signal
//  ---------------------------------------------------------------------

runTable("filePaths", [
    { yes: true, why: "relative path", text: "check ./utils.js please" },
    { yes: true, why: "nested source path", text: "src/main.js is broken" },
    { yes: true, why: "bare known extension", text: "Button.tsx renders" },
    { yes: true, why: "home-relative dotfile dir", text: "~/.config/saxby" },
    { yes: true, why: "absolute path", text: "/etc/hosts got clobbered" },
    { yes: false, why: "latin abbreviation", text: "e.g. this should not" },
    { yes: false, why: "bare domain is not a path", text: "see example.com" },
    { yes: false, why: "sentence-ending period", text: "that is all. done" },
    { yes: false, why: "plain prose", text: "summarise this article" },
]);

Deno.test("filePaths — distinct count drives multi-file routing", () => {
    const single = "refactor src/main.js";
    const multi = "move code from src/main.js into src/lib/util.js";

    assertEquals(evidence(single, "filePaths").count, 1);
    assertEquals(evidence(multi, "filePaths").count, 2);
});

Deno.test("filePaths — repeats collapse to one", () => {
    const text = "src/main.js imports src/main.js again";

    assertEquals(evidence(text, "filePaths").count, 1);
});

//  ---------------------------------------------------------------------
//  math — owned, and the currency trap
//  ---------------------------------------------------------------------
//  Lezer ships no math extension, and micromark's DID read
//  "$5 and $10" as inline math. Single-dollar is deliberately
//  unsupported: currency is far more common in prompts than LaTeX.

runTable("math", [
    { yes: true, why: "block math", text: "solve:\n\n$$\nx^2\n$$" },
    { yes: true, why: "double-dollar inline", text: "given $$x^2$$ solve" },
    { yes: true, why: "latex environment", text: "\\begin{equation}" },
    { yes: true, why: "bare macro", text: "use \\frac{1}{2} here" },
    { yes: false, why: "two currency amounts", text: "it cost $5 and $10" },
    { yes: false, why: "single dollar is unsupported", text: "given $x$ ok" },
]);

//  ---------------------------------------------------------------------
//  Masking — the cross-detector guarantee
//  ---------------------------------------------------------------------
//  Content inside a code or math span must not leak into prose
//  detectors. This is the invariant most likely to break in a future
//  refactor, so it is asserted directly rather than implied.

Deno.test("masking — shell $ inside a fence is not math", () => {
    assertEquals(has("```sh\n$ deno task dev\n```", "math"), false);
});

Deno.test("masking — paths in prose vs total are tracked apart", () => {
    const text = 'see src/a.js\n\n```js\nimport "./b.js";\n```';
    const found = evidence(text, "filePaths");

    //  Both counted, but prose-only is what the user actually named.
    assertEquals(found.count, 2);
    assertEquals(found.proseCount, 1);
});

//  ---------------------------------------------------------------------
//  Strong debug signals — owned
//  ---------------------------------------------------------------------

runTable("diff", [
    { yes: true, why: "unified hunk header", text: "@@ -1,7 +1,9 @@\n-a\n+b" },
    { yes: true, why: "file markers", text: "--- a/file.js\n+++ b/file.js" },
    { yes: false, why: "thematic break is not a diff", text: "---\n\nprose" },
    { yes: false, why: "two dashes", text: "-- nope" },
]);

runTable("stackTrace", [
    {
        yes: true,
        why: "python traceback",
        text: 'Traceback (most recent call last):\n  File "a.py", line 4',
    },
    {
        yes: true,
        why: "node frame",
        text: "TypeError: x is not a function\n    at f (/a/b.js:1:2)",
    },
    {
        yes: false,
        why: "prose about errors is not a trace",
        text: "I keep getting an error when I run the build",
    },
]);

//  ---------------------------------------------------------------------
//  json — owned
//  ---------------------------------------------------------------------

runTable("json", [
    { yes: true, why: "whole payload parses", text: '{"model":"x"}' },
    { yes: true, why: "array payload", text: '[{"a":1}]' },
    { yes: false, why: "js object literal is not json", text: "{ model: 1 }" },
    { yes: false, why: "prose", text: "explain json to me" },
]);

//  A JSON array also trips `links`, because the parser reads [ ] as
//  link syntax. Harmless — links is a weak signal and json is the
//  authoritative one here — but asserted so it is a known property
//  rather than a surprise during log analysis.
Deno.test("json — array payload also reads as a link", () => {
    assertEquals(has('[{"a":1}]', "json"), true);
    assertEquals(has('[{"a":1}]', "links"), true);
});

//  ---------------------------------------------------------------------
//  Tabular — markdown tables from the parser, raw pastes owned
//  ---------------------------------------------------------------------

Deno.test("table — gfm table is parsed with a column count", () => {
    const text = "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |";
    const found = evidence(text, "table");

    assertEquals(found.count, 1);
    assertEquals(found.columns, 3);
});

Deno.test("tabular — consistent csv columns", () => {
    const text = "a,b,c\n1,2,3\n4,5,6\n7,8,9";

    assertEquals(evidence(text, "tabular").kind, "delimited");
});

Deno.test("tabular — prose with commas is not tabular", () => {
    const text = "I like apples, pears, and plums in my lunch";

    assertEquals(has(text, "tabular"), false);
});

//  A pipe-delimited markdown table fires BOTH `table` (parser) and
//  `tabular` (delimiter run). Deliberate under extract-broadly, and
//  asserted so the double-fire is known rather than surprising.
Deno.test("tabular — markdown table also reads as delimited", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |";

    assertEquals(has(text, "table"), true);
    assertEquals(has(text, "tabular"), true);
});

//  ---------------------------------------------------------------------
//  Prompt scaffolding — weak, English-dependent
//  ---------------------------------------------------------------------

Deno.test("scaffolding — pseudo-xml tags are captured", () => {
    const found = evidence("<context>stuff</context> help", "scaffolding");

    assertEquals(found.kind, "pseudo-xml");
    assertEquals(found.tags, ["context"]);
});

runTable("sectionHeaders", [
    { yes: true, why: "system header", text: "System: you are helpful" },
    { yes: true, why: "markdown heading form", text: "### Instructions:" },
    { yes: false, why: "unrelated label", text: "Note: whatever" },
    { yes: false, why: "word and colon on separate lines", text: "Task\n:" },
]);

//  Regression: the section-header pattern backtracked catastrophically
//  across a masked code block, taking 2.7 seconds on a 10k-character
//  prompt and blocking every other request. Now ~3 ms; the bound is
//  generous so a slow CI runner cannot flake it.
const LARGE_CODE_PROMPT = "Here is some context. ".repeat(200) +
    "\n```py\n" + "def f(x):\n    return x * 2\n".repeat(200) + "```\n";

Deno.test("performance — a large code prompt extracts quickly", () => {
    const started = performance.now();

    extractFeatures(LARGE_CODE_PROMPT);

    const elapsed = performance.now() - started;

    assert(elapsed < 250, `took ${elapsed.toFixed(0)} ms`);
});

//  Regression: the file-path lookahead scanned to the next whitespace
//  from every candidate start, and minified JSON has none — quadratic,
//  834 ms for 37k characters. Now well under 1 ms.
const LARGE_JSON_PROMPT = JSON.stringify({
    rows: Array.from({ length: 2000 }, (_, i) => ({ i, s: "x" })),
});

Deno.test("performance — a large JSON payload extracts quickly", () => {
    const started = performance.now();

    extractFeatures(LARGE_JSON_PROMPT);

    const elapsed = performance.now() - started;

    assert(elapsed < 250, `took ${elapsed.toFixed(0)} ms`);
});

//  ---------------------------------------------------------------------
//  Broad extraction — markdown structure captured but not yet routed
//  on. Logged now so the archive can answer questions later.
//  ---------------------------------------------------------------------

Deno.test("lists — task items are counted", () => {
    const found = evidence("- [ ] todo\n- [x] done", "lists");

    assertEquals(found.count, 1);
    assertEquals(found.taskItems, 2);
});

Deno.test("lists — ordered lists are distinguished", () => {
    const found = evidence("1. one\n2. two", "lists");

    assertEquals(found.count, 1);
    assertEquals(found.ordered, 1);
});

Deno.test("headings — depth is recorded", () => {
    const found = evidence("## Section\n\nprose", "headings");

    assertEquals(found.count, 1);
    assertEquals(found.minDepth, 2);
});

Deno.test("blockquote — captured", () => {
    assertEquals(evidence("> quoted text", "blockquote").count, 1);
});

//  ---------------------------------------------------------------------
//  Metrics
//  ---------------------------------------------------------------------

Deno.test("metrics — code is charged a denser token rate", () => {
    const prose = "a".repeat(300);
    const code = "```\n" + "a".repeat(300) + "\n```";

    const proseTokens = extractFeatures(prose).metrics.estimatedTokens;
    const codeTokens = extractFeatures(code).metrics.estimatedTokens;

    //  Same character volume, but fenced content estimates higher.
    assertEquals(codeTokens > proseTokens, true);
});

Deno.test("metrics — empty input is safe", () => {
    const result = extractFeatures("");

    assertEquals(result.metrics.chars, 0);
    assertEquals(result.metrics.codeRatio, 0);
    assertEquals(Object.keys(result.features).length, 0);
});

Deno.test("histogram — node shape is summarised, not stored", () => {
    const result = extractFeatures("```js\nx\n```");

    //  Lezer node names, kept as a queryable shape summary only.
    assertEquals(result.histogram.FencedCode, 1);
    assertEquals(Object.hasOwn(result, "tree"), false);
});
