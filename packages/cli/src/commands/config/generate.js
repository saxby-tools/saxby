import { Command } from "@cliffy/command";
import { Confirm, Select } from "@cliffy/prompt";
import { join } from "@std/path";
import { getConfigDir } from "@shuntd/core";
import { OllamaAdapter } from "../../adapters/ollama.js";

const SHUNTD_DIR_NAME = "shuntd";
const CONFIG_FILE_NAME = "config.json";

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
    .action(async (options) => {
        // --- 1. Determine Target Path ---
        const configDir = join(getConfigDir(), SHUNTD_DIR_NAME);
        const targetPath = options.out || join(configDir, CONFIG_FILE_NAME);

        // --- 2. Check Overwrite (Chaos Hat: Protect the user's data) ---
        if (!options.stdout && !options.force) {
            try {
                await Deno.stat(targetPath); // Throws if file doesn't exist
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

        // --- 3. Scan & Select Models ---
        console.log("\n🔍 Scanning for local AI backends...");
        const isOllamaAlive = await OllamaAdapter.detect();

        if (!isOllamaAlive) {
            console.error(
                "❌ Could not detect Ollama on http://127.0.0.1:11434.",
            );
            Deno.exit(1);
        }

        const models = await OllamaAdapter.fetchInventory();
        if (models.length === 0) {
            console.error(
                "❌ No models found in Ollama. Please pull a model first.",
            );
            Deno.exit(1);
        }

        console.log(`📦 Found ${models.length} installed models.\n`);

        const globalDefault = await Select.prompt({
            message: "Global Fallback model (used when routing fails):",
            options: models,
        });

        const coderModel = await Select.prompt({
            message:
                "'Coder' persona model (optimized for code and refactoring):",
            options: models,
        });

        const writerModel = await Select.prompt({
            message:
                "'Writer' persona model (optimized for prose and reasoning):",
            options: models,
        });

        // --- 4. Build Payload ---
        const configPayload = {
            listen_port: 11435,
            upstream_url: OllamaAdapter.defaultUrl,
            global_default_model: globalDefault,
            catalog: {},
            personas: {
                coder: {
                    description:
                        "Assists with programming and software architecture.",
                    exemplars: ["Refactor this function", "Write a unit test"],
                    default_model: coderModel,
                },
                writer: {
                    description: "Assists with prose and documentation.",
                    exemplars: ["Summarize this article", "Draft an email"],
                    default_model: writerModel,
                },
            },
        };

        const uniqueModels = [
            ...new Set([globalDefault, coderModel, writerModel]),
        ];
        uniqueModels.forEach((model) => {
            configPayload.catalog[model] = {
                name: model,
                max_context: 4096,
                capabilities: [],
            };
        });

        const jsonString = JSON.stringify(configPayload, null, 4);

        // --- 5. Output / Save ---
        if (options.stdout) {
            console.log("\n" + jsonString);
            return;
        }

        // Ensure directory exists if saving to default or nested custom path
        const targetDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (targetDir) await Deno.mkdir(targetDir, { recursive: true });

        await Deno.writeTextFile(targetPath, jsonString);
        console.log(`\n🎉 Success! Configuration saved to: ${targetPath}`);
    });
