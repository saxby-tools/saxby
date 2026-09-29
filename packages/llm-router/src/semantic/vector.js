//  =====================================================================
//  Vector math
//  =====================================================================
//  Everything Tier 3 needs, and nothing more. No library: cosine
//  similarity on unit vectors is a dot product, and a dependency for
//  that would be harder to read than the loop.
//
//  Vectors are normalised ONCE, at store time. After that every
//  comparison is a plain dot product — no square roots in the hot
//  path, and no chance of comparing a normalised vector against a raw
//  one, which would silently produce scores that look plausible and
//  mean nothing.
//
//  Storage is Float32. bge-m3 returns 1024 dimensions, so a vector is
//  4 KB. Float64 would double that for precision the similarity
//  ranking cannot use.

const BYTES_PER_FLOAT = 4;

/**
 * Returns a unit-length copy of a vector.
 *
 * A zero vector cannot be normalised — it has no direction — so it is
 * returned as-is and will score 0 against everything. That is the
 * honest outcome rather than a NaN that poisons a comparison.
 */
export function normalize(values) {
    const vector = Float32Array.from(values);

    let sumOfSquares = 0;

    for (let i = 0; i < vector.length; i++) {
        sumOfSquares += vector[i] * vector[i];
    }

    if (sumOfSquares === 0) {
        return vector;
    }

    const magnitude = Math.sqrt(sumOfSquares);

    for (let i = 0; i < vector.length; i++) {
        vector[i] = vector[i] / magnitude;
    }

    return vector;
}

/**
 * Cosine similarity between two ALREADY NORMALISED vectors.
 *
 * Mismatched dimensions mean the two came from different embedding
 * models, and a score between them would be meaningless. Loud failure.
 */
export function cosine(a, b) {
    if (a.length !== b.length) {
        throw new Error(
            `Vector dimension mismatch: ${a.length} vs ${b.length}. ` +
                `These came from different embedding models.`,
        );
    }

    let dot = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }

    return dot;
}

/**
 * Packs a vector for SQLite BLOB storage.
 */
export function toBlob(vector) {
    const source = vector instanceof Float32Array
        ? vector
        : Float32Array.from(vector);

    return new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength,
    );
}

/**
 * Unpacks a SQLite BLOB back into a vector.
 *
 * The bytes are COPIED rather than viewed in place. A Float32Array
 * view requires a 4-byte-aligned offset, and a BLOB handed back by
 * the driver carries no such guarantee — viewing an unaligned buffer
 * throws, and only for some rows, which is the worst kind of bug.
 */
export function fromBlob(blob) {
    if (blob.byteLength % BYTES_PER_FLOAT !== 0) {
        throw new Error(
            `Vector blob is ${blob.byteLength} bytes, not a multiple ` +
                `of ${BYTES_PER_FLOAT}. The row is corrupt.`,
        );
    }

    const copy = new Uint8Array(blob.byteLength);
    copy.set(blob);

    return new Float32Array(copy.buffer);
}

/**
 * Best match for a prompt vector across a set of candidates.
 *
 * Candidates are {label, vector, ...} and the highest score wins.
 * Ties break by label so the same inputs always give the same answer,
 * which matters because routing must be reproducible.
 *
 * @returns {{label, score, runnerUp, margin}|null}
 */
export function bestMatch(promptVector, candidates) {
    if (candidates.length === 0) {
        return null;
    }

    const scored = [];

    for (const candidate of candidates) {
        scored.push({
            label: candidate.label,
            score: cosine(promptVector, candidate.vector),
            exemplar: candidate.exemplar ?? null,
        });
    }

    scored.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }

        return a.label.localeCompare(b.label);
    });

    const top = scored[0];

    //  The runner-up and the gap to it are recorded, not just the
    //  winner. A 0.81 that beat a 0.80 is a coin flip wearing a
    //  confident number, and the archive should be able to tell those
    //  apart from a 0.81 that beat a 0.40.
    const runnerUp = scored.find((entry) => entry.label !== top.label);

    return {
        label: top.label,
        score: top.score,
        exemplar: top.exemplar,
        runnerUp: runnerUp?.label ?? null,
        margin: runnerUp ? top.score - runnerUp.score : null,
    };
}
