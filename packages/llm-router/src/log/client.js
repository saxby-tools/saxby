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
//  A browser extension is the one client whose User-Agent says
//  nothing: it sends the browser's, the same for every extension. Its
//  Origin names it exactly, and the browser sets that header, not the
//  extension. So an extension's signature is its id, as "ext-<id>".
//  The guard has already refused any origin not in `allowed_origins`.
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

import { EXTENSION_ORIGIN } from "@saxby/core";

//  Headers that identify an application more precisely than its HTTP
//  library's User-Agent does. Two kinds of rule.
//
//  A value rule takes the header's value as the name. X-Title is
//  OpenRouter's convention for a client to say what it is, and it is
//  how two clients built on the same SDK, which send the same
//  User-Agent, log apart (#21). It goes first: a client that names
//  itself has been more precise than one that only shows it is there.
//
//  A presence rule names the app itself, and the value is not read,
//  because it identifies a PERSON rather than an application and the
//  archive does not need it. Open WebUI sends either the separate
//  user headers or, when FORWARD_USER_INFO_HEADER_JWT_SECRET is set,
//  one signed JWT in their place (utils/headers.py, v0.12). Both
//  default names are listed; renamed headers cannot be recognized.
const APP_HEADERS = [
    { header: "x-title", fromValue: true },
    { header: "x-openwebui-user-id", signature: "open-webui" },
    { header: "x-openwebui-user-name", signature: "open-webui" },
    { header: "x-openwebui-user-jwt", signature: "open-webui" },
];

//  A title is reduced to the character set of a product token (below),
//  lowercased, so it is a key client_names can hold: each run of
//  anything else becomes one hyphen, and the ends are trimmed.
//  "My Agent (dev)" -> "my-agent-dev"
const TITLE_OTHER = /[^a-z0-9_.-]+/g;
const TITLE_EDGE = /^-+|-+$/g;

//  Prefix of a browser extension's signature: "ext-<id>". The prefix
//  keeps a Firefox id, which may start with a digit, in the shape
//  the config accepts for a signature.
const EXTENSION_PREFIX = "ext-";

//  Product token, i.e. everything before the first slash or space.
//  "OpenClaw/2026.6.11 (darwin)" -> "openclaw"
//  "python-httpx/0.27.0"         -> "python-httpx"
const UA_PRODUCT = /^([A-Za-z][\w.-]*)/;

/**
 * Reads a browser extension's id from its Origin header.
 */
function readExtensionOrigin(origin) {
    if (!origin) {
        return null;
    }

    const match = origin.toLowerCase().match(EXTENSION_ORIGIN);

    if (!match) {
        return null;
    }

    return `${EXTENSION_PREFIX}${match[2]}`;
}

/**
 * Reduces a client's own name for itself to a signature. An empty
 * or blank title is no name at all, and the User-Agent applies.
 */
function readTitle(value) {
    const title = value
        .trim()
        .toLowerCase()
        .replace(TITLE_OTHER, "-")
        .replace(TITLE_EDGE, "");

    if (!title) {
        return null;
    }

    return title;
}

/**
 * Finds an app header that identifies the client.
 */
function readAppHeader(getHeader) {
    for (const candidate of APP_HEADERS) {
        const value = getHeader(candidate.header);

        if (!value) {
            continue;
        }

        if (!candidate.fromValue) {
            return candidate.signature;
        }

        const title = readTitle(value);

        if (!title) {
            continue;
        }

        return title;
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
 *   source    origin | app_header | user_agent | unknown
 *   userAgent raw header, stored so mappings can be backfilled
 */
export function identifyClient(getHeader, config) {
    const userAgent = getHeader("user-agent") || null;
    const names = config.client_names || {};

    //  ---- A browser extension: its origin is its name --------------
    const fromOrigin = readExtensionOrigin(getHeader("origin"));

    if (fromOrigin) {
        return {
            id: names[fromOrigin] || fromOrigin,
            signature: fromOrigin,
            source: "origin",
            userAgent,
        };
    }

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
 * The name of the prompt hash in use, stamped on every row so a
 * reader can tell these hashes from the plain SHA-256 of rows written
 * before v0.9.7.
 */
export const PROMPT_HASH_SCHEME = "hmac-sha256";

const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" };

function toHex(buffer) {
    return [...new Uint8Array(buffer)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Builds the prompt hasher for one key.
 *
 * The hash is always stored, even when prompt text is not: it groups
 * repeats and regenerations without retaining content. It is keyed so
 * that nobody can hash a guess and confirm a short prompt against a
 * log they were given, and so a table of common prompts matches no
 * install but the one whose key it was built with.
 *
 * @param {Uint8Array} keyBytes - the instance's key
 * @returns {Promise<(text: string) => Promise<string>>} hex HMAC
 */
export async function createPromptHasher(keyBytes) {
    const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        HMAC_ALGORITHM,
        false,
        ["sign"],
    );

    return async function hashPrompt(text) {
        const bytes = new TextEncoder().encode(text || "");
        const signature = await crypto.subtle.sign(HMAC_ALGORITHM, key, bytes);

        return toHex(signature);
    };
}
