//  =====================================================================
//  Structural feature extraction
//  =====================================================================
//  Two sources, one output vocabulary.
//
//    1. Markdown structure comes from @lezer/markdown — the parser
//       behind CodeMirror 6. CommonMark is a real spec with real edge
//       cases (the closing-fence rule alone is not expressible as a
//       regex), so that is a maintained wheel worth taking.
//    2. Everything markdown has no opinion about (file paths, diff
//       hunks, stack traces, raw delimited data, math, prompt
//       scaffolding) stays owned, written with Regex+.
//
//  Lezer node names NEVER leave this file. Everything is normalised
//  into our own feature names immediately, so the router core does not
//  couple to a third-party tree and the parser stays swappable. That
//  seam is what made the mdast -> Lezer port a one-file change.
//
//  Policy: extract broadly, store narrowly. This returns derived
//  booleans, counts and a node histogram — never the tree itself.
//
//  deno.json imports needed:
//    "regex":            "npm:regex@^6.1.0"
//    "@lezer/markdown":  "npm:@lezer/markdown@^1.7.2"

import { regex } from "regex";
import { GFM, parser } from "@lezer/markdown";

//  ---------------------------------------------------------------------
//  Constants
//  ---------------------------------------------------------------------

//  Configured once at module load, not per request.
const MARKDOWN = parser.configure(GFM);

//  Extensions trusted as a path signal WITHOUT a directory separator.
//  Keeps "Button.tsx", rejects "example.com".
const KNOWN_CODE_EXTENSIONS = new Set([
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "tsx",
    "json",
    "jsonc",
    "php",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "lua",
    "vim",
    "sh",
    "bash",
    "zsh",
    "fish",
    "sql",
    "html",
    "css",
    "scss",
    "sass",
    "less",
    "vue",
    "svelte",
    "yml",
    "yaml",
    "toml",
    "ini",
    "conf",
    "env",
    "lock",
    "md",
    "mdx",
    "txt",
    "csv",
    "tsv",
    "xml",
    "svg",
    "dockerfile",
    "makefile",
]);

//  Pseudo-XML wrappers used by prompt-engineering-aware users.
const SCAFFOLD_TAGS = new Set([
    "context",
    "instruction",
    "instructions",
    "task",
    "system",
    "example",
    "examples",
    "document",
    "documents",
    "input",
    "output",
    "thinking",
    "answer",
]);

//  Lezer heading node names, mapped to depth.
const HEADING_DEPTHS = {
    ATXHeading1: 1,
    ATXHeading2: 2,
    ATXHeading3: 3,
    ATXHeading4: 4,
    ATXHeading5: 5,
    ATXHeading6: 6,
    SetextHeading1: 1,
    SetextHeading2: 2,
};

//  Minimum consecutive lines sharing a delimiter count before we call
//  something tabular. Two lines is coincidence; three is a shape.
const TABULAR_MIN_ROWS = 3;

//  Candidate delimiters for raw (non-markdown) tabular sniffing.
const TABULAR_DELIMITERS = ["\t", ",", ";", "|"];

//  Rough chars-per-token. Code is denser than prose (symbols, short
//  identifiers), so it gets its own divisor. Deliberately pessimistic:
//  over-estimating tokens falls back a model early, which is the safe
//  direction to be wrong.
const CHARS_PER_TOKEN_PROSE = 4;
const CHARS_PER_TOKEN_CODE = 3;

//  ---------------------------------------------------------------------
//  Patterns
//  ---------------------------------------------------------------------
//  Written with Regex+ (`regex` tag): free spacing, # comments, named
//  capture only, subroutines via \g<name>, always-on v flag.
//
//  THREE x/v-mode rules, all verified, all SILENT failures:
//    1. A literal space must be \x20 — inside character classes too.
//       [ ] compiles to [] which then never matches anything. Regex+
//       behaves exactly like a naive hand-rolled compiler here.
//    2. Inside a character class, escape / ) - as \/ \) \-
//    3. OUTSIDE a character class, \- is an invalid escape. Use -
//    4. (?(DEFINE) … ) must come LAST in the pattern.
//
//  Every pattern carries match/reject examples. The reject lines are
//  the load-bearing part — they encode edge cases already reasoned
//  about, so a future "simplification" fails loudly.

