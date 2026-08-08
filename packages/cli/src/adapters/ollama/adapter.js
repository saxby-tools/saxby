export class OllamaAdapter {
    static id = "ollama";
    static name = "Ollama";
    static defaultUrl = "http://127.0.0.1:11434";

    /**
     * Checks if the local Ollama server is responding.
     * @returns {Promise<boolean>}
     */
    static async detect() {
        try {
            const res = await fetch(this.defaultUrl);
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Fetches installed model tags.
     * @returns {Promise<string[]>}
     */
    static async fetchInventory() {
        try {
            const res = await fetch(`${this.defaultUrl}/api/tags`);
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
     * @returns {Promise<{ max_context: number }>}
     */
    static async fetchModelDetails(modelName) {
        try {
            const res = await fetch(`${this.defaultUrl}/api/show`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: modelName }),
            });

            if (!res.ok) return { max_context: 4096 };

            const data = await res.json();
            const modelInfo = data.model_info || {};

            // Dynamically find context_length key (e.g., 'general.context_length')
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
