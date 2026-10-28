//  =====================================================================
//  Reservations client
//  =====================================================================
//  `saxby reserve` talks to saxbyd's /saxby/v1/reservations. Every call
//  that cannot reach saxbyd throws BrokerUnreachable, so the wrapper
//  can fail closed: no answer from the broker is never a yes.

const HOST = "127.0.0.1";
const BASE_PATH = "/saxby/v1/reservations";

//  A create is held open while saxbyd waits for room, up to the job's
//  timeout. This much more covers a slow budget read at the end.
const CREATE_GRACE_MS = 30_000;

const QUICK_TIMEOUT_MS = 5000;

const MS_PER_S = 1000;

export class BrokerUnreachable extends Error {
    constructor(port, cause) {
        super(`saxbyd did not answer on ${HOST}:${port}: ${cause.message}`);
        this.name = "BrokerUnreachable";
    }
}

/**
 * @param {number} port - The instance's listen_port.
 * @param {typeof fetch} [fetchImpl] - Injected by tests.
 */
export function createReservationClient(port, fetchImpl = fetch) {
    const base = `http://${HOST}:${port}${BASE_PATH}`;

    /**
     * @returns {Promise<{ status: number, body: Object | null }>}
     */
    async function send(path, init, signal) {
        let res;

        try {
            res = await fetchImpl(`${base}${path}`, {
                ...init,
                headers: { "Content-Type": "application/json" },
                signal,
            });
        } catch (err) {
            if (err.name === "AbortError") {
                throw err;
            }

            throw new BrokerUnreachable(port, err);
        }

        let body = null;

        try {
            body = await res.json();
        } catch {
            //  A 499 or a non-JSON answer has no body to read.
        }

        return { status: res.status, body };
    }

    /**
     * Asks for memory and waits for the answer. `signal` is the user's
     * Ctrl-C; the grace timeout catches a saxbyd that never answers.
     * The request must name timeout_s, so the grace is measured from
     * the wait saxbyd will really make.
     */
    function create(request, signal) {
        if (typeof request.timeout_s !== "number") {
            throw new TypeError("create() needs timeout_s");
        }

        const limit = AbortSignal.timeout(
            request.timeout_s * MS_PER_S + CREATE_GRACE_MS,
        );

        const signals = signal ? [signal, limit] : [limit];

        return send("", {
            method: "POST",
            body: JSON.stringify(request),
        }, AbortSignal.any(signals));
    }

    function heartbeat(id, childPid) {
        return send(`/${id}/heartbeat`, {
            method: "POST",
            body: JSON.stringify({ child_pid: childPid }),
        }, AbortSignal.timeout(QUICK_TIMEOUT_MS));
    }

    function release(id) {
        return send(`/${id}`, {
            method: "DELETE",
        }, AbortSignal.timeout(QUICK_TIMEOUT_MS));
    }

    return { create, heartbeat, release, base };
}