//  Path-shaped token. The lookahead requires a slash or dot somewhere
//  in the token, which stops every bare word from matching. Extension
//  policy is applied in code afterwards.
//    matches:  src/main.js  ./utils.ts  ~/.config/saxby  Button.tsx
//    rejects:  "e.g. this"  "that is all. done"  bare words
//    deferred: example.com — rejected by the code filter below
const RE_PATH_CANDIDATE = regex("gm")`
    (?<! [\w\/.@\-] )               # left boundary
    (?= [\w.@~\/\-]* [\/.] )        # must contain a slash or a dot
    (?<path>
      (?: \.{1,2}\/ | ~\/ | \/ )?   # optional ./  ../  ~/  /
      (?: \g<seg> \/ )*             # zero or more dir segments
      [\w\-]+                       # basename
      (?: \. (?<ext> [A-Za-z]\w{0,9} ) )?
    )
    (?= $ | [\s\)"'\x60,;:] )       # right boundary
    (?(DEFINE)
      (?<seg> [\w.@\-]+ )
    )
`;

//  Unified-diff hunk header or file markers. Horizontal whitespace
//  only (\x20+, never \s+) so a bare "---" thematic break followed by
//  prose on a later line cannot match.
//    matches:  "@@ -1,7 +1,9 @@"  "--- a/file.js"
//    rejects:  "---\n\nprose"  "-- nope"
const RE_DIFF_HUNK = regex("m")`
    ^ (?:
        @@ \x20 -\d+ (?:,\d+)? \x20 \+\d+ (?:,\d+)? \x20 @@
      | (?: \+\+\+ | --- ) \x20+ [ab]?\/? \S+
    )
`;

//  Runtime stack traces. Emitted by runtimes, not written by humans,
//  so the English tokens here are safe across user languages.
//    matches:  "Traceback (most recent call last):"
//              "    at f (/a/b.js:1:2)"   'File "a.py", line 4'
//              "TypeError: x is not a function"
//    rejects:  "I keep getting an error when I run the build"
const RE_STACK_TRACE = regex("m")`
    (?:
        ^ Traceback \x20 \( most \x20 recent \x20 call \x20 last \)
      | ^ \s+ at \x20 \S .* \( .*? : \d+ : \d+ \)
      | ^ \s* File \x20 " [^"]+ ", \x20 line \x20 \d+
      | ^ \s* \w* (?: Error | Exception ) : \x20 \S
    )
`;

//  LaTeX math. Owned again after the port — Lezer ships no math
//  extension, and micromark's DID read "$5 and $10" as inline math,
//  so single-dollar is deliberately NOT supported here. Currency
//  appears in prompts far more often than inline LaTeX.
//    matches:  $$x^2$$  \begin{equation}  \frac{1}{2}
//    rejects:  "it cost $5 and $10"  "total: $ 20"  "about $100"
const RE_MATH = regex("")`
    (?:
        \$\$ [\s\S]+? \$\$
      | \\begin\{ (?: equation | align | gather | math )
      | \\ (?: frac | sum | int | sqrt | alpha | beta ) \b
    )
`;

//  Explicit prompt section headers.
//  NOTE: English-only by nature. WEAK signal; config-supplied triggers
//  cover other languages.
//    matches:  "System: you are"  "### Instructions:"
//    rejects:  "Note: whatever"
//
//  Horizontal whitespace only, and possessive. This once used \s*,
//  which also matches newlines: a masked code block is hundreds of
//  lines of spaces, and two adjacent \s* runs tried every way to split
//  them at every line start. A 10k-character prompt took 2.7 seconds,
//  blocking every other request. A header never spans lines anyway.
const RE_SECTION_HEADER = regex("im")`
    ^ [\x20\t]*+ \#{0,4}+ [\x20\t]*+
    (?: System | Task | Context | Instructions? | Role | Goal
      | Constraints? | Examples? | Output )
    [\x20\t]*+ :
`;

