//  =====================================================================
//  Memory broker
//  =====================================================================
//  Keeps heavy jobs and model loads from overfilling GPU memory. On
//  Apple Silicon that memory is wired; when it ran out on Oct. 27,
//  2026, the kernel panicked.
//
//    jobs    `saxby reserve --gib N -- <command>` asks for N before the
//            command starts. It waits while N does not fit, then is
//            refused. A job never takes a pinned model's space.
//    loads   a chat request whose model is not loaded asks before it
//            is forwarded, but only while a job holds a reservation.
//            With none, nothing can be displaced and the chat route
//            skips the broker without a call to the backend.
//
//  The gate is load-bearing: when the budget cannot be known, nothing
//  is admitted. The log is not: every wait, admission, refusal,
//  release and reap is recorded best-effort, and a failed write
//  changes no decision.
//
//  Everything outside this file is passed in (probe, backend,
//  liveness, clock, sleep, log), so tests run it with no network, no
//  processes and no real time.

import { formatGib, gibToBytes } from "@saxby/core";
import { computeBudget, decideLoad, decideReservation } from "./budget.js";
import { createLedger } from "./ledger.js";

//  How often a waiting job or load looks again.
const POLL_MS = 1000;

//  One probe reading serves every waiter that polls within this long
//  of it. The probe starts two programs, so N waiters would otherwise
//  cost 2N processes a second; the ceiling does not change that fast.
const PROBE_REUSE_MS = POLL_MS;

//  A load hold normally ends at the request's first byte. This only
//  catches a hold some path forgot to release.
const HOLD_TTL_MS = 10 * 60 * 1000;

const MS_PER_S = 1000;

const SUBJECT_JOB = "job";
const SUBJECT_LOAD = "load";

//  What a refused or failed request was refused for. The reservation
//  route maps each to an HTTP status.
export const CODE_MEMORY = "memory_unavailable";
export const CODE_PID = "pid_not_alive";
export const CODE_LIVENESS = "liveness_unknown";
export const CODE_ABANDONED = "abandoned";

const NO_PROBE_READING = {
    ceilingBytes: null,
    ceilingSource: "no memory probe for this platform",
    usedBytes: null,
    usedSource: "no memory probe for this platform",
};

//  ---------------------------------------------------------------------
//  Helpers
//  ---------------------------------------------------------------------

/**
 * Resolves after `ms`, or at once when the signal aborts, so a client
 * that leaves stops its wait within one poll.
 */
function sleepFor(ms, signal) {
    return new Promise((resolve) => {
        let timer = null;

        //  Whichever comes first, the timer or the abort, clears the
        //  other: a listener left on the signal after the timer won
        //  would otherwise pile up, one per poll, for the request's life.
        function finish() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
        }

        timer = setTimeout(finish, ms);

        if (signal?.aborted) {
            finish();
            return;
        }

        signal?.addEventListener("abort", finish, { once: true });
    });
}

//  The probe's measurement wins; memory.ceiling_gib only fills a gap.
function readCeiling(reading, memory) {
    if (reading.ceilingBytes !== null) {
        return {
            ceilingBytes: reading.ceilingBytes,
            ceilingSource: reading.ceilingSource,
        };
    }

    if (memory.ceiling_gib !== undefined) {
        return {
            ceilingBytes: gibToBytes(memory.ceiling_gib),
            ceilingSource: `memory.ceiling_gib, because ` +
                reading.ceilingSource,
        };
    }

    return { ceilingBytes: null, ceilingSource: reading.ceilingSource };
}

/**
 * Pinned catalog models, plus the active embedder. Embedders never sit
 * in the catalog (AGENTS.md), and Tier 3 loads this one for routed
 * requests, so it is pinned without being asked.
 */
function listPinned(config, canonicalName) {
    const pinned = new Map();

    for (const [key, entry] of Object.entries(config.catalog)) {
        if (!entry.pinned) {
            continue;
        }

        pinned.set(canonicalName(key), entry.size_gib);
    }

    if (config.semantic) {
        const profile = config.semantic.profiles[config.semantic.active];

        pinned.set(canonicalName(profile.model), profile.size_gib);
    }

    return [...pinned].map(([model, sizeGib]) => ({ model, sizeGib }));
}

