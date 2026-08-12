import { Command } from "@cliffy/command";
import { Confirm, Input, Select } from "@cliffy/prompt";
import { join } from "@std/path";
import { getConfigDir } from "@shuntd/core";
import { ADAPTERS } from "../../adapters/index.js";

const SHUNTD_DIR_NAME = "shuntd";
const CONFIG_FILE_NAME = "config.jsonc"; // Default to JSONC
const INDENT = 4;

// Comments injected above each top-level config key in the generated file.
// Keys absent here still render (see renderJsoncConfig) — they just render
// without a comment, so this map never causes fields to be dropped.
const HEADER_COMMENT = [
    "shuntd configuration file.",
    "Edit directly to add capabilities, exemplars, or custom personas.",
];

const CONFIG_COMMENTS = {
    listen_port: ["The port shuntd will listen on (default: 11435)."],
    upstream_url: ["Upstream OpenAI-compatible provider endpoint."],
    global_default_model: [
        "Fallback model used when no persona or capability matches.",
    ],
    catalog: [
        "Hardware model catalog.",
        "max_context was auto-detected from the backend via /api/show.",
        'Add capability tags (e.g. "TAG_MULTI_FILE") to a model\'s',
        '"capabilities" array to make it eligible for capability routing.',
    ],
    personas: [
        "Intent personas.",
        "exemplars train the Tier 3 semantic embedding matcher.",
    ],
};

/**
 * Serializes a config payload to a commented JSONC string.
 *
 * The whole payload goes through JSON.stringify, so (a) every value is escaped
 * correctly and (b) every field is emitted whether or not we have a comment for
 * it — this never silently drops keys the schema/generator add later. Comments
 * are then injected above matching top-level keys. It is a pure formatter and
 * not a second authority on config shape.
 *
 * @param {Object} payload
 * @returns {string}
 */
function renderJsoncConfig(payload) {
    const json = JSON.stringify(payload, null, INDENT);
    const pad = " ".repeat(INDENT);
    // Match a top-level key only: exactly one indent, then "key":
    const topLevelKey = new RegExp(`^ {${INDENT}}"([^"]+)":`);

    const out = HEADER_COMMENT.map((c) => `// ${c}`);

    for (const line of json.split("\n")) {
        const match = line.match(topLevelKey);
        if (match && CONFIG_COMMENTS[match[1]]) {
            // Blank line between sections, but not right after the opening brace.
            if (out[out.length - 1].trim() !== "{") out.push("");
            for (const c of CONFIG_COMMENTS[match[1]]) out.push(`${pad}// ${c}`);
        }
        out.push(line);
    }

    return out.join("\n") + "\n";
}

export const generateCommand = new Command()
    .description("Interactively generate a shuntd configuration.")
    .option(
        "--stdout",
        "Print the generated config to standard output instead of saving.",
    )
    .option("-o, --out <path:string>", "Specify a custom output file path.")
    .option(
        "-f, --force",
        "Overwrite the file if it already exists without prompting.",
    )
    .option(
        "-H, --host <url:string>",
        "Override the backend host URL to target.",
    )
    .action(async (options) => {
        const configDir = join(getConfigDir(), SHUNTD_DIR_NAME);
        const targetPath = options.out || join(configDir, CONFIG_FILE_NAME);

        // 1. Overwrite Protection
        if (!options.stdout && !options.force) {
            try {
                await Deno.stat(targetPath);
                const overwrite = await Confirm.prompt({
                    message:
                        `⚠️  File already exists at ${targetPath}. Overwrite?`,
                    default: false,
                });
                if (!overwrite) {
                    console.log("❌ Aborted.");
                    Deno.exit(0);
                }
            } catch (err) {
                if (!(err instanceof Deno.errors.NotFound)) {
                    console.error(`❌ File system error: ${err.message}`);
                    Deno.exit(1);
                }
            }
        }

        // 2. Parallel Detection Scan across all registered adapters
        console.log("\n🔍 Scanning for local AI backends...");
        const detectionResults = await Promise.all(
            ADAPTERS.map(async (entry) => {
                const targetUrl = options.host || entry.adapter.defaultUrl;
                const isAlive = await entry.adapter.detect(targetUrl);
                return { entry, isAlive, targetUrl };
            }),
        );

        const activeAdapters = detectionResults.filter((r) => r.isAlive);

        if (activeAdapters.length === 0) {
            console.error("❌ Could not detect any active local AI backends.");
            if (options.host) {
                console.error(`Attempted target host: ${options.host}`);
            }
            console.error(
                "Please ensure your AI backend is running and try again.",
            );
            Deno.exit(1);
        }

        // 3. Select Active Adapter
        let selected = activeAdapters[0];

        if (activeAdapters.length > 1) {
            const choice = await Select.prompt({
                message:
                    "Multiple local AI backends detected. Select one to configure:",
                options: activeAdapters.map((a) => ({
                    name: `${a.entry.adapter.displayName} (${a.targetUrl})`,
                    value: a.entry.adapter.id,
                })),
            });
            selected = activeAdapters.find((a) =>
                a.entry.adapter.id === choice
            );
        } else {
            console.log(
                `✅ Detected active backend: ${selected.entry.adapter.displayName} (${selected.targetUrl})`,
            );
        }

        // 3.5 Prompt for the listen_port
        const listenPortInput = await Input.prompt({
            message: "What port should the shuntd proxy listen on?",
            default: "11435",
            validate: (value) => {
                const port = parseInt(value, 10);
                if (isNaN(port) || port < 1024 || port > 65535) {
                    return "Port must be a valid number between 1024 and 65535.";
                }
                return true; // Validation passed
            },
        });
        const parsedPort = parseInt(listenPortInput, 10);

        // 4. Run Generator
        let configPayload;
        try {
            configPayload = await selected.entry.generate(selected.targetUrl);

            // Overwrite the payload's port with the user's choice
            if (!isNaN(parsedPort)) {
                configPayload.listen_port = parsedPort;
            }
        } catch (err) {
            console.error(`❌ Generator Error: ${err.message}`);
            Deno.exit(1);
        }

        const jsoncString = renderJsoncConfig(configPayload);

        // 5. Output or Save
        if (options.stdout) {
            console.log("\n" + jsoncString);
            return;
        }

        const targetDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (targetDir) await Deno.mkdir(targetDir, { recursive: true });

        await Deno.writeTextFile(targetPath, jsoncString);
        console.log(`\n🎉 Success! Configuration saved to: ${targetPath}`);
    });
