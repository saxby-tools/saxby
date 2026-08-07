import { join } from "@std/path";
import { getConfigDir } from "@shuntd/core";
import { validateConfig } from "./schema.js";

const SHUNTD_DIR_NAME = "shuntd";
const CONFIG_FILE_NAME = "config.json";

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
                    "Please run 'shunt config' to launch the interactive setup guide.",
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
