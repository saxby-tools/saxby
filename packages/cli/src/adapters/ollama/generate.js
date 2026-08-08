import { Select } from "@cliffy/prompt";
import { OllamaAdapter } from "./adapter.js";

/**
 * Runs the Ollama interactive wizard.
 * @param {string} [targetUrl]
 * @returns {Promise<Object>}
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

    const globalDefault = await Select.prompt({
        message: "Global Fallback model (used when routing fails):",
        options: models,
    });

    const coderModel = await Select.prompt({
        message: "'Coder' persona model (optimized for code and refactoring):",
        options: models,
    });

    const writerModel = await Select.prompt({
        message: "'Writer' persona model (optimized for prose and reasoning):",
        options: models,
    });

    const uniqueModels = [...new Set([globalDefault, coderModel, writerModel])];
    const catalog = {};

    console.log(
        "\n⚙️  Inspecting selected models for hardware specifications...",
    );
    for (const model of uniqueModels) {
        const details = await OllamaAdapter.fetchModelDetails(model, targetUrl);
        catalog[model] = {
            name: model,
            max_context: details.max_context,
            capabilities: [],
        };
    }

    return {
        listen_port: 11435,
        upstream_url: targetUrl,
        global_default_model: globalDefault,
        catalog,
        personas: {
            coder: {
                description:
                    "Assists with programming and software architecture.",
                exemplars: ["Refactor this function", "Write a unit test"],
                default_model: coderModel,
            },
            writer: {
                description: "Assists with prose and documentation.",
                exemplars: ["Summarize this article", "Draft an email"],
                default_model: writerModel,
            },
        },
    };
}
