import { Command } from "@cliffy/command";
import { Checkbox, Confirm, Input, Select } from "@cliffy/prompt";
import { join } from "@std/path";
import { getInstanceDir, resolveInstanceName } from "@saxby/core";
import { ADAPTERS } from "../../adapters/index.js";
import {
    isEmbeddingModel,
    suggestCapabilities,
} from "../../capabilities/index.js";
import {
    PERSONA_DEFAULTS,
    suggestSemanticDefaults,
} from "../../personas/defaults.js";

const CONFIG_FILE_NAME = "config.jsonc"; // Default to JSONC
const INDENT = 4;

//  Instance 'default' keeps the port clients already point at. A named
//  instance is suggested the next one so a dev config made by
//  pressing Enter does not collide with the running service.
const DEFAULT_PORT = 11435;
const DEFAULT_INSTANCE_PORT = 11436;

// Comments injected above each top-level config key in the generated file.
// Keys absent here still render (see renderJsoncConfig) — they just render
// without a comment, so this map never causes fields to be dropped.
const HEADER_COMMENT = [
    "Saxby configuration file.",
    "Edit directly to add capabilities, exemplars, or custom personas.",
];

const CONFIG_COMMENTS = {
    listen_port: ["The port Saxby will listen on (default: 11435)."],
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
    semantic: [
        "Semantic fallback routing configuration.",
        "WARNING: Changing the active model invalidates cached vectors and starts a new comparison epoch.",
    ],
    personas: [
        "Intent personas.",
        "tags are matched by Tier 2 when no catalog model claims them.",
        "exemplars train the Tier 3 semantic matcher.",
        "When a prompt misroutes, add an exemplar matching THAT",
        "phrasing — do not lower the threshold. A missing exemplar",
        "looks exactly like a threshold set too high.",
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
            for (const c of CONFIG_COMMENTS[match[1]]) {
                out.push(`${pad}// ${c}`);
            }
        }
        out.push(line);
    }

    return out.join("\n") + "\n";
}