//  Tag name out of an already-isolated Lezer HTMLTag node.
//    matches:  <context>  </context>  <div
const RE_TAG_NAME = regex("g")`
    < \/?
    (?<name> [A-Za-z][\w:\-]* )
`;

//  ---------------------------------------------------------------------
//  Tree helpers
//  ---------------------------------------------------------------------
//  Lezer yields a cursor, not a plain object graph. One iteration
//  collects everything; node text is sliced from the source by offset
//  rather than read off a `value` property.

function iterateNodes(tree, raw, visit) {
    tree.iterate({
        enter: (node) => {
            visit({
                name: node.name,
                from: node.from,
                to: node.to,
                text: () => raw.slice(node.from, node.to),
            });
        },
    });
}

//  ---------------------------------------------------------------------
//  Input preparation
//  ---------------------------------------------------------------------
//  Code spans are blanked by offset so prose detectors never trip on
//  content the user is showing us rather than asking about. Math is
//  blanked from its own pattern, since Lezer does not parse it.

const MASKED_NODE_NAMES = new Set([
    "FencedCode",
    "CodeBlock",
    "InlineCode",
]);

function blankRange(chars, start, end) {
    for (let i = start; i < end && i < chars.length; i++) {
        //  Preserve newlines so line numbers stay meaningful.
        if (chars[i] === "\n") {
            continue;
        }

        chars[i] = " ";
    }
}

export function prepareInput(text) {
    const raw = typeof text === "string" ? text : "";
    const tree = MARKDOWN.parse(raw);

    const chars = [...raw];
    const histogram = {};
    let codeChars = 0;

    iterateNodes(tree, raw, (node) => {
        histogram[node.name] = (histogram[node.name] || 0) + 1;

        if (node.name === "CodeText") {
            codeChars += node.to - node.from;
        }

        if (!MASKED_NODE_NAMES.has(node.name)) {
            return;
        }

        blankRange(chars, node.from, node.to);
    });

    //  Math spans are masked too, so a $$…$$ block cannot feed the
    //  tabular or path detectors.
    const partial = chars.join("");
    const mathGlobal = new RegExp(RE_MATH.source, "g" + RE_MATH.flags);

    const mathChars = [...partial];

    for (const match of partial.matchAll(mathGlobal)) {
        blankRange(mathChars, match.index, match.index + match[0].length);
    }

    const masked = mathChars.join("");

    return {
        raw,
        tree,
        histogram,
        codeChars,
        masked,
        lines: raw.split("\n"),
        maskedLines: masked.split("\n"),
    };
}

//  ---------------------------------------------------------------------
//  Markdown-derived features
//  ---------------------------------------------------------------------
//  One pass over the tree, normalising Lezer node names into our own
//  vocabulary. Adding a markdown signal means a case here, not a new
//  parser.

