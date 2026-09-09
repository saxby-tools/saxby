import { OllamaAdapter } from "./adapter.js";

/**
 * Runs the Ollama interactive wizard.
 * @param {string} [targetUrl]
 * @returns {Promise<{ targetUrl: string, models: string[], globalDefault: string }>}
 */
export async function generateOllamaConfig(
    targetUrl = OllamaAdapter.defaultUrl,
) {
    const models = await OllamaAdapter.fetchInventory(targetUrl);

    if (models.length === 0) {
        throw new Error(
            `No models found in Ollama at ${targetUrl}. Please pull a model first (\`ollama run <model>\`).`,
        );
    }

    console.log(`📦 Found ${models.length} installed models in Ollama.\n`);

    return { targetUrl, models };
}
