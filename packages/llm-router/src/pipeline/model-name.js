//  =====================================================================
//  Requested model names
//  =====================================================================
//  The `model` field of a request decides whether Saxby routes at all:
//
//    saxby          -> route   run the tiers and pick a model
//    saxby/<model>  -> bypass  send straight to <model>
//    anything else  -> raw     pass through unchanged
//
//  The chat route, the explain endpoint and /v1/models all read this
//  one rule. explain once carried no copy of it and routed everything,
//  so it reported decisions the chat route never made.

/**
 * The model name a client asks for to be routed. The only name that
 * runs the tiers; it is also what /v1/models lists first.
 */
export const SAXBY_MODEL = "saxby";

/**
 * The prefix that names a bypass: `saxby/<model>` goes straight to
 * `<model>`, logged but never routed.
 */
export const SAXBY_PREFIX = `${SAXBY_MODEL}/`;

/**
 * Classifies a requested model name.
 *
 * `target` is the model a bypass or raw request goes to, and null for
 * a routed one, whose model the tiers pick. A missing name is raw
 * with an empty target, which is what the chat route forwards.
 *
 * @param {string | null | undefined} rawModel
 * @returns {{ mode: "route" | "bypass" | "raw", target: string | null }}
 */
export function classifyModel(rawModel) {
    const name = rawModel || "";

    if (name === SAXBY_MODEL) {
        return { mode: "route", target: null };
    }

    if (name.startsWith(SAXBY_PREFIX)) {
        return {
            mode: "bypass",
            target: name.slice(SAXBY_PREFIX.length),
        };
    }

    return { mode: "raw", target: name };
}
