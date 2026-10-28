//  =====================================================================
//  Backend adapters
//  =====================================================================
//  One static class per backend. Lives in core because both sides
//  need it: `saxby config generate` reads the inventory, and the
//  daemon's memory broker reads what is loaded. The daemon importing
//  CLI internals would point the dependency the wrong way.
//
//  The interactive wizards stay in the CLI, beside the prompts they
//  use (packages/cli/src/adapters/index.js).

import { OllamaAdapter } from "./ollama.js";

export { OllamaAdapter };

/**
 * @typedef {Object} ModelDetails
 * @property {number} max_context - Context window the backend reports
 * @property {boolean} vision - Whether the model accepts images
 * @property {boolean} audio - Whether the model accepts audio
 */

/**
 * @typedef {Object} LoadedModel
 * @property {string} name - Canonical name, as canonicalName returns it
 * @property {number} bytes - GPU memory the loaded model holds
 */

/**
 * @typedef {Object} BackendAdapter
 * @property {string} id - Unique identifier for the backend
 *     (e.g., 'ollama', 'vllm')
 * @property {string} displayName - Human-readable name
 *     (e.g., 'Ollama', 'vLLM Engine')
 * @property {string} defaultUrl - Default local host URL
 * @property {(url?: string) => Promise<boolean>} detect - Pings the
 *     endpoint to verify availability
 * @property {(url?: string) => Promise<string[]>} fetchInventory -
 *     Fetches installed model names
 * @property {(modelName: string, url?: string) => Promise<ModelDetails>}
 *     fetchModelDetails - Inspects model specs
 * @property {(name: string) => string} canonicalName - The backend's
 *     own spelling of a model name, for comparing names
 * @property {(url?: string) => Promise<LoadedModel[]>} fetchResidency -
 *     What is loaded now and how big. Throws when the backend cannot
 *     be asked; an empty array means nothing is loaded.
 */

/** @type {BackendAdapter[]} */
export const BACKEND_ADAPTERS = [OllamaAdapter];
