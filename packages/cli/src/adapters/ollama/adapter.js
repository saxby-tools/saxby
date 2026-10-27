const DEFAULT_MAX_CONTEXT = 4096;

export class OllamaAdapter {
    static id = "ollama";
    static displayName = "Ollama";
    static defaultUrl = "http://127.0.0.1:11434";

    /**
     * Checks whether an *Ollama* instance is alive at the target URL.
     *
     * Probes the Ollama-specific `/api/version` endpoint rather than the bare
     * root, so a non-Ollama server (vLLM, LM Studio) that answers 2xx on `/`
     * isn't mis-claimed as Ollama. This matters once more than one adapter is
     * registered and `--host` points them all at the same URL.
     *
     * @param {string} [url=this.defaultUrl]
     * @returns {Promise<boolean>}
     */
    static async detect(url = this.defaultUrl) {
        try {
            const res = await fetch(`${url}/api/version`, {
                signal: AbortSignal.timeout(1000), // 1s hard timeout
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Fetches installed model tags from the target host.
     *
     * Throws when the host is unreachable or the API errors, so callers can
     * distinguish "couldn't reach Ollama" from "Ollama is up but has no models"
     * (the latter returns an empty array).
     *
     * @param {string} [url=this.defaultUrl]
     * @returns {Promise<string[]>}
     */
    static async fetchInventory(url = this.defaultUrl) {
        let res;
        try {
            res = await fetch(`${url}/api/tags`, {
                signal: AbortSignal.timeout(3000),
            });
        } catch (err) {
            throw new Error(`Could not reach Ollama at ${url}: ${err.message}`);
        }

        if (!res.ok) {
            throw new Error(
                `Ollama at ${url} returned HTTP ${res.status} while fetching model tags.`,
            );
        }

        const data = await res.json();
        return (data.models ?? []).map((m) => m.name);
    }

    /**
     * Inspects a specific model via /api/show to pull its real context length
     * and whether it accepts images and audio.
     *
     * Degrades gracefully to a default rather than throwing — one model that
     * fails to introspect shouldn't abort config generation. Warns on fallback
     * (to stderr, so it's pipe-safe with `--stdout`) so the user knows that
     * entry's max_context is a guess, not a measurement. A model that cannot
     * be inspected is reported as taking neither images nor audio: those are
     * requirements, and an unclaimed requirement is refused, not misrouted.
     *
     * @param {string} modelName
     * @param {string} [url=this.defaultUrl]
     * @returns {Promise<import("../index.js").ModelDetails>}
     */
    static async fetchModelDetails(modelName, url = this.defaultUrl) {
        const fallback = {
            max_context: DEFAULT_MAX_CONTEXT,
            vision: false,
            audio: false,
        };

        try {
            const res = await fetch(`${url}/api/show`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: modelName }),
                signal: AbortSignal.timeout(3000),
            });

            if (!res.ok) {
                console.warn(
                    `⚠️  Could not inspect '${modelName}' (HTTP ${res.status}); ` +
                        `defaulting max_context to ${DEFAULT_MAX_CONTEXT}.`,
                );
                return fallback;
            }

            const data = await res.json();
            const modelInfo = data.model_info || {};

            // What the model accepts comes from what Ollama reports, never
            // from its name: one family can ship sizes with and without
            // vision or audio.
            const capabilities = data.capabilities ?? [];
            const inputs = {
                vision: capabilities.includes("vision"),
                audio: capabilities.includes("audio"),
            };

            // Context length is arch-prefixed (e.g. 'qwen2.context_length'),
            // so match by suffix rather than a hardcoded key.
            const contextKey = Object.keys(modelInfo).find((k) =>
                k.endsWith(".context_length")
            );

            const maxContext = contextKey ? Number(modelInfo[contextKey]) : NaN;

            if (Number.isNaN(maxContext) || maxContext <= 0) {
                console.warn(
                    `⚠️  '${modelName}' did not report a context length; ` +
                        `defaulting max_context to ${DEFAULT_MAX_CONTEXT}.`,
                );
                return { ...inputs, max_context: DEFAULT_MAX_CONTEXT };
            }

            return { ...inputs, max_context: maxContext };
        } catch (err) {
            console.warn(
                `⚠️  Failed to inspect '${modelName}' (${err.message}); ` +
                    `defaulting max_context to ${DEFAULT_MAX_CONTEXT}.`,
            );
            return fallback;
        }
    }
}
