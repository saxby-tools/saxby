//  =====================================================================
//  Memory units
//  =====================================================================
//  Sizes travel as integer bytes everywhere a program reads them: the
//  HTTP API, the ledger and the decision log. GiB is for people: the
//  --gib flag, the config and every message. Converting in one place
//  keeps a 1000-versus-1024 slip out of the budget.

export const BYTES_PER_MIB = 2 ** 20;
export const BYTES_PER_GIB = 2 ** 30;

/**
 * @param {number} gib
 * @returns {number} Whole bytes.
 */
export function gibToBytes(gib) {
    return Math.round(gib * BYTES_PER_GIB);
}

/**
 * @param {number} bytes
 * @returns {number}
 */
export function bytesToGib(bytes) {
    return bytes / BYTES_PER_GIB;
}

/**
 * "25.6 GiB". One decimal: the budget's own margin is whole GiB, so
 * finer digits would only look precise.
 * @param {number} bytes
 * @returns {string}
 */
export function formatGib(bytes) {
    return `${bytesToGib(bytes).toFixed(1)} GiB`;
}
