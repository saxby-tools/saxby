//  =====================================================================
//  Memory limiters
//  =====================================================================
//  The ledger stops a job from STARTING when memory is short. A limiter
//  stops a running job from growing past what it reserved, by setting
//  the cap its framework reads from the environment. Mirrors the other
//  registries: one static class each, picked by isSupported(). Every
//  supported limiter applies, since one job may use more than one
//  framework.
//
//  Built: PyTorch on Apple's GPU. Future, documented in
//  docs/memory-broker.md: a Linux limiter that runs the job in a
//  systemd-run scope with MemoryMax, and caps for MLX and CUDA.

import { MpsWatermarkLimiter } from "./mps.js";

export { MpsWatermarkLimiter };

/**
 * @typedef {Object} MemoryLimiter
 * @property {string} id
 * @property {string} displayName
 * @property {() => boolean} isSupported - True on this limiter's OS.
 * @property {(plan: { reservedBytes: number,
 *     ceilingBytes: number | null, ceilingSource: string | null }) =>
 *     { env: Record<string, string> } | { problem: string }} environment
 */

/** @type {MemoryLimiter[]} */
export const MEMORY_LIMITERS = [MpsWatermarkLimiter];

/**
 * Every limiter for this platform.
 * @returns {MemoryLimiter[]}
 */
export function findMemoryLimiters() {
    return MEMORY_LIMITERS.filter((limiter) => limiter.isSupported());
}
