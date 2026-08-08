export class OllamaAdapter {
    static id = "ollama";
    static displayName = "Ollama";
    static defaultUrl = "http://127.0.0.1:11434";

    /**
     * Checks if an Ollama instance is alive.
     * @param {string} [url=this.defaultUrl]
     * @returns {Promise<boolean>}
     */
    static async detect(url = this.defaultUrl) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(1000), // 1s hard timeout
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Fetches installed model tags from the target host.
     * @param {string} [url=this.defaultUrl]
     * @returns {Promise<string[]>}
     */
    static async fetchInventory(url = this.defaultUrl) {
        try {
            const res = await fetch(`${url}/api/tags`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!res.ok) throw new Error("Failed to fetch tags");
            const data = await res.json();
            return data.models.map((m) => m.name);
        } catch (error) {
            console.error(
                `❌ Failed to fetch Ollama inventory: ${error.message}`,
            );
            return [];
        }
    }

    /**
     * Inspects a specific model via /api/show to pull real context length.
     * @param {string} modelName
     * @param {string} [url=this.defaultUrl]
     * @returns {Promise<{ max_context: number }>}
     */
    static async fetchModelDetails(modelName, url = this.defaultUrl) {
        try {
            const res = await fetch(`${url}/api/show`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: modelName }),
                signal: AbortSignal.timeout(3000),
            });

            if (!res.ok) return { max_context: 4096 };

            const data = await res.json();
            const modelInfo = data.model_info || {};

            const contextKey = Object.keys(modelInfo).find((k) =>
                k.endsWith(".context_length")
            );

            const maxContext = contextKey
                ? Number(modelInfo[contextKey])
                : 4096;

            return {
                max_context: isNaN(maxContext) || maxContext <= 0
                    ? 4096
                    : maxContext,
            };
        } catch {
            return { max_context: 4096 };
        }
    }
}
