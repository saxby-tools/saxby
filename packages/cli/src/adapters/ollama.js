export class OllamaAdapter {
    static id = "ollama";
    static defaultUrl = "http://127.0.0.1:11434";

    /**
     * Pings the default Ollama port to see if it's alive.
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
     * Fetches the actual installed models from Ollama's API.
     * @returns {Promise<string[]>} Array of model IDs (e.g., ["qwen2.5:0.5b", "llama3:8b"])
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
}
