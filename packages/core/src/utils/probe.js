//  =====================================================================
//  Which shuntd is on this port?
//  =====================================================================
//  Any process can hold a port, and two instances can be configured
//  for the same one. The router answers /shuntd/v1/status from memory
//  with its instance name and pid, so a probe never reaches the
//  upstream and never loads a model.

const PROBE_HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 1000;
const STATUS_PATH = "/shuntd/v1/status";

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
 * Asks whatever holds a local port whether it is shuntd.
 * @param {number} port
 * @returns {Promise<{instance: string | null, port: number,
 *     pid: number, version?: string} | null>} null when nothing
 *     answers or the answer is not from shuntd.
 */
export async function fetchShuntdStatus(port) {
    let response;

    try {
        response = await fetch(`http://${PROBE_HOST}:${port}${STATUS_PATH}`, {
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
 * will meet, including for a process that is not shuntd and so never
 * answers fetchShuntdStatus. The test listener closes at once.
 *
 * Only "address in use" counts as held. Any other failure is left to
 * the daemon to report when it starts.
 * @param {number} port
 * @returns {boolean}
 */
export function isPortHeld(port) {
    let listener;

    try {
        listener = Deno.listen({ hostname: PROBE_HOST, port });
    } catch (err) {
        return err instanceof Deno.errors.AddrInUse;
    }

    listener.close();

    return false;
}
