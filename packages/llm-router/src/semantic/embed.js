//  =====================================================================
//  Embedding client
//  =====================================================================
//  Talks to the SAME OpenAI-compatible upstream everything else uses.
//  No Ollama-specific endpoint, no shelling out to a CLI, no model
//  provisioning — if the embedder is not pulled, the call fails and
//  Tier 3 degrades. That keeps the vLLM and MLX portability story
//  intact: any backend that speaks /v1/embeddings works unchanged.
//
//  Embedding is the ONE network call in the routing path, so it is
//  bounded by a timeout. A slow embedder must cost a fallback, never
//  a hung request.

const EMBED_TIMEOUT_MS = 10000;

//  Exemplars are embedded in batches at warm-up. Large enough to make
//  boot fast, small enough that one failure does not lose everything.
const BATCH_SIZE = 32;

/**
 * Posts a batch of strings to the upstream embeddings endpoint.
 *
 * @returns {Promise<number[][]>} raw vectors, in input order
 */
async function postEmbeddings(inputs, profile, upstreamUrl) {
    const url = `${upstreamUrl}/v1/embeddings`;

    let res;

    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: profile.model, input: inputs }),
            signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
    } catch (err) {
        throw new Error(
            `Embedding request to ${url} failed: ${err.message}`,
        );
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => "");

        throw new Error(
            `Embedding request returned HTTP ${res.status}. ` +
                `Is '${profile.model}' pulled? ${detail.slice(0, 200)}`,
        );
    }

    const payload = await res.json();
    const rows = payload?.data;

    if (!Array.isArray(rows)) {
        throw new Error(
            "Embedding response had no 'data' array — the upstream " +
                "may not implement /v1/embeddings.",
        );
    }

    if (rows.length !== inputs.length) {
        throw new Error(
            `Embedding response length mismatch: sent ${inputs.length}, ` +
                `received ${rows.length}.`,
        );
    }

    //  The API does not guarantee response order, and index is the
    //  field that says where each vector belongs.
    const ordered = new Array(inputs.length);

    for (let i = 0; i < rows.length; i++) {
        const position = rows[i].index ?? i;
        ordered[position] = rows[i].embedding;
    }

    return ordered;
}

/**
 * Embeds one string.
 */
export async function embedOne(text, profile, upstreamUrl) {
    const [vector] = await postEmbeddings([text], profile, upstreamUrl);

    return vector;
}

/**
 * Embeds many strings, in batches.
 */
export async function embedMany(texts, profile, upstreamUrl) {
    const vectors = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const embedded = await postEmbeddings(batch, profile, upstreamUrl);

        vectors.push(...embedded);
    }

    return vectors;
}

/**
 * Confirms the embedder answers and reports the dimension it returns.
 *
 * Called at warm-up. A profile whose declared `dim` disagrees with
 * what the model actually returns would make every cached vector
 * incomparable, so the mismatch is caught once at boot rather than
 * per request.
 */
export async function probeProfile(profile, upstreamUrl) {
    const vector = await embedOne("probe", profile, upstreamUrl);

    const actual = vector.length;

    if (profile.dim) {
        if (profile.dim !== actual) {
            throw new Error(
                `Profile declares dim ${profile.dim} but '${profile.model}' ` +
                    `returned ${actual}. Fix the config — a wrong dim ` +
                    `makes every cached vector incomparable.`,
            );
        }
    }

    return { dim: actual };
}