export const generateCommand = new Command()
    .description("Interactively generate a Saxby configuration.")
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
        let instance;

        try {
            instance = resolveInstanceName(options.instance);
        } catch (err) {
            console.error(`❌ ${err.message}`);
            Deno.exit(1);
        }

        const configDir = getInstanceDir(instance);
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
        const defaultPort = instance ? DEFAULT_INSTANCE_PORT : DEFAULT_PORT;

        const listenPortInput = await Input.prompt({
            message: "What port should the Saxby proxy listen on?",
            default: String(defaultPort),
            validate: (value) => {
                const port = parseInt(value, 10);
                if (isNaN(port) || port < 1024 || port > 65535) {
                    return "Port must be a valid number between 1024 and 65535.";
                }
                return true; // Validation passed
            },
        });
        const parsedPort = parseInt(listenPortInput, 10);

        // 4. Run Generator & Build Payload
        let configPayload;
        try {
            // 4a. Get backend-specific data from the adapter
            const backendData = await selected.entry.generate(
                selected.targetUrl,
            );
            const { targetUrl, models } = backendData;

            //  An embedder cannot serve a completion, and any model
            //  picked below lands in the routing catalog, where it
            //  becomes a chat target. Keep embedders out of all three.
            const chatModels = models.filter((m) => !isEmbeddingModel(m));

            // 4b. Universal Prompts
            const globalDefault = await Select.prompt({
                message: "Global Fallback model (used when routing fails):",
                options: chatModels,
            });

            // 4b. Universal Persona Prompts
            const coderModel = await Select.prompt({
                message:
                    "'Coder' persona model (optimized for code and refactoring):",
                options: chatModels,
            });

            const writerModel = await Select.prompt({
                message:
                    "'Writer' persona model (optimized for prose and reasoning):",
                options: chatModels,
            });

            // 4c. Catalog Catch-all
            const baselineModels = new Set([
                globalDefault,
                coderModel,
                writerModel,
            ]);
            const remainingModels = chatModels.filter((m) =>
                !baselineModels.has(m)
            );

            let additionalModels = [];
            if (remainingModels.length > 0) {
                additionalModels = await Checkbox.prompt({
                    message:
                        "Select any additional models to add to the routing catalog (capabilities are manually tagged later):",
                    options: remainingModels,
                });
            }

            const uniqueModels = [...baselineModels, ...additionalModels];
            const catalog = {};

            console.log(
                "\n⚙️  Inspecting selected models for hardware specifications...",
            );
            for (const model of uniqueModels) {
                const details = await selected.entry.adapter.fetchModelDetails(
                    model,
                    targetUrl,
                );

                const suggested = suggestCapabilities(model);

                catalog[model] = {
                    name: model,
                    max_context: details.max_context,
                    capabilities: suggested.tags,
                };

                if (suggested.tags.length > 0) {
                    console.log(
                        `   ${model}: ${suggested.tags.join(", ")}` +
                            (suggested.why ? `  (${suggested.why})` : ""),
                    );
                }

                if (suggested.tags.length === 0) {
                    console.log(
                        `   ${model}: no capability match — tag it by ` +
                            `hand in config.jsonc if it should route.`,
                    );
                }
            }

            // 4d. Semantic Fallback Prompts
            console.log("\n🧠 Configuring Embedded Semantic Fallback...");

            const configureSemantic = await Confirm.prompt({
                message:
                    "Configure a Semantic Fallback model now? (Requires a dedicated embedding model like bge-m3 or nomic-embed-text)",
                default: false,
            });

            let semanticConfig = undefined;

            if (configureSemantic) {
                const semanticModel = await Select.prompt({
                    message: "Select the semantic fallback model:",
                    options: models,
                });

                const semanticDefaults = suggestSemanticDefaults(semanticModel);

                //  An unrecognised embedder gets no dim default, so
                //  the prompt's validator forces a real answer rather
                //  than accepting a plausible guess. A wrong dim makes
                //  every cached vector incomparable.
                const defaultDim = semanticDefaults.dim === null
                    ? ""
                    : String(semanticDefaults.dim);

                const defaultThreshold = String(semanticDefaults.threshold);

                const semanticDimInput = await Input.prompt({
                    message:
                        `Vector dimensions for ${semanticModel}? (e.g., 1024 for bge-m3):`,
                    default: defaultDim,
                    validate: (v) =>
                        !isNaN(parseInt(v, 10)) || "Must be a valid integer.",
                });

                const semanticThresholdInput = await Input.prompt({
                    message:
                        `Confidence threshold for ${semanticModel}? (0.0 to 1.0):`,
                    default: defaultThreshold,
                    validate: (v) => {
                        const parsed = parseFloat(v);
                        return (!isNaN(parsed) && parsed > 0 && parsed < 1) ||
                            "Must be a float between 0.0 and 1.0.";
                    },
                });

                semanticConfig = {
                    active: semanticModel,
                    profiles: {
                        [semanticModel]: {
                            model: semanticModel,
                            dim: parseInt(semanticDimInput, 10),
                            threshold: parseFloat(semanticThresholdInput),
                        },
                    },
                };
            }

            // 4d-bis. Build personas from curated presets
            //  general takes the global default: it IS the fallback
            //  persona, so it needs no prompt of its own.
            const personaModels = {
                coder: coderModel,
                writer: writerModel,
                general: globalDefault,
            };

            const personas = {};

            for (const [name, preset] of Object.entries(PERSONA_DEFAULTS)) {
                personas[name] = {
                    description: preset.description,
                    tags: preset.tags,
                    exemplars: preset.exemplars,
                    default_model: personaModels[name],
                };
            }

            // 4e. Construct Final Payload
            configPayload = {
                // parsedPort is captured from the Input.prompt in step 3.5
                listen_port: isNaN(parsedPort) ? defaultPort : parsedPort,
                upstream_url: targetUrl,
                global_default_model: globalDefault,
                catalog,
                ...(semanticConfig ? { semantic: semanticConfig } : {}),
                personas,
            };
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
