//  =====================================================================
//  PyTorch MPS memory cap
//  =====================================================================
//  The Oct. 27 panic was a PyTorch job on Apple's GPU that grew to
//  122 GiB. PyTorch's GPU allocator caps itself at a ratio of Metal's
//  recommendedMaxWorkingSetSize, which equals iogpu.wired_limit_mb
//  when that is set (memory/probes/darwin.js in @saxby/core). Its
//  default ratio, 1.7, is no cap at all on unified memory.
//
//  `saxby reserve` sets the ratio so PyTorch fails with an
//  out-of-memory error at the reservation instead of growing past it.
//
//  Two traps, from PyTorch's MPSAllocator.mm:
//
//    0.0 DISABLES the cap.   A ratio that rounds to zero must never
//                            be sent; a reservation that small is
//                            refused instead.
//    LOW must not exceed     The low watermark defaults to 1.4. Setting
//    HIGH.                   only HIGH below that makes PyTorch fail
//                            at startup, so LOW is set too, at
//                            PyTorch's own 1.4 : 1.7 proportion.
//
//  Ratios are rounded DOWN, so the cap never lands above the
//  reservation. MLX jobs read neither variable; the ledger still
//  counts them.

const HIGH_WATERMARK_VAR = "PYTORCH_MPS_HIGH_WATERMARK_RATIO";
const LOW_WATERMARK_VAR = "PYTORCH_MPS_LOW_WATERMARK_RATIO";

//  PyTorch's defaults and its upper bound for HIGH.
const DEFAULT_HIGH_RATIO = 1.7;
const DEFAULT_LOW_RATIO = 1.4;
const MAX_HIGH_RATIO = 2.0;

//  Six places: one step is about 100 KiB of a 96 GiB ceiling.
const RATIO_PLACES = 6;
const RATIO_SCALE = 10 ** RATIO_PLACES;

function roundDown(ratio) {
    return Math.floor(ratio * RATIO_SCALE) / RATIO_SCALE;
}

function formatRatio(ratio) {
    return ratio.toFixed(RATIO_PLACES);
}

export class MpsWatermarkLimiter {
    static id = "pytorch-mps";
    static displayName = "PyTorch MPS watermarks";

    static isSupported() {
        return Deno.build.os === "darwin";
    }

    /**
     * The environment that caps PyTorch at the reservation.
     * @param {{ reservedBytes: number, ceilingBytes: number | null }} plan
     * @returns {{ env: Record<string, string> } | { problem: string }}
     */
    static environment(plan) {
        if (!plan.ceilingBytes) {
            return {
                problem: "the GPU's maximum is unknown, so PyTorch's cap " +
                    "has nothing to divide by",
            };
        }

        const high = roundDown(plan.reservedBytes / plan.ceilingBytes);

        if (high <= 0) {
            return {
                problem: "the reservation is too small to express as a " +
                    "PyTorch ratio, and a ratio of 0 turns the cap off",
            };
        }

        if (high > MAX_HIGH_RATIO) {
            return {
                problem: `the reservation is more than ${MAX_HIGH_RATIO} ` +
                    `times the GPU's maximum, which PyTorch refuses`,
            };
        }

        const low = roundDown(high * DEFAULT_LOW_RATIO / DEFAULT_HIGH_RATIO);

        return {
            env: {
                [HIGH_WATERMARK_VAR]: formatRatio(high),
                [LOW_WATERMARK_VAR]: formatRatio(low),
            },
        };
    }
}
