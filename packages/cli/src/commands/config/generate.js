import { Command } from "@cliffy/command";
import { Confirm, Select } from "@cliffy/prompt";
import { join } from "@std/path";
import { getConfigDir } from "@shuntd/core";
import { ADAPTERS } from "../../adapters/index.js";

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
        // 1. Determine Target Path
        const configDir = join(getConfigDir(), SHUNTD_DIR_NAME);
        const targetPath = options.out || join(configDir, CONFIG_FILE_NAME);

        // 2. Overwrite Protection
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

        // 3. Scan All Registered Adapters
        console.log("\n🔍 Scanning for local AI backends...");
        const activeAdapters = [];

        for (const entry of ADAPTERS) {
            const isAlive = await entry.adapter.detect();
            if (isAlive) {
                activeAdapters.push(entry);
            }
        }

        if (activeAdapters.length === 0) {
            console.error(
                "❌ Could not detect any active local AI backends (Ollama, etc.).",
            );
            console.error(
                "Please ensure your AI backend is running and try again.",
            );
            Deno.exit(1);
        }

        // 4. Select Active Adapter (Auto-pick if 1, Prompt if > 1)
        let selectedAdapter = activeAdapters[0];

        if (activeAdapters.length > 1) {
            const choice = await Select.prompt({
                message:
                    "Multiple local AI backends detected. Select one to configure:",
                options: activeAdapters.map((a) => ({
                    name: a.name,
                    value: a.id,
                })),
            });
            selectedAdapter = activeAdapters.find((a) => a.id === choice);
        } else {
            console.log(`✅ Detected active backend: ${selectedAdapter.name}`);
        }

        // 5. Delegate to Backend Generator Flow
        const configPayload = await selectedAdapter.generate();
        const jsonString = JSON.stringify(configPayload, null, 4);

        // 6. Save or Output
        if (options.stdout) {
            console.log("\n" + jsonString);
            return;
        }

        const targetDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (targetDir) await Deno.mkdir(targetDir, { recursive: true });

        await Deno.writeTextFile(targetPath, jsonString);
        console.log(`\n🎉 Success! Configuration saved to: ${targetPath}`);
    });
