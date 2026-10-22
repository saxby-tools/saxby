//  =====================================================================
//  shunt probe — Tier 3 scores without generating a token
//  =====================================================================
//  Scores prompts against an instance's cached exemplars through
//  /shuntd/v1/explain. Only the embedder runs: no completion, no chat
//  model loaded.
//
//  It reports scores and margins rather than asserting a model, so
//  it carries no one machine's catalog. What to look for:
//
//    score below threshold   fell through to global_default, correct
//                            for anything genuinely off-topic
//    small margin            the two personas are fighting over it;
//                            their exemplars overlap
//    confident and wrong     the losing persona needs an exemplar
//                            closer to this phrasing
//
//  None of the built-in prompts are exemplars. A prompt that IS an
//  exemplar scores 1.000 and proves nothing.

import { Command } from "@cliffy/command";
import {
    fetchShuntdStatus,
    loadConfig,
    resolveInstanceName,
} from "@shuntd/core";

const PROBE_HOST = "127.0.0.1";
const PROMPT_WIDTH = 40;
const COLUMN_WIDTH = 42;

//  Below this the personas are effectively tied.
const TIGHT_MARGIN = 0.05;

//  Grouped by the default personas from `config generate`.
const PROMPTS = [
    //  ---- Should lean coder -----------------------------------------
    "the loop runs one too many times",
    "this keeps timing out on bigger inputs",
    "why does it work locally but not in CI",
    "can you simplify this logic",

    //  ---- Should lean writer ----------------------------------------
    "can you make this friendlier",
    "what's the best way to word this",
    "this reads like a robot wrote it",
    "give me a shorter version",

    //  ---- Genuinely ambiguous: expect a small margin ----------------
    "explain how this works",
    "what should I call this",
    "is there a better way to do this",
    "walk me through it",

    //  ---- Off-topic: should land on general -------------------------
    "can you recommend a good podcast",
    "should I bring an umbrella today",
    "how long do I boil an egg",
];

async function explain(baseUrl, prompt) {
    const response = await fetch(`${baseUrl}/shuntd/v1/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "shuntd",
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
}

function formatRow(prompt, result) {
    const tier = String(result.decision.tier);
    const semantic = result.semantic;

    const head = `  ${prompt.slice(0, PROMPT_WIDTH).padEnd(COLUMN_WIDTH)}`;

    if (!semantic) {
        return `${head}tier ${tier.padEnd(9)} (no semantic — ` +
            `lexical tiers matched)`;
    }

    if (semantic.error) {
        return `${head}ERROR ${semantic.error}`;
    }

    const score = semantic.score.toFixed(3);

    const margin = semantic.margin === null
        ? "n/a"
        : semantic.margin.toFixed(3);

    const isTight = semantic.margin !== null &&
        semantic.margin < TIGHT_MARGIN;

    const flag = isTight ? "  ⚠ TIGHT" : "";

    return `${head}tier ${tier.padEnd(9)} ${semantic.label.padEnd(8)} ` +
        `${score}  margin ${margin}${flag}`;
}

export const probeCommand = new Command()
    .description(
        "Score prompts against Tier 3 exemplars without generating.",
    )
    .arguments("[...prompts:string]")
    .action(async (options, ...custom) => {
        let config;
        let instance;

        try {
            instance = resolveInstanceName(options.instance);
            config = await loadConfig(instance);
        } catch (err) {
            console.error(err.message);
            Deno.exit(1);
        }

        const port = config.listen_port;
        const baseUrl = `http://${PROBE_HOST}:${port}`;

        //  One clear line instead of fifteen identical fetch errors,
        //  and never a probe of the wrong instance's exemplars.
        const holder = await fetchShuntdStatus(port);

        if (!holder) {
            console.error(`❌ No shuntd is answering on :${port}.`);
            Deno.exit(1);
        }

        if (holder.instance !== instance) {
            console.error(
                `❌ :${port} is held by instance ` +
                    `'${holder.instance ?? "default"}', not ` +
                    `'${instance ?? "default"}'.`,
            );
            Deno.exit(1);
        }
        const prompts = custom.length > 0 ? custom : PROMPTS;

        console.log(`\n🧭 Probing ${baseUrl}/shuntd/v1/explain`);
        console.log("   (no tokens generated)\n");

        for (const prompt of prompts) {
            const label = prompt.slice(0, PROMPT_WIDTH).padEnd(COLUMN_WIDTH);

            try {
                const result = await explain(baseUrl, prompt);
                console.log(formatRow(prompt, result));
            } catch (err) {
                console.log(`  ${label}FAILED ${err.message}`);
            }
        }

        console.log("");
    });
