import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { getConfigDir } from "@shuntd/core";
import { validateConfig } from "./schema.js";

const SHUNTD_DIR_NAME = "shuntd";
const CONFIG_FILE_NAME = "config.json";

export async function loadConfig() {
    const configDir = join(getConfigDir(), SHUNTD_DIR_NAME);
    const configPath = join(configDir, CONFIG_FILE_NAME);

    try {
        await Deno.mkdir(configDir, { recursive: true });
    } catch (err) {
        if (!(err instanceof Deno.errors.AlreadyExists)) {
            throw new Error(
                `Failed to create config directory at ${configDir}: ${err.message}`,
            );
        }
    }

    let rawJson;
    try {
        rawJson = await Deno.readTextFile(configPath);
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            throw new Error(
                "❌ No config found!\n" +
                    "Please run 'shunt config generate' to launch the interactive setup guide.",
            );
        }
        throw err;
    }

    let parsedData;
    try {
        // Parse using JSONC parser to support inline comments in user configs
        parsedData = parseJsonc(rawJson);
    } catch (err) {
        throw new Error(
            `FATAL: Config file at ${configPath} contains invalid JSON/JSONC.\n${err.message}`,
        );
    }

    return validateConfig(parsedData);
}
