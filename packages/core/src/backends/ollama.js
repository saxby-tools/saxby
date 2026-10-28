import { describeFetchError } from "../utils/fetch-error.js";

const DEFAULT_MAX_CONTEXT = 4096;

//  /api/ps answers from the scheduler's memory and never loads a
//  model, so a short timeout only cuts off a backend that is stuck.
const RESIDENCY_TIMEOUT_MS = 2000;

//  Ollama reads a name without a tag as the `latest` tag.
const DEFAULT_TAG = "latest";

/**
 * The name Ollama itself would use: `bge-m3` and `bge-m3:latest` are
 * one model. Only the last path segment can hold the tag, because a
 * registry host may carry a port (`localhost:5000/model`).
 * @param {string} name
 * @returns {string}
 */
function canonicalOllamaName(name) {
    const lastSegment = name.slice(name.lastIndexOf("/") + 1);

    if (lastSegment.includes(":")) {
        return name;
    }

    return `${name}:${DEFAULT_TAG}`;
}

//  One /api/ps entry. size_vram is the part of the model in GPU
//  memory, which is what the wired ceiling limits; `size` also counts
//  layers spilled to the CPU. A missing or negative size is refused
//  rather than read as zero: the broker treats an unreadable answer
//  as unknown, never as free memory.
//
//  `partial` says the two differ: some of the model sits in CPU
//  memory, so size_vram is what it holds on the GPU now, not what it
//  needs when it loads whole. A missing `size` counts as partial, since
//  nothing then says the load was whole.
function isPartialLoad(entry) {
    if (!Number.isFinite(entry.size)) {
        return true;
    }

    return entry.size_vram < entry.size;
}

function readLoadedModel(entry) {
    if (typeof entry?.name !== "string") {
        throw new Error("Ollama's /api/ps listed a model with no name.");
    }

    if (!Number.isFinite(entry.size_vram)) {
        throw new Error(
            `Ollama's /api/ps gave no size_vram for '${entry.name}'.`,
        );
    }

    if (entry.size_vram < 0) {
        throw new Error(
            `Ollama's /api/ps gave a negative size_vram for ` +
                `'${entry.name}'.`,
        );
    }

    return {
        name: canonicalOllamaName(entry.name),
        bytes: entry.size_vram,
        partial: isPartialLoad(entry),
    };
}

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
     * @returns {Promise<import("./index.js").ModelDetails>}
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

    /**
     * The name this backend would use for a model, so a catalog key,
     * a raw request and an /api/ps entry compare equal.
     * @param {string} name
     * @returns {string}
     */
    static canonicalName(name) {
        return canonicalOllamaName(name);
    }

    /**
     * What is loaded right now, and how much GPU memory each model
     * holds, from Ollama's native /api/ps.
     *
     * Throws when Ollama cannot be asked or answers in a shape it does
     * not recognise. An empty array means Ollama answered and has
     * nothing loaded; the broker must be able to tell those apart.
     *
     * @param {string} [url=this.defaultUrl]
     * @returns {Promise<import("./index.js").LoadedModel[]>}
     */
    static async fetchResidency(url = this.defaultUrl) {
        let res;

        try {
            res = await fetch(`${url}/api/ps`, {
                signal: AbortSignal.timeout(RESIDENCY_TIMEOUT_MS),
            });
        } catch (err) {
            throw new Error(
                `Could not reach Ollama at ${url}: ${describeFetchError(err)}`,
            );
        }

        if (!res.ok) {
            await res.body?.cancel();

            throw new Error(
                `Ollama at ${url} returned HTTP ${res.status} for /api/ps.`,
            );
        }

        const data = await res.json();

        if (!Array.isArray(data?.models)) {
            throw new Error(
                `Ollama at ${url} sent /api/ps with no models list.`,
            );
        }

        return data.models.map(readLoadedModel);
    }
}
