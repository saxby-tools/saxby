import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { getInstanceDir } from "./instance.js";
import { validateConfig } from "./schema.js";

const CONFIG_FILE_JSONC = "config.jsonc";
const CONFIG_FILE_JSON = "config.json";

/**
 * Loads and validates an instance's config.
 *
 * Never creates the instance directory. Only `config generate` makes
 * one, so a mistyped `-i` name fails loudly instead of leaving an
 * empty instance behind for `instance list` to report.
 * @param {string | null} instance - A name from resolveInstanceName.
 */
export async function loadConfig(instance = null) {
    const configDir = getInstanceDir(instance);
    const pathJsonc = join(configDir, CONFIG_FILE_JSONC);
    const pathJson = join(configDir, CONFIG_FILE_JSON);

    const generateHint = instance
        ? `saxby -i ${instance} config generate`
        : "saxby config generate";

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
                `⚠️  Both config.jsonc and config.json exist in ` +
                    `${configDir}; loading config.jsonc and ignoring ` +
                    `config.json.`,
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
                        `❌ No config found in ${configDir}\n` +
                            `Please run '${generateHint}' to launch ` +
                            "the interactive setup guide.",
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
            `❌ ${loadedPath} is not valid JSON or JSONC:\n${err.message}`,
        );
    }

    let config;

    try {
        config = validateConfig(parsedData);
    } catch (err) {
        throw new Error(
            `❌ Invalid config in ${loadedPath}:\n${err.message}`,
        );
    }

    //  Resolved here so every consumer — daemon, dashboard, CLI — finds
    //  the same file without repeating the XDG logic.
    if (!config.log_path) {
        config.log_path = join(configDir, "decision-log.db");
    }

    return config;
}