function extractMarkdownFeatures(input) {
    const features = {};

    const codeLangs = new Set();
    const headingDepths = [];
    const scaffoldTags = new Set();

    let codeBlocks = 0;
    let inlineCode = 0;
    let tables = 0;
    let tableColumns = 0;
    let headerCells = 0;
    let lists = 0;
    let orderedLists = 0;
    let taskItems = 0;
    let blockquotes = 0;
    let htmlNodes = 0;
    let images = 0;
    let links = 0;

    let inTableHeader = false;
    let tableHeaderEnd = -1;

    iterateNodes(input.tree, input.raw, (node) => {
        if (node.name === "FencedCode") {
            codeBlocks++;
            return;
        }

        if (node.name === "CodeBlock") {
            codeBlocks++;
            return;
        }

        if (node.name === "CodeInfo") {
            codeLangs.add(node.text().trim().toLowerCase());
            return;
        }

        if (node.name === "InlineCode") {
            inlineCode++;
            return;
        }

        if (node.name === "Table") {
            tables++;
            return;
        }

        if (node.name === "TableHeader") {
            inTableHeader = true;
            tableHeaderEnd = node.to;
            headerCells = 0;
            return;
        }

        if (node.name === "TableCell") {
            //  Column count comes from the header row only.
            if (!inTableHeader) {
                return;
            }

            if (node.from > tableHeaderEnd) {
                inTableHeader = false;
                return;
            }

            headerCells++;
            tableColumns = Math.max(tableColumns, headerCells);
            return;
        }

        if (HEADING_DEPTHS[node.name]) {
            headingDepths.push(HEADING_DEPTHS[node.name]);
            return;
        }

        if (node.name === "BulletList") {
            lists++;
            return;
        }

        if (node.name === "OrderedList") {
            lists++;
            orderedLists++;
            return;
        }

        if (node.name === "Task") {
            taskItems++;
            return;
        }

        if (node.name === "Blockquote") {
            blockquotes++;
            return;
        }

        if (node.name === "Image") {
            images++;
            return;
        }

        if (node.name === "Link") {
            links++;
            return;
        }

        if (node.name === "HTMLTag") {
            htmlNodes++;
        }

        if (node.name === "HTMLBlock") {
            htmlNodes++;
        }

        if (node.name !== "HTMLTag") {
            if (node.name !== "HTMLBlock") {
                return;
            }
        }

        for (const match of node.text().matchAll(RE_TAG_NAME)) {
            const name = match.groups.name.toLowerCase();

            if (!SCAFFOLD_TAGS.has(name)) {
                continue;
            }

            scaffoldTags.add(name);
        }
    });

    if (codeBlocks > 0) {
        features.fencedCode = { count: codeBlocks, langs: [...codeLangs] };
    }

    if (inlineCode > 0) {
        features.inlineCode = { count: inlineCode };
    }

    if (tables > 0) {
        features.table = { count: tables, columns: tableColumns };
    }

    if (headingDepths.length > 0) {
        features.headings = {
            count: headingDepths.length,
            minDepth: Math.min(...headingDepths),
        };
    }

    if (lists > 0) {
        features.lists = { count: lists, ordered: orderedLists, taskItems };
    }

    if (blockquotes > 0) {
        features.blockquote = { count: blockquotes };
    }

    if (htmlNodes > 0) {
        features.markup = { count: htmlNodes };
    }

    if (images > 0) {
        features.images = { count: images };
    }

    if (links > 0) {
        features.links = { count: links };
    }

    if (scaffoldTags.size > 0) {
        features.scaffolding = {
            kind: "pseudo-xml",
            tags: [...scaffoldTags],
        };
    }

    return features;
}

//  ---------------------------------------------------------------------
//  Owned detectors
//  ---------------------------------------------------------------------
//  Contract: (input) -> null when absent, evidence object when present.
//  Evidence goes into the decision log, which is what makes a routing
//  choice auditable months later.

function collectPaths(text) {
    const found = new Set();

    for (const match of text.matchAll(RE_PATH_CANDIDATE)) {
        const candidate = match.groups.path;
        const ext = (match.groups.ext || "").toLowerCase();

        const hasSeparator = candidate.includes("/");
        const hasKnownExt = KNOWN_CODE_EXTENSIONS.has(ext);

        //  Policy in code, not in the pattern: a separator OR a known
        //  code extension. This is what rejects "example.com" while
        //  keeping "Button.tsx".
        if (!hasSeparator && !hasKnownExt) {
            continue;
        }

        found.add(candidate);
    }

    return found;
}

function detectFilePaths(input) {
    //  Counted twice on purpose. Paths inside a pasted diff or trace
    //  are real signal, but so is "how many did the user actually
    //  name". The mapping layer decides which number it wants.
    const all = collectPaths(input.raw);
    const inProse = collectPaths(input.masked);

    if (all.size === 0) {
        return null;
    }

    return {
        count: all.size,
        proseCount: inProse.size,
        paths: [...all].slice(0, 10),
    };
}

function detectDiff(input) {
    if (!RE_DIFF_HUNK.test(input.raw)) {
        return null;
    }

    return { present: true };
}

function detectStackTrace(input) {
    if (!RE_STACK_TRACE.test(input.raw)) {
        return null;
    }

    return { present: true };
}

function detectMath(input) {
    //  Runs on raw: a $$ block is content the user wants reasoned
    //  about, not incidental formatting.
    if (!RE_MATH.test(input.raw)) {
        return null;
    }

    return { present: true };
}

