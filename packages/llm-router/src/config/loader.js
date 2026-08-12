import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { getConfigDir } from "@shuntd/core";
import { validateConfig } from "./schema.js";

const SHUNTD_DIR_NAME = "shuntd";
const CONFIG_FILE_JSONC = "config.jsonc";
const CONFIG_FILE_JSON = "config.json";

export async function loadConfig() {
    const configDir = join(getConfigDir(), SHUNTD_DIR_NAME);
    const pathJsonc = join(configDir, CONFIG_FILE_JSONC);
    const pathJson = join(configDir, CONFIG_FILE_JSON);

    try {
        await Deno.mkdir(configDir, { recursive: true });
    } catch (err) {
        if (!(err instanceof Deno.errors.AlreadyExists)) {
            throw new Error(
                `Failed to create config directory at ${configDir}: ${err.message}`,
            );
        }
    }

    // Try reading config.jsonc first, fall back to config.json
    let rawContent;
    let loadedPath;

    try {
        rawContent = await Deno.readTextFile(pathJsonc);
        loadedPath = pathJsonc;

        // Warn if a stale config.json is being shadowed by config.jsonc, so an
        // edit to the wrong file doesn't silently do nothing.
        try {
            await Deno.stat(pathJson);
            console.warn(
                `⚠️  Both config.jsonc and config.json exist in ${configDir}; ` +
                    `loading config.jsonc and ignoring config.json.`,
            );
        } catch (_) {
            // config.json absent — nothing to warn about.
        }
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            try {
                rawContent = await Deno.readTextFile(pathJson);
                loadedPath = pathJson;
            } catch (innerErr) {
                if (innerErr instanceof Deno.errors.NotFound) {
                    throw new Error(
                        "❌ No config found!\n" +
                            "Please run 'shunt config generate' to launch the interactive setup guide.",
                    );
                }
                throw innerErr;
            }
        } else {
            throw err;
        }
    }

    let parsedData;
    try {
        parsedData = parseJsonc(rawContent);
    } catch (err) {
        throw new Error(
            `FATAL: Config file at ${loadedPath} contains invalid JSON/JSONC.\n${err.message}`,
        );
    }

    return validateConfig(parsedData);
}
