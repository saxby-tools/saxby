//  =====================================================================
//  The memory gate, as a route sees it
//  =====================================================================
//  The broker decides whether a model may load (broker.js). This is
//  the part every route that forwards a load shares: turn the broker's
//  answer into an HTTP outcome, and keep the hold it handed out until
//  the response's first byte. Two routes forward loads, chat and the
//  catch-all, and a gate one had and the other lacked was issue #33.
//
//  The caller checks broker.hasJobs() itself, before anything here is
//  called, so with no job held the fast path never awaits.

import { CODE_ABANDONED } from "./broker.js";

/**
 * The status for a client that left while its load waited. Nginx's
 * code for it; HTTP has none.
 */
export const STATUS_CLIENT_LEFT = 499;

/** The status when memory could not hold the model within the wait. */
export const STATUS_MEMORY_REFUSED = 503;

/** The gate's outcome when the load may go ahead. */
export const OUTCOME_ADMITTED = "admitted";

/** The gate's outcome when the client left during the wait. */
export const OUTCOME_ABANDONED = "abandoned";

/** The gate's outcome when the broker said no. */
export const OUTCOME_REFUSED = "refused";

/**
 * Keeps the hold the broker handed out, and releases it once. The
 * release is called from the first byte, from the end of the stream
 * and from every early return, whichever comes first, so a hold
 * released twice would charge the ledger a release it never took.
 * @returns {{ take: (hold: { release: () => void } | null) => void,
 *     release: () => void, taken: () => boolean }}
 */
export function createLoadHold() {
    let hold = null;

    function take(next) {
        hold = next;
    }

    function release() {
        if (!hold) {
            return;
        }

        hold.release();
        hold = null;
    }

    function taken() {
        return hold !== null;
    }

    return { take, release, taken };
}

/**
 * The body of a 503, the same from every route, so a client reads one
 * shape wherever its load was refused.
 */
function refusalBody(gate) {
    return {
        error: {
            message: `Saxby is holding GPU memory for a running job: ` +
                `${gate.reason}`,
            type: "server_error",
            code: gate.code,
        },
    };
}

/**
 * Asks the broker to let `model` load. Call it only while
 * broker.hasJobs() is true.
 * @param {{ gateLoad: Function }} broker
 * @param {string} model - The model the request will be sent to.
 * @param {{ requestId: string, signal?: AbortSignal }} context
 * @returns {Promise<
 *     { outcome: "admitted", hold: { release: () => void } | null } |
 *     { outcome: "abandoned" } |
 *     { outcome: "refused", reason: string, body: Object }>}
 */
export async function admitLoad(broker, model, context) {
    const gate = await broker.gateLoad(model, context);

    if (gate.code === CODE_ABANDONED) {
        return { outcome: OUTCOME_ABANDONED };
    }

    if (!gate.admitted) {
        return {
            outcome: OUTCOME_REFUSED,
            reason: gate.reason,
            body: refusalBody(gate),
        };
    }

    return { outcome: OUTCOME_ADMITTED, hold: gate.hold };
}
