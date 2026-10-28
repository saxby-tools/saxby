//  =====================================================================
//  Memory budget
//  =====================================================================
//  One formula decides both jobs and model loads:
//
//    free = ceiling - margin - pinned - loaded - reserved
//
//    ceiling   the most the GPU may hold (the platform's memory probe,
//              else memory.ceiling_gib)
//    margin    kept free beyond everything else (memory.margin_gib)
//    pinned    every pinned model at full size, LOADED OR NOT, so a
//              job can never take its space
//    loaded    every other model the backend holds now, including
//              ones loaded outside Saxby; a job cannot evict them
//    reserved  every job reservation, plus the size of each model
//              load the broker has let through but not yet seen
//
//  Any term that cannot be known makes `free` null, and nothing is
//  admitted against a null: an unknown is never read as free memory.
//
//  Pure: terms in, numbers and sentences out. The broker gathers the
//  terms and decides what to do with the answer.

import { formatGib } from "@saxby/core";

/**
 * @typedef {Object} PinnedTerm
 * @property {string} model - Canonical name.
 * @property {number | null} bytes - Null when no size is known.
 * @property {"loaded" | "measured" | "size_gib" | "unknown"} source
 */

/**
 * @typedef {Object} BudgetTerms
 * @property {number | null} ceilingBytes
 * @property {string} ceilingSource
 * @property {number} marginBytes
 * @property {PinnedTerm[]} pinned
 * @property {{ model: string, bytes: number }[]} loaded - Not pinned.
 * @property {number} reservedBytes
 * @property {string | null} residencyError - Why the backend could
 *     not say what it has loaded, or null when it did.
 * @property {number | null} usedBytes - Observed, never budgeted.
 * @property {string} usedSource
 */

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

//  Two kinds of unknown. A config gap (no ceiling, a pinned model with
//  no size) stays until someone edits the config, so waiting on it
//  only delays the refusal. A backend that did not answer may answer
//  on the next poll, so that one is waited on.
function findConfigGaps(terms) {
    const gaps = [];

    if (terms.ceilingBytes === null) {
        gaps.push(`the memory ceiling is unknown: ${terms.ceilingSource}`);
    }

    for (const term of terms.pinned) {
        if (term.bytes !== null) {
            continue;
        }

        gaps.push(
            `pinned model '${term.model}' has no known size; load it ` +
                `once or give it size_gib`,
        );
    }

    return gaps;
}

function findUnknowns(terms, configGaps) {
    const unknowns = [...configGaps];

    if (terms.residencyError !== null) {
        unknowns.push(
            `the backend could not say what is loaded: ` +
                terms.residencyError,
        );
    }

    return unknowns;
}

/**
 * Applies the formula.
 * @param {BudgetTerms} terms
 */
export function computeBudget(terms) {
    const configGaps = findConfigGaps(terms);
    const unknowns = findUnknowns(terms, configGaps);

    const knownPinned = terms.pinned
        .map((term) => term.bytes)
        .filter((bytes) => bytes !== null);

    const pinnedBytes = sum(knownPinned);
    const loadedBytes = sum(terms.loaded.map((model) => model.bytes));

    let freeBytes = null;

    //  Room left if nothing but the pinned models were held: what
    //  waiting could ever free. A request bigger than this never fits.
    let roomBytes = null;

    if (unknowns.length === 0) {
        roomBytes = terms.ceilingBytes - terms.marginBytes - pinnedBytes;
        freeBytes = roomBytes - loadedBytes - terms.reservedBytes;
    }

    return {
        ...terms,
        pinnedBytes,
        loadedBytes,
        freeBytes,
        roomBytes,
        unknowns,
        //  True when an unknown is a config gap: nothing admitted now
        //  will be admitted by waiting, so the refusal is immediate.
        configGap: configGaps.length > 0,
    };
}

/**
 * "30.2 GiB free (ceiling 96.0 - margin 8.0 - pinned 31.1 - loaded
 * 25.9 - reserved 0.0)". Every message that refuses or waits carries
 * this, so the reason can be checked by hand.
 * @param {ReturnType<typeof computeBudget>} budget
 * @returns {string}
 */
export function describeBudget(budget) {
    if (budget.unknowns.length > 0) {
        return `free memory is unknown: ${budget.unknowns.join("; ")}`;
    }

    const terms = [
        `ceiling ${formatGib(budget.ceilingBytes)}`,
        `margin ${formatGib(budget.marginBytes)}`,
        `pinned ${formatGib(budget.pinnedBytes)}`,
        `loaded ${formatGib(budget.loadedBytes)}`,
        `reserved ${formatGib(budget.reservedBytes)}`,
    ];

    return `${formatGib(budget.freeBytes)} free (${terms.join(" - ")})`;
}

function verdict(fits, reason, neverFits = false) {
    return { fits, neverFits, reason };
}

/**
 * Whether a job reservation fits now.
 * @param {ReturnType<typeof computeBudget>} budget
 * @param {number} bytes
 * @returns {{ fits: boolean, neverFits: boolean, reason: string }}
 */
export function decideReservation(budget, bytes) {
    const wanted = formatGib(bytes);

    if (budget.unknowns.length > 0) {
        return verdict(
            false,
            `${wanted} wanted, but ${describeBudget(budget)}`,
            budget.configGap,
        );
    }

    if (bytes > budget.roomBytes) {
        return verdict(
            false,
            `${wanted} can never fit: the ceiling less the margin and ` +
                `the pinned models leaves ${formatGib(budget.roomBytes)}`,
            true,
        );
    }

    if (bytes > budget.freeBytes) {
        return verdict(false, `${wanted} wanted; ${describeBudget(budget)}`);
    }

    return verdict(true, `${wanted} fits; ${describeBudget(budget)}`);
}

/**
 * Whether loading a model fits now. A pinned model always fits: its
 * space is already held out of `free`, so loading it changes nothing.
 * @param {ReturnType<typeof computeBudget>} budget
 * @param {{ model: string, pinned: boolean, bytes: number | null,
 *     source: string }} target
 * @returns {{ fits: boolean, neverFits: boolean, reason: string }}
 */
export function decideLoad(budget, target) {
    const name = `'${target.model}'`;

    if (target.pinned) {
        return verdict(true, `${name} is pinned; its space is already held`);
    }

    if (budget.unknowns.length > 0) {
        return verdict(
            false,
            `loading ${name} needs a budget, but ${describeBudget(budget)}`,
            budget.configGap,
        );
    }

    if (target.bytes === null) {
        return verdict(
            false,
            `${name} has no known size: it has not been seen loaded and ` +
                `has no size_gib`,
        );
    }

    const needed = formatGib(target.bytes);

    if (target.bytes > budget.roomBytes) {
        return verdict(
            false,
            `${name} needs ${needed} and can never fit: the ceiling ` +
                `less the margin and the pinned models leaves ` +
                formatGib(budget.roomBytes),
            true,
        );
    }

    if (target.bytes > budget.freeBytes) {
        return verdict(
            false,
            `${name} needs ${needed}; ${describeBudget(budget)}`,
        );
    }

    return verdict(
        true,
        `${name} needs ${needed} and fits; ${describeBudget(budget)}`,
    );
}