function mapCatalogSizes(config, canonicalName) {
    const sizes = new Map();

    for (const [key, entry] of Object.entries(config.catalog)) {
        if (entry.size_gib === undefined) {
            continue;
        }

        sizes.set(canonicalName(key), entry.size_gib);
    }

    return sizes;
}

/**
 * A model's size, best source first: loaded now, last measured, then
 * the config's size_gib.
 */
function sizeModel(model, sizeGib, loadedByName, sizes) {
    if (loadedByName.has(model)) {
        return { bytes: loadedByName.get(model), source: "loaded" };
    }

    const measured = sizes.get(model);

    if (measured) {
        return { bytes: measured.bytes, source: "measured" };
    }

    if (sizeGib !== undefined) {
        return { bytes: gibToBytes(sizeGib), source: "size_gib" };
    }

    return { bytes: null, source: "unknown" };
}

function seconds(ms) {
    return `${Math.round(ms / MS_PER_S)} s`;
}

//  ---------------------------------------------------------------------
//  Broker
//  ---------------------------------------------------------------------

/**
 * @param {Object} options
 * @param {Object} options.config - A validated Saxby config.
 * @param {import("@saxby/core").MemoryProbe | null} options.probe
 * @param {import("@saxby/core").BackendAdapter} options.backend
 * @param {string} options.upstreamUrl
 * @param {(pid: number) => Promise<boolean | null>} options.isAlive
 * @param {ReturnType<typeof import("./sizes.js").createSizeCache>}
 *     options.sizes
 * @param {(event: Object) => void} [options.record] - The log writer.
 * @param {() => number} [options.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>}
 *     [options.sleep]
 * @param {(message: string) => void} [options.warn]
 */
