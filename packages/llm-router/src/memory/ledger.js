//  =====================================================================
//  Reservation ledger
//  =====================================================================
//  What the broker has promised, held in memory only. Two kinds:
//
//    job    a `saxby reserve` wrapper and its child. Lives until the
//           wrapper releases it or every one of its processes has died.
//    hold   a model load the broker let through. Lives until the
//           first byte comes back, when the backend lists the model
//           and its size counts as loaded instead. Without it, two
//           different models could load at once on the same free
//           space.
//
//  A saxbyd restart empties the ledger. Every live wrapper notices on
//  its next heartbeat (404) and registers again with the same id, so
//  the ledger rebuilds within one heartbeat interval.
//
//  No awaits anywhere in here. The broker reads the backend, then
//  computes and adds in one synchronous step, so two requests can
//  never both be admitted against the same free space.

const KIND_JOB = "job";
const KIND_HOLD = "hold";

/**
 * @typedef {Object} LedgerEntry
 * @property {string} id
 * @property {"job" | "hold"} kind
 * @property {number} bytes
 * @property {string | null} label - Jobs: the command's name.
 * @property {number | null} pid - Jobs: the wrapper.
 * @property {number | null} childPid - Jobs: the command it runs.
 * @property {string | null} model - Holds: the model being loaded.
 * @property {string | null} requestId - Holds: the chat request.
 * @property {string} createdAt - ISO8601.
 * @property {number} createdMs
 * @property {string} lastHeartbeatAt - ISO8601.
 */

/**
 * @param {() => number} [now] - Milliseconds; injected by tests.
 */
export function createLedger(now = () => Date.now()) {
    /** @type {Map<string, LedgerEntry>} */
    const entries = new Map();

    function stamp() {
        const ms = now();

        return { ms, iso: new Date(ms).toISOString() };
    }

    /**
     * @param {{ id?: string, bytes: number, label: string | null,
     *     pid: number, childPid?: number | null }} job
     * @returns {LedgerEntry}
     */
    function addJob(job) {
        const at = stamp();

        const entry = {
            id: job.id ?? crypto.randomUUID(),
            kind: KIND_JOB,
            bytes: job.bytes,
            label: job.label,
            pid: job.pid,
            childPid: job.childPid ?? null,
            model: null,
            requestId: null,
            createdAt: at.iso,
            createdMs: at.ms,
            lastHeartbeatAt: at.iso,
        };

        entries.set(entry.id, entry);

        return entry;
    }

    /**
     * @param {{ bytes: number, model: string, requestId: string }} hold
     * @returns {LedgerEntry}
     */
    function addHold(hold) {
        const at = stamp();

        const entry = {
            id: crypto.randomUUID(),
            kind: KIND_HOLD,
            bytes: hold.bytes,
            label: null,
            pid: null,
            childPid: null,
            model: hold.model,
            requestId: hold.requestId,
            createdAt: at.iso,
            createdMs: at.ms,
            lastHeartbeatAt: at.iso,
        };

        entries.set(entry.id, entry);

        return entry;
    }

    function get(id) {
        return entries.get(id) ?? null;
    }

    /**
     * @returns {LedgerEntry | null} The entry removed, if there was one.
     */
    function remove(id) {
        const entry = get(id);

        entries.delete(id);

        return entry;
    }

    /**
     * Records a job's check-in, and its child's pid once it has one.
     * @returns {LedgerEntry | null} Null when the id is unknown, which
     *     tells the wrapper to register again.
     */
    function heartbeat(id, childPid = null) {
        const entry = get(id);

        if (!entry) {
            return null;
        }

        if (entry.kind !== KIND_JOB) {
            return null;
        }

        entry.lastHeartbeatAt = stamp().iso;

        if (childPid !== null) {
            entry.childPid = childPid;
        }

        return entry;
    }

    function list() {
        return [...entries.values()].sort((a, b) => a.createdMs - b.createdMs);
    }

    function jobs() {
        return list().filter((entry) => entry.kind === KIND_JOB);
    }

    function holds() {
        return list().filter((entry) => entry.kind === KIND_HOLD);
    }

    //  The chat route's fast path: with no job, there is nothing for a
    //  model load to displace, so the gate is skipped without a call
    //  to the backend.
    function hasJobs() {
        for (const entry of entries.values()) {
            if (entry.kind === KIND_JOB) {
                return true;
            }
        }

        return false;
    }

    function reservedBytes() {
        let total = 0;

        for (const entry of entries.values()) {
            total += entry.bytes;
        }

        return total;
    }

    return {
        addJob,
        addHold,
        get,
        remove,
        heartbeat,
        list,
        jobs,
        holds,
        hasJobs,
        reservedBytes,
    };
}