function detectJson(input) {
    const trimmed = input.raw.trim();

    const looksLikeObject = trimmed.startsWith("{");
    const looksLikeArray = trimmed.startsWith("[");

    if (!looksLikeObject) {
        if (!looksLikeArray) {
            return null;
        }
    }

    try {
        JSON.parse(trimmed);
        return { whole: true };
    } catch {
        return null;
    }
}

function detectTabular(input) {
    //  Markdown tables already come from the parser. This is for raw
    //  delimited pastes. Stateful, so a loop rather than a pattern.
    for (const delimiter of TABULAR_DELIMITERS) {
        let runLength = 0;
        let runCount = -1;

        for (const line of input.maskedLines) {
            const count = line.split(delimiter).length - 1;

            if (count === 0) {
                runLength = 0;
                runCount = -1;
                continue;
            }

            if (count !== runCount) {
                runLength = 1;
                runCount = count;
                continue;
            }

            runLength++;

            if (runLength >= TABULAR_MIN_ROWS) {
                return {
                    kind: "delimited",
                    delimiter,
                    columns: count + 1,
                };
            }
        }
    }

    return null;
}

function detectSectionHeaders(input) {
    if (!RE_SECTION_HEADER.test(input.masked)) {
        return null;
    }

    return { kind: "section-header" };
}

//  ---------------------------------------------------------------------
//  Registry
//  ---------------------------------------------------------------------
//  Adding an owned detector is one entry here plus one function above.
//  `weight` is advisory metadata for the mapping layer, not a score:
//  "strong" means high precision for intent, "weak" means the shape is
//  real but says little about what the user wants.

export const OWNED_DETECTORS = [
    { name: "filePaths", weight: "strong", run: detectFilePaths },
    { name: "diff", weight: "strong", run: detectDiff },
    { name: "stackTrace", weight: "strong", run: detectStackTrace },
    { name: "math", weight: "medium", run: detectMath },
    { name: "json", weight: "medium", run: detectJson },
    { name: "tabular", weight: "medium", run: detectTabular },
    { name: "sectionHeaders", weight: "weak", run: detectSectionHeaders },
];

//  Advisory weights for markdown-derived features, kept here so the
//  mapping layer has one place to read confidence hints from.
export const MARKDOWN_WEIGHTS = {
    fencedCode: "strong",
    inlineCode: "medium",
    table: "medium",
    markup: "medium",
    headings: "weak",
    lists: "weak",
    blockquote: "weak",
    links: "weak",
    images: "weak",
    scaffolding: "weak",
};

//  ---------------------------------------------------------------------
//  Weight estimation
//  ---------------------------------------------------------------------

function estimateTokens(input) {
    const proseChars = Math.max(0, input.raw.length - input.codeChars);

    const proseTokens = proseChars / CHARS_PER_TOKEN_PROSE;
    const codeTokens = input.codeChars / CHARS_PER_TOKEN_CODE;

    return Math.ceil(proseTokens + codeTokens);
}

//  ---------------------------------------------------------------------
//  Public entry point
//  ---------------------------------------------------------------------

export function extractFeatures(text) {
    const input = prepareInput(text);

    const features = extractMarkdownFeatures(input);

    for (const detector of OWNED_DETECTORS) {
        const evidence = detector.run(input);

        if (evidence === null) {
            continue;
        }

        //  Markdown never emits these names, so no clobbering. If that
        //  ever changes, this is where the collision surfaces.
        features[detector.name] = evidence;
    }

    const totalChars = input.raw.length;

    return {
        features,
        metrics: {
            chars: totalChars,
            lines: input.lines.length,
            codeChars: input.codeChars,
            codeRatio: totalChars === 0
                ? 0
                : Number((input.codeChars / totalChars).toFixed(3)),
            estimatedTokens: estimateTokens(input),
        },
        //  Queryable summary of document shape. Cheap to store, and it
        //  answers "what did prompts look like last month" without
        //  keeping a single tree around.
        histogram: input.histogram,
    };
}
