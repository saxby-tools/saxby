//  =====================================================================
//  Which saxbyd is on this port?
//  =====================================================================
//  Any process can hold a port, and two instances can be configured
//  for the same one. The router answers /saxby/v1/status from memory
//  with its instance name and pid, so a probe never reaches the
//  upstream and never loads a model.

const PROBE_HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 1000;
const STATUS_PATH = "/saxby/v1/status";

//  A wildcard bind answers on loopback too. Any other listen_host is
//  probed where it listens, so a daemon bound to one interface is not
//  reported stopped.
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Where to probe a daemon configured with this listen_host.
 * @param {string} listenHost - config.listen_host
 * @returns {string}
 */
export function probeHostFor(listenHost) {
    if (WILDCARD_HOSTS.has(listenHost)) {
        return PROBE_HOST;
    }

    return listenHost;
}

//  An IPv6 literal needs brackets in a URL; "::1" becomes "[::1]".
function hostForUrl(host) {
    if (!host.includes(":")) {
        return host;
    }

    if (host.startsWith("[")) {
        return host;
    }

    return `[${host}]`;
}

function isStatusShape(body) {
    if (typeof body !== "object" || body === null) {
        return false;
    }

    if (typeof body.pid !== "number") {
        return false;
    }

    if (typeof body.port !== "number") {
        return false;
    }

    if (body.instance !== null && typeof body.instance !== "string") {
        return false;
    }

    return true;
}

/**
 * Asks whatever holds a local port whether it is saxbyd.
 * @param {number} port
 * @param {string} [host] - from probeHostFor; loopback when omitted.
 * @returns {Promise<{instance: string | null, port: number,
 *     pid: number, version?: string} | null>} null when nothing
 *     answers or the answer is not from saxbyd.
 */
export async function fetchSaxbyStatus(port, host = PROBE_HOST) {
    const url = `http://${hostForUrl(host)}:${port}${STATUS_PATH}`;

    let response;

    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    } catch {
        return null;
    }

    if (!response.ok) {
        await response.body?.cancel();
        return null;
    }

    let body;

    try {
        body = await response.json();
    } catch {
        return null;
    }

    if (!isStatusShape(body)) {
        return null;
    }

    return body;
}

/**
 * Whether something already holds a local port, found by trying to
 * listen on it the way the daemon does. Answers exactly what startup
 * will meet, including for a process that is not saxbyd and so never
 * answers fetchSaxbyStatus. The test listener closes at once.
 *
 * Only "address in use" counts as held. Any other failure is left to
 * the daemon to report when it starts.
 * @param {number} port
 * @param {string} [host] - from probeHostFor; loopback when omitted.
 * @returns {boolean}
 */
export function isPortHeld(port, host = PROBE_HOST) {
    let listener;

    try {
        listener = Deno.listen({ hostname: host, port });
    } catch (err) {
        return err instanceof Deno.errors.AddrInUse;
    }

    listener.close();

    return false;
}
