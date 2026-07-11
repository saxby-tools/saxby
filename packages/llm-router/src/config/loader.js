import { join } from "@std/path";
import { getConfigDir } from "@shuntd/core";
import { validateConfig } from "./schema.js";

const SHUNTD_DIR_NAME = "shuntd";
const CONFIG_FILE_NAME = "config.json";

/**
 * The "Baked-In" Sane Defaults.
 * If the user boots shuntd for the very first time, this is what they get.
 */
const DEFAULT_CONFIG = {
    upstream_url: "http://127.0.0.1:11434",
    global_default_model: "qwen2.5:0.5b", // A safe, tiny fallback
    catalog: {
        "qwen2.5:0.5b": {
            name: "qwen2.5:0.5b",
            description: "A fast, tiny default model.",
            max_context: 4096,
            capabilities: ["TAG_FAST", "TAG_DEFAULT"],
        },
    },
    personas: {
        coder: {
            description: "Assists with programming and software architecture.",
            exemplars: [
                "Refactor this function",
                "Why is my code throwing a syntax error?",
                "Write a unit test for this class",
            ],
            default_model: "qwen2.5:0.5b",
        },
        writer: {
            description:
                "Assists with prose, documentation, and summarization.",
            exemplars: [
                "Summarize this article",
                "Draft an email to my boss",
                "Make this paragraph sound more professional",
            ],
            default_model: "qwen2.5:0.5b",
        },
    },
};

/**
 * Initializes and loads the shuntd configuration.
 * @returns {Promise<Object>} The validated config object.
 */
export async function loadConfig() {
    const configDir = join(getConfigDir(), SHUNTD_DIR_NAME);
    const configPath = join(configDir, CONFIG_FILE_NAME);

    // 1. Ensure the ~/.config/shuntd directory exists
    try {
        await Deno.mkdir(configDir, { recursive: true });
    } catch (err) {
        if (!(err instanceof Deno.errors.AlreadyExists)) {
            throw new Error(
                `Failed to create config directory at ${configDir}: ${err.message}`,
            );
        }
    }

    // 2. Check if the config file exists
    let rawJson;
    try {
        rawJson = await Deno.readTextFile(configPath);
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            // We fail loud instead of scaffolding!
            throw new Error(
                "❌ No config found!\n" +
                    "Please run 'shunt init' to launch the interactive setup guide.",
            );
        }
        throw err;
    }

    // 3. Parse JSON
    let parsedData;
    try {
        parsedData = JSON.parse(rawJson);
    } catch (err) {
        throw new Error(
            `FATAL: Config file at ${configPath} contains invalid JSON.\n${err.message}`,
        );
    }

    // 4. Validate through Valibot Schema Chokepoint
    return validateConfig(parsedData);
}
