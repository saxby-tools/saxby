//  =====================================================================
//  Where saxbyd listens
//  =====================================================================
//  The config's listen_host is accepted as written: a container's
//  loopback is unreachable from outside it, and a lab box binds one
//  interface on purpose. What saxbyd owes the operator is a plain
//  word at boot about what the bind means, which main.js prints from
//  these two answers:
//
//    not loopback          other machines can reach the port, and
//                          each must send the API token
//    loopback, in a        the published port will never answer, so
//    container             the usual first-run mistake is named
//
//  Pure except for the file checks, which are injected for tests.

//  Every address in 127.0.0.0/8 is loopback, not just .1.
const LOOPBACK_V4_PREFIX = "127.";

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]"]);

//  Docker writes the first, Podman the second. Neither is a promise,
//  so a hit only earns a hint, never a refusal.
const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"];

/**
 * Whether a bind address reaches only this machine.
 * @param {string} host - config.listen_host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
    const value = host.trim().toLowerCase();

    if (value.startsWith(LOOPBACK_V4_PREFIX)) {
        return true;
    }

    return LOOPBACK_HOSTS.has(value);
}

async function fileExists(path) {
    try {
        await Deno.stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Whether saxbyd seems to run inside a container.
 * @param {(path: string) => Promise<boolean>} [exists] - Injected by
 *     tests.
 * @returns {Promise<boolean>}
 */
export async function isInContainer(exists = fileExists) {
    for (const marker of CONTAINER_MARKERS) {
        if (await exists(marker)) {
            return true;
        }
    }

    return false;
}
