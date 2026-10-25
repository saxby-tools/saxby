//  =====================================================================
//  Client identification
//  =====================================================================
//  ONE mechanism: read the most specific self-identifying signal the
//  client sent, normalise it to a signature, then map that signature
//  to a friendly name the user controls.
//
//  User-Agent is the source of truth. That is literally what the
//  header is for, it costs nothing, it requires no client-side
//  configuration, and it degrades to something readable rather than
//  to nothing. App-specific headers override it only when a client
//  announces itself more precisely than its HTTP library does.
//
//  Deliberately NOT used:
//
//    Authorization  — overloading a credential field with an identity
//                     label is an antipattern. A future reader finds
//                     fake keys in config and reasonably assumes they
//                     are secrets.
//    Source port    — ephemeral and random per connection. Carries no
//                     information about which application connected.
//    Source IP      — identifies a machine, not an app. Everything on
//                     localhost is 127.0.0.1, and anything behind
//                     Docker or OrbStack arrives as the bridge.
//    PID lookup     — would work on bare metal via the OS, but costs a
//                     subprocess per request, is platform-specific,
//                     and returns the container runtime rather than
//                     the app for anything containerised.
//
//  Three columns are stored so a mapping added later can be applied
//  retroactively: the friendly name, the signature it was derived
//  from, and the raw User-Agent. Nothing is lossy.

//  Headers that identify an application more precisely than its HTTP
//  library's User-Agent does. Presence alone is the signal — the
//  values are not read, because they identify a PERSON rather than an
//  application and the archive does not need them.
//
//  Open WebUI sends either the separate user headers or, when
//  FORWARD_USER_INFO_HEADER_JWT_SECRET is set, one signed JWT in
//  their place (utils/headers.py, v0.12). Both default names are
//  listed; renamed headers cannot be recognized.
const APP_HEADERS = [
    { header: "x-openwebui-user-id", signature: "open-webui" },
    { header: "x-openwebui-user-name", signature: "open-webui" },
    { header: "x-openwebui-user-jwt", signature: "open-webui" },
];

//  Product token, i.e. everything before the first slash or space.
//  "OpenClaw/2026.6.11 (darwin)" -> "openclaw"
//  "python-httpx/0.27.0"         -> "python-httpx"
const UA_PRODUCT = /^([A-Za-z][\w.-]*)/;

/**
 * Finds an app header that identifies the client.
 */
function readAppHeader(getHeader) {
    for (const candidate of APP_HEADERS) {
        if (!getHeader(candidate.header)) {
            continue;
        }

        return candidate.signature;
    }

    return null;
}

/**
 * Pulls the product token out of a User-Agent string.
 */
function readUserAgentProduct(userAgent) {
    if (!userAgent) {
        return null;
    }

    const match = userAgent.trim().match(UA_PRODUCT);

    if (!match) {
        return null;
    }

    return match[1].toLowerCase();
}

/**
 * Identifies the calling client.
 *
 * @param {(name: string) => string|undefined} getHeader
 * @param {Object} config - Saxby config; config.client_names maps a
 *   signature to a friendly name, e.g. {"python-httpx": "my-script"}
 *
 * @returns {{id, signature, source, userAgent}}
 *   id        friendly name, after mapping
 *   signature normalised token the mapping was keyed on
 *   source    app_header | user_agent | unknown
 *   userAgent raw header, stored so mappings can be backfilled
 */
export function identifyClient(getHeader, config) {
    const userAgent = getHeader("user-agent") || null;
    const names = config.client_names || {};

    //  ---- Most specific: the app announced itself ------------------
    const fromApp = readAppHeader(getHeader);

    if (fromApp) {
        return {
            id: names[fromApp] || fromApp,
            signature: fromApp,
            source: "app_header",
            userAgent,
        };
    }

    //  ---- Idiomatic: the User-Agent --------------------------------
    const product = readUserAgentProduct(userAgent);

    if (product) {
        return {
            id: names[product] || product,
            signature: product,
            source: "user_agent",
            userAgent,
        };
    }

    //  ---- Nothing to go on -----------------------------------------
    //  Correct outcome, not a failure. An unidentified client is
    //  still a countable bucket, and the raw User-Agent (null here)
    //  is stored either way.
    return {
        id: "unknown",
        signature: "unknown",
        source: "unknown",
        userAgent,
    };
}

/**
 * Lists signatures seen in the log that have no friendly name yet.
 *
 * Written for a `saxby clients` command that does not exist yet: the
 * user would run it, see what has actually been hitting the router,
 * and name anything worth naming. Nothing calls this today.
 */
export function unmappedSignatures(rows, config) {
    const names = config.client_names || {};
    const unmapped = new Map();

    for (const row of rows) {
        if (names[row.client_signature]) {
            continue;
        }

        const seen = unmapped.get(row.client_signature) || {
            signature: row.client_signature,
            userAgent: row.user_agent,
            requests: 0,
        };

        seen.requests++;
        unmapped.set(row.client_signature, seen);
    }

    return [...unmapped.values()].sort((a, b) => b.requests - a.requests);
}

/**
 * SHA-256 of the prompt, hex encoded.
 *
 * Always stored, even when prompt text is not. Groups repeats and
 * regenerations without retaining content.
 */
export async function hashPrompt(text) {
    const bytes = new TextEncoder().encode(text || "");
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
