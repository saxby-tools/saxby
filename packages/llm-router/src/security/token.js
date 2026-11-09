//  =====================================================================
//  The caller's API token
//  =====================================================================
//  Works out how the token a request carries compares with this
//  instance's, so the guard can stay pure: it is handed one of four
//  words and never sees a secret. Which requests need a token at all
//  is the guard's decision (guard.js), not this file's.

import { sameApiToken } from "@saxby/core";
import {
    TOKEN_INVALID,
    TOKEN_MISSING,
    TOKEN_UNAVAILABLE,
    TOKEN_VALID,
} from "./guard.js";

//  "Bearer <token>", the scheme matched in any case, as HTTP requires.
const BEARER = /^Bearer\x20+(\S+)\s*$/i;

/**
 * Pulls the token out of an Authorization header.
 * @param {string | null | undefined} authorization
 * @returns {string | null} null when there is no bearer token
 */
function readBearer(authorization) {
    if (!authorization) {
        return null;
    }

    const match = authorization.match(BEARER);

    if (!match) {
        return null;
    }

    return match[1];
}

/**
 * Compares a request's token with this instance's.
 * @param {string | null | undefined} authorization - the request's
 *     Authorization header
 * @param {string | null} apiToken - this instance's token, or null
 *     when saxbyd could not read its token file
 * @returns {string} one of the guard's TOKEN_ constants
 */
export function tokenStateFor(authorization, apiToken) {
    if (apiToken === null) {
        return TOKEN_UNAVAILABLE;
    }

    const presented = readBearer(authorization);

    if (presented === null) {
        return TOKEN_MISSING;
    }

    if (sameApiToken(presented, apiToken)) {
        return TOKEN_VALID;
    }

    return TOKEN_INVALID;
}