export function createBroker(options) {
    const config = options.config;
    const memory = config.memory;
    const backend = options.backend;
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? sleepFor;
    const record = options.record ?? (() => {});
    const warn = options.warn ?? ((message) => console.warn(message));

    const marginBytes = gibToBytes(memory.margin_gib);
    const heartbeatMs = memory.heartbeat_interval_s * MS_PER_S;
    const defaultWaitMs = memory.wait_timeout_s * MS_PER_S;

    const ledger = createLedger(now);
    const pinned = listPinned(config, backend.canonicalName);
    const pinnedNames = new Set(pinned.map((term) => term.model));
    const catalogSizes = mapCatalogSizes(config, backend.canonicalName);

    let sweepTimer = null;
    let sweeping = false;
    let livenessWarned = false;

    /** @type {{ atMs: number, promise: Promise<Object> } | null} */
    let probeReading = null;

    //  ---- Reading the machine ---------------------------------------

    function readProbe() {
        if (!options.probe) {
            return Promise.resolve(NO_PROBE_READING);
        }

        if (probeReading !== null) {
            if (now() - probeReading.atMs < PROBE_REUSE_MS) {
                return probeReading.promise;
            }
        }

        probeReading = { atMs: now(), promise: options.probe.read() };

        return probeReading.promise;
    }

    async function readResidency() {
        try {
            const loaded = await backend.fetchResidency(options.upstreamUrl);

            options.sizes.record(loaded);

            return { loaded, residencyError: null };
        } catch (err) {
            return { loaded: null, residencyError: err.message };
        }
    }

    //  The probe starts two programs and the backend is one HTTP call;
    //  run side by side they cost one wait instead of two.
    async function readMachine() {
        const [reading, residency] = await Promise.all([
            readProbe(),
            readResidency(),
        ]);

        return { reading, ...residency };
    }

    function loadedMap(machine) {
        const loaded = machine.loaded ?? [];

        return new Map(loaded.map((model) => [model.name, model.bytes]));
    }

    //  Synchronous. Callers read the machine, then call this and change
    //  the ledger with no await between, so the reserved term is never
    //  stale when a decision is made.
    function budgetFrom(machine) {
        const loadedByName = loadedMap(machine);
        const loaded = machine.loaded ?? [];

        const pinnedTerms = pinned.map((term) => ({
            model: term.model,
            ...sizeModel(term.model, term.sizeGib, loadedByName, options.sizes),
        }));

        const others = loaded
            .filter((model) => !pinnedNames.has(model.name))
            .map((model) => ({ model: model.name, bytes: model.bytes }));

        return computeBudget({
            ...readCeiling(machine.reading, memory),
            marginBytes,
            pinned: pinnedTerms,
            loaded: others,
            reservedBytes: ledger.reservedBytes(),
            residencyError: machine.residencyError,
            usedBytes: machine.reading.usedBytes,
            usedSource: machine.reading.usedSource,
        });
    }

    //  ---- Logging ---------------------------------------------------

    function log(event, budget = null) {
        try {
            record({ ...event, at: new Date(now()).toISOString(), budget });
        } catch (err) {
            warn(`⚠️  memory event not logged: ${err.message}`);
        }
    }

    //  ---- Jobs ------------------------------------------------------

    async function checkPid(pid) {
        const alive = await options.isAlive(pid);

        if (alive === true) {
            return null;
        }

        if (alive === null) {
            return {
                code: CODE_LIVENESS,
                reason: `saxbyd cannot check processes on this machine, ` +
                    `so it could never release this reservation`,
            };
        }

        return {
            code: CODE_PID,
            reason: `pid ${pid} is not a running process of this user`,
        };
    }

    /**
     * Admits a job once its bytes fit, waiting up to timeoutMs.
     * @param {{ bytes: number, pid: number, label: string | null,
     *     timeoutMs?: number, signal?: AbortSignal }} request
     */
    async function reserve(request) {
        const pidProblem = await checkPid(request.pid);

        if (pidProblem) {
            return { admitted: false, ...pidProblem, waitedMs: 0 };
        }

        const startedMs = now();
        const deadline = startedMs + (request.timeoutMs ?? defaultWaitMs);

        const subject = {
            subject: SUBJECT_JOB,
            label: request.label,
            pid: request.pid,
            bytes: request.bytes,
        };

        let waited = false;

        while (true) {
            const waitMs = now() - startedMs;

            if (request.signal?.aborted) {
                log({
                    ...subject,
                    event: "abandon",
                    reason: `the client left after ${seconds(waitMs)}`,
                    waitMs,
                });

                return {
                    admitted: false,
                    code: CODE_ABANDONED,
                    waitedMs: waitMs,
                };
            }

            const machine = await readMachine();
            const budget = budgetFrom(machine);
            const decision = decideReservation(budget, request.bytes);

            if (decision.fits) {
                const entry = ledger.addJob({
                    bytes: request.bytes,
                    label: request.label,
                    pid: request.pid,
                });

                log({
                    ...subject,
                    event: "admit",
                    reason: decision.reason,
                    reservationId: entry.id,
                    waitMs: now() - startedMs,
                }, budget);

                return {
                    admitted: true,
                    reservation: entry,
                    waitedMs: now() - startedMs,
                    budget,
                };
            }

            const outOfTime = now() >= deadline;

            if (decision.neverFits || outOfTime) {
                const reason = waited
                    ? `waited ${seconds(now() - startedMs)}; ${decision.reason}`
                    : decision.reason;

                log({
                    ...subject,
                    event: "refuse",
                    reason,
                    waitMs: now() - startedMs,
                }, budget);

                return {
                    admitted: false,
                    code: CODE_MEMORY,
                    reason,
                    waitedMs: now() - startedMs,
                    budget,
                };
            }

            if (!waited) {
                log(
                    { ...subject, event: "wait", reason: decision.reason },
                    budget,
                );
                waited = true;
            }

            await sleep(Math.min(POLL_MS, deadline - now()), request.signal);
        }
    }

    /**
     * A wrapper whose heartbeat met a 404: saxbyd restarted under a
     * running job. It is admitted without a check, because the job
     * already holds its memory and refusing would not stop it. The log
     * row shows the budget anyway, over or not.
     * @param {{ id: string, bytes: number, pid: number,
     *     childPid: number | null, label: string | null }} request
     */
    async function reregister(request) {
        const known = ledger.heartbeat(request.id, request.childPid);

        if (known) {
            return { admitted: true, reservation: known };
        }

        const pids = [request.pid, request.childPid].filter((pid) =>
            pid !== null
        );

        const answers = await Promise.all(pids.map(options.isAlive));

        if (!answers.includes(true)) {
            return {
                admitted: false,
                code: CODE_PID,
                reason: `none of pids ${pids.join(", ")} is running`,
            };
        }

        const machine = await readMachine();

        //  A second copy of the same request may have landed during
        //  the awaits.
        const landed = ledger.heartbeat(request.id, request.childPid);

        if (landed) {
            return { admitted: true, reservation: landed };
        }

        const entry = ledger.addJob(request);
        const budget = budgetFrom(machine);

        let reason = `registered again after saxbyd restarted; the job ` +
            `was already running`;

        if (budget.freeBytes !== null) {
            if (budget.freeBytes < 0) {
                reason += `, ${formatGib(-budget.freeBytes)} over budget`;
            }
        }

        log({
            subject: SUBJECT_JOB,
            event: "reregister",
            reason,
            reservationId: entry.id,
            label: entry.label,
            pid: entry.pid,
            childPid: entry.childPid,
            bytes: entry.bytes,
        }, budget);

        return { admitted: true, reservation: entry, budget };
    }

    function heartbeat(id, childPid = null) {
        return ledger.heartbeat(id, childPid);
    }

    function release(id) {
        const entry = ledger.get(id);

        if (!entry) {
            return null;
        }

        if (entry.kind !== "job") {
            return null;
        }

        ledger.remove(id);

        log({
            subject: SUBJECT_JOB,
            event: "release",
            reason: "the wrapper released it",
            reservationId: entry.id,
            label: entry.label,
            pid: entry.pid,
            childPid: entry.childPid,
            bytes: entry.bytes,
        });

        return entry;
    }

    //  ---- Model loads -----------------------------------------------

    function describeTarget(name, loadedByName) {
        const isPinned = pinnedNames.has(name);
        const sizeGib = catalogSizes.get(name);

        return {
            model: name,
            pinned: isPinned,
            ...sizeModel(name, sizeGib, loadedByName, options.sizes),
        };
    }

    function holdHandle(entry) {
        if (!entry) {
            return null;
        }

        return {
            release: () => {
                ledger.releaseHold(entry.id);
            },
        };
    }

    /**
     * Lets a chat request through once its model is loaded or fits.
     * Callers skip this entirely when hasJobs() is false.
     * @param {string} model - The model the request will be sent to.
     * @param {{ requestId: string, signal?: AbortSignal }} context
     */
    async function gateLoad(model, context) {
        const startedMs = now();
        const deadline = startedMs + defaultWaitMs;
        const name = model ? backend.canonicalName(model) : "";

        const subject = {
            subject: SUBJECT_LOAD,
            model: name,
            requestId: context.requestId,
        };

        let waited = false;

        function admitUnchecked(reason) {
            const waitMs = now() - startedMs;

            if (waited) {
                log({ ...subject, event: "admit", reason, waitMs });
            }

            return { admitted: true, hold: null, waitedMs: waitMs };
        }

        while (true) {
            if (!name) {
                return admitUnchecked("no model named");
            }

            if (!ledger.hasJobs()) {
                return admitUnchecked("no reservation is held now");
            }

            if (context.signal?.aborted) {
                const waitMs = now() - startedMs;

                log({
                    ...subject,
                    event: "abandon",
                    reason: `the client left after ${seconds(waitMs)}`,
                    waitMs,
                });

                return {
                    admitted: false,
                    code: CODE_ABANDONED,
                    waitedMs: waitMs,
                };
            }

            //  Most requests while a job runs are for a model already
            //  loaded. One call to the backend settles those; the
            //  probe runs only when there is a load to judge.
            const residency = await readResidency();
            const loadedByName = loadedMap(residency);

            if (loadedByName.has(name)) {
                return admitUnchecked(`'${name}' is loaded now`);
            }

            //  Another request is loading this same model. The backend
            //  loads it once, so its hold counts the size once; this
            //  request joins the hold instead of being charged again.
            const shared = ledger.findHold(name);

            if (shared) {
                ledger.retainHold(shared.id);

                const waitMs = now() - startedMs;

                log({
                    ...subject,
                    event: "admit",
                    reason: `'${name}' is loading for request ` +
                        `${shared.requestId}; sharing its hold`,
                    bytes: shared.bytes,
                    waitMs,
                });

                return {
                    admitted: true,
                    hold: holdHandle(shared),
                    waitedMs: waitMs,
                };
            }

            const machine = { reading: await readProbe(), ...residency };

            if (!ledger.hasJobs()) {
                continue;
            }

            const budget = budgetFrom(machine);
            const target = describeTarget(name, loadedByName);
            const decision = decideLoad(budget, target);

            if (decision.fits) {
                //  A pinned model's space is already out of `free`, so
                //  it needs no hold.
                let hold = null;

                if (!target.pinned) {
                    hold = ledger.addHold({
                        bytes: target.bytes,
                        model: name,
                        requestId: context.requestId,
                    });
                }

                const waitMs = now() - startedMs;

                log({
                    ...subject,
                    event: "admit",
                    reason: decision.reason,
                    bytes: target.bytes,
                    waitMs,
                }, budget);

                return {
                    admitted: true,
                    hold: holdHandle(hold),
                    waitedMs: waitMs,
                };
            }

            const outOfTime = now() >= deadline;

            if (decision.neverFits || outOfTime) {
                const reason = waited
                    ? `waited ${seconds(now() - startedMs)}; ${decision.reason}`
                    : decision.reason;

                log({
                    ...subject,
                    event: "refuse",
                    reason,
                    bytes: target.bytes,
                    waitMs: now() - startedMs,
                }, budget);

                return {
                    admitted: false,
                    code: CODE_MEMORY,
                    reason,
                    waitedMs: now() - startedMs,
                };
            }

            if (!waited) {
                log({
                    ...subject,
                    event: "wait",
                    reason: decision.reason,
                    bytes: target.bytes,
                }, budget);

                waited = true;
            }

            await sleep(Math.min(POLL_MS, deadline - now()), context.signal);
        }
    }

    //  ---- Reaping ---------------------------------------------------

    async function reapJob(entry) {
        const pids = [entry.pid, entry.childPid].filter((pid) => pid !== null);

        const answers = await Promise.all(pids.map(options.isAlive));

        if (answers.includes(true)) {
            return;
        }

        //  Unknown is kept: dropping a reservation whose job may still
        //  hold memory is the unsafe direction.
        if (answers.includes(null)) {
            if (!livenessWarned) {
                warn(
                    "⚠️  saxbyd cannot check processes; reservations " +
                        "will not be reaped",
                );
                livenessWarned = true;
            }

            return;
        }

        //  Released while kill -0 ran.
        if (!ledger.remove(entry.id)) {
            return;
        }

        log({
            subject: SUBJECT_JOB,
            event: "reap",
            reason: `no process left: pid ${pids.join(" and ")} ` +
                `${pids.length > 1 ? "have" : "has"} exited`,
            reservationId: entry.id,
            label: entry.label,
            pid: entry.pid,
            childPid: entry.childPid,
            bytes: entry.bytes,
        });
    }

    function reapHold(entry) {
        if (now() - entry.createdMs < HOLD_TTL_MS) {
            return;
        }

        ledger.remove(entry.id);

        log({
            subject: SUBJECT_LOAD,
            event: "reap",
            reason: `the load hold outlived ${seconds(HOLD_TTL_MS)} ` +
                `without being released`,
            model: entry.model,
            requestId: entry.requestId,
            bytes: entry.bytes,
        });
    }

    /**
     * Drops every reservation whose processes have all exited, and any
     * load hold past its TTL. Runs every heartbeat interval.
     */
    async function sweep() {
        if (sweeping) {
            return;
        }

        sweeping = true;

        try {
            await Promise.all(ledger.jobs().map(reapJob));

            for (const entry of ledger.holds()) {
                reapHold(entry);
            }
        } finally {
            sweeping = false;
        }
    }

    function start() {
        if (sweepTimer !== null) {
            return;
        }

        sweepTimer = setInterval(() => {
            sweep().catch((err) => {
                warn(`⚠️  reservation sweep failed: ${err.message}`);
            });
        }, heartbeatMs);

        //  Never hold the process open just to sweep.
        Deno.unrefTimer(sweepTimer);
    }

    function stop() {
        if (sweepTimer === null) {
            return;
        }

        clearInterval(sweepTimer);
        sweepTimer = null;
    }

    //  ---- Reading the state -----------------------------------------

    async function snapshot() {
        const machine = await readMachine();

        return {
            budget: budgetFrom(machine),
            jobs: ledger.jobs(),
            holds: ledger.holds(),
        };
    }

    return {
        reserve,
        reregister,
        heartbeat,
        release,
        gateLoad,
        sweep,
        start,
        stop,
        snapshot,
        hasJobs: ledger.hasJobs,
        heartbeatIntervalS: memory.heartbeat_interval_s,
        defaultWaitMs,
    };
}
