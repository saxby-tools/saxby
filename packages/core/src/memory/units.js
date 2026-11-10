//  =====================================================================
//  Memory units
//  =====================================================================
//  Sizes travel as integer bytes everywhere a program reads them: the
//  HTTP API, the ledger and the decision log. GiB is for people: the
//  --gib flag, the config and every message. Converting in one place
//  keeps a 1000-versus-1024 slip out of the budget.

/** Bytes in one MiB, the unit `iogpu.wired_limit_mb` reports. */
export const BYTES_PER_MIB = 2 ** 20;

/** Bytes in one GiB, the unit people write. */
export const BYTES_PER_GIB = 2 ** 30;

/**
 * GiB as a person wrote it to the whole bytes the API and the ledger
 * store.
 * @param {number} gib
 * @returns {number} Whole bytes.
 */
export function gibToBytes(gib) {
    return Math.round(gib * BYTES_PER_GIB);
}

/**
 * Bytes to GiB, unrounded. formatGib is the one for messages.
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
