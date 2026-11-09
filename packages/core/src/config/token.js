//  =====================================================================
//  The API token
//  =====================================================================
//  One shared secret per instance. saxbyd asks for it from every
//  request that does not come straight from this machine: through a
//  trusted proxy, or over a listener that is not loopback. Local
//  clients never need it.
//
//  It lives in a file beside the config, not in config.jsonc: the
//  config gets pasted into issues, and a secret there would go with
//  it. saxbyd writes a random token at first boot. The operator may
//  put their own in the file instead; a short one is accepted and
//  warned about, never refused.
//
//  It identifies nobody. Every client holds the same token, so the
//  decision log still names clients by User-Agent.
//
//  In core because two packages use it: saxbyd checks the token, and
//  `saxby token` shows and replaces it.

import { join } from "@std/path";

export const API_TOKEN_FILE = "api-token";

//  256 bits, written as 64 hex characters.
const TOKEN_BYTES = 32;

//  Below this a token is within reach of guessing. Generated tokens
//  are 64 characters, so only one typed by hand can be this short.
const WEAK_TOKEN_LENGTH = 32;

const MODE_FILE = 0o600;

//  A token travels in an HTTP header, so it must be one line of
//  visible ASCII.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/**
 * Where an instance keeps its token.
 * @param {string} instanceDir - from getInstanceDir
 * @returns {string}
 */
export function apiTokenPath(instanceDir) {
    return join(instanceDir, API_TOKEN_FILE);
}

/**
 * A fresh random token.
 * @returns {string} 64 hex characters
 */
export function generateApiToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));

    return [...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Whether a token is short enough to guess.
 * @param {string} token
 * @returns {boolean}
 */
export function isWeakApiToken(token) {
    return token.length < WEAK_TOKEN_LENGTH;
}

function assertTokenShape(token, path) {
    if (TOKEN_SHAPE.test(token)) {
        return;
    }

    throw new Error(
        `${path} does not hold a usable API token. It must be one ` +
            `line of letters, digits and symbols, with no spaces. ` +
            `Run 'saxby token rotate' to write a new one.`,
    );
}

/**
 * Writes a token, owner-only. The file is removed first so that a
 * replaced token never inherits a wider mode from the old file.
 * @param {string} instanceDir
 * @param {string} token
 * @returns {Promise<string>} the path written
 */
export async function writeApiToken(instanceDir, token) {
    const path = apiTokenPath(instanceDir);

    assertTokenShape(token, path);

    await Deno.mkdir(instanceDir, { recursive: true });

    try {
        await Deno.remove(path);
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            throw err;
        }
    }

    await Deno.writeTextFile(path, `${token}\n`, {
        mode: MODE_FILE,
        createNew: true,
    });

    return path;
}

/**
 * Reads an instance's token.
 * @param {string} instanceDir
 * @returns {Promise<string | null>} null when no token file exists
 */
export async function readApiToken(instanceDir) {
    const path = apiTokenPath(instanceDir);

    let text;

    try {
        text = await Deno.readTextFile(path);
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            return null;
        }

        throw err;
    }

    const token = text.trim();

    assertTokenShape(token, path);

    return token;
}

/**
 * Reads an instance's token, writing a random one first if the file
 * is missing. An existing file is made owner-only again if its mode
 * has drifted.
 * @param {string} instanceDir
 * @returns {Promise<{ token: string, path: string, created: boolean }>}
 */
export async function readOrCreateApiToken(instanceDir) {
    const path = apiTokenPath(instanceDir);
    const existing = await readApiToken(instanceDir);

    if (existing !== null) {
        await Deno.chmod(path, MODE_FILE);

        return { token: existing, path, created: false };
    }

    const token = generateApiToken();

    await writeApiToken(instanceDir, token);

    return { token, path, created: true };
}

/**
 * Compares two tokens in time that depends only on their lengths, so
 * a wrong guess does not reveal how much of it was right.
 * @param {string} presented
 * @param {string} expected
 * @returns {boolean}
 */
export function sameApiToken(presented, expected) {
    const encoder = new TextEncoder();
    const a = encoder.encode(presented);
    const b = encoder.encode(expected);

    if (a.length !== b.length) {
        return false;
    }

    let difference = 0;

    for (let i = 0; i < a.length; i++) {
        difference |= a[i] ^ b[i];
    }

    return difference === 0;
}
