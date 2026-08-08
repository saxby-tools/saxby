import { OllamaAdapter } from "./ollama/adapter.js";
import { generateOllamaConfig } from "./ollama/generate.js";

/**
 * @typedef {Object} BackendAdapter
 * @property {string} id - Unique identifier for the backend (e.g., 'ollama', 'vllm')
 * @property {string} displayName - Human-readable name (e.g., 'Ollama', 'vLLM Engine')
 * @property {string} defaultUrl - Default local host URL
 * @property {(url?: string) => Promise<boolean>} detect - Pings the endpoint to verify availability
 * @property {(url?: string) => Promise<string[]>} fetchInventory - Fetches installed model names
 * @property {(modelName: string, url?: string) => Promise<{ max_context: number }>} fetchModelDetails - Inspects model specs
 */

/**
 * @typedef {Object} AdapterRegistryEntry
 * @property {BackendAdapter} adapter - The adapter class/object
 * @property {(url?: string) => Promise<Object>} generate - The interactive TUI wizard
 */

/** @type {AdapterRegistryEntry[]} */
export const ADAPTERS = [
    {
        adapter: OllamaAdapter,
        generate: generateOllamaConfig,
    },
];
