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

//  "Bearer <token>", the scheme matched in any case and followed by
//  spaces or tabs, as HTTP allows.
const BEARER = /^Bearer[\x20\t]+(\S+)$/i;

//  A request may carry several Authorization headers, which arrive
//  joined by commas.
const CREDENTIAL_SEPARATOR = ",";

/**
 * Pulls every bearer token out of an Authorization header.
 *
 * All of them, not the first: main.js keeps Saxby's token from the
 * backend by asking whether the request carried it, and a token
 * hidden behind a second credential would otherwise be passed on.
 * @param {string | null | undefined} authorization
 * @returns {string[]} empty when there is no bearer token
 */
function readBearers(authorization) {
    if (!authorization) {
        return [];
    }

    const found = [];

    for (const credential of authorization.split(CREDENTIAL_SEPARATOR)) {
        const match = credential.trim().match(BEARER);

        if (match) {
            found.push(match[1]);
        }
    }

    return found;
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

    const presented = readBearers(authorization);

    if (presented.length === 0) {
        return TOKEN_MISSING;
    }

    //  Every one is compared, so the time taken does not say which
    //  position matched.
    let matched = false;

    for (const candidate of presented) {
        if (sameApiToken(candidate, apiToken)) {
            matched = true;
        }
    }

    return matched ? TOKEN_VALID : TOKEN_INVALID;
}
