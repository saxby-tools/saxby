import { OllamaAdapter } from "@saxby/core";
import { generateOllamaConfig } from "./ollama/generate.js";

//  The adapters themselves live in @saxby/core, because the daemon
//  reads them too. This registry pairs each one with its interactive
//  wizard, which stays here beside the prompts it uses.

/**
 * @typedef {Object} AdapterRegistryEntry
 * @property {import("@saxby/core").BackendAdapter} adapter
 * @property {(url?: string) => Promise<Object>} generate - The TUI wizard
 */

/**
 * Every backend `saxby config generate` can scaffold a config for,
 * each paired with the wizard that asks the questions.
 * @type {AdapterRegistryEntry[]}
 */
export const ADAPTERS = [
    {
        adapter: OllamaAdapter,
        generate: generateOllamaConfig,
    },
];
