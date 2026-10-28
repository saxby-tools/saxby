//  =====================================================================
//  Memory probes
//  =====================================================================
//  Mirrors the service and backend adapter registries: one static
//  class per platform, picked by isSupported(). A probe reports facts
//  only. Filling a gap from the config, and deciding what an unknown
//  means, belong to the broker that reads it.

import { DarwinMemoryProbe, WIRED_LIMIT_KEY } from "./darwin.js";
import { LinuxMemoryProbe } from "./linux.js";

export { DarwinMemoryProbe, LinuxMemoryProbe, WIRED_LIMIT_KEY };

/**
 * @typedef {Object} MemoryReading
 * @property {number | null} ceilingBytes - The most the GPU may hold,
 *     or null when this machine cannot say.
 * @property {string} ceilingSource - Where the ceiling came from, or
 *     why it is unknown. Shown in messages and logged.
 * @property {number | null} usedBytes - Memory in use now (wired
 *     pages on macOS). Observed for the log, never budgeted.
 * @property {string} usedSource
 */

/**
 * @typedef {Object} MemoryProbe
 * @property {string} id
 * @property {string} displayName
 * @property {() => boolean} isSupported - True on this probe's OS.
 * @property {() => Promise<MemoryReading>} read - Never throws.
 */

/** @type {MemoryProbe[]} */
export const MEMORY_PROBES = [DarwinMemoryProbe, LinuxMemoryProbe];

/**
 * The probe for this platform, or null when none supports it.
 * @returns {MemoryProbe | null}
 */
export function findMemoryProbe() {
    return MEMORY_PROBES.find((probe) => probe.isSupported()) ?? null;
}
