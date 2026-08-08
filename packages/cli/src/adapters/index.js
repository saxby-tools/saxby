import { OllamaAdapter } from "./ollama/adapter.js";
import { generateOllamaConfig } from "./ollama/generate.js";

export const ADAPTERS = [
    {
        id: OllamaAdapter.id,
        name: OllamaAdapter.name,
        adapter: OllamaAdapter,
        generate: generateOllamaConfig,
    },
    // Future adapters (vllm, lmstudio, mlx) drop in right here!
];
