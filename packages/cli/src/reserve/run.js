//  =====================================================================
//  saxby reserve: running a job inside a reservation
//  =====================================================================
//  1. Ask saxbyd for the memory. The request is held open while saxbyd
//     waits for room. Ctrl-C here stops the wait; nothing has run.
//  2. Set each limiter's cap in the job's environment.
//  3. Start the job, tell saxbyd its pid, and check in every heartbeat
//     interval. A 404 means saxbyd restarted: register again.
//  4. When the job exits, release the reservation and exit with the
//     job's own code.
//
//  FAIL CLOSED: if saxbyd can't be asked, or answers anything but yes,
//  the job does not run. --no-broker runs it anyway, loudly.
//
//  Signals while the job runs: SIGTERM is passed on to the job. SIGINT
//  and SIGHUP from a terminal already reach the job through its
//  process group, so the wrapper only absorbs them; passing them on
//  would send a second Ctrl-C to a job that is still cleaning up.
//
//  Every outside effect (HTTP, spawning, signals, timers, output) is
//  passed in, so tests run the whole flow with fakes.

import { formatGib, gibToBytes } from "@saxby/core";
import { BrokerUnreachable } from "./client.js";

//  Exit codes. The job's own code passes through; these are the
//  wrapper's, from sysexits.h where one fits, so a skill can tell
//  "try later" (75) from "no broker" (69).
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 69;
export const EXIT_TEMPFAIL = 75;
export const EXIT_NOT_FOUND = 127;
export const EXIT_INTERRUPTED = 130;

const MS_PER_S = 1000;

const PREFIX = "saxby reserve:";

//  ---------------------------------------------------------------------
//  Helpers
//  ---------------------------------------------------------------------

function errorMessage(reply) {
    return reply.body?.error?.message ?? `HTTP ${reply.status}`;
}

/**
 * Each supported limiter's environment, merged. A limiter that can't
 * apply says why and is skipped; the reservation still stands.
 */
function buildLimitEnv(reservedBytes, ceilingBytes, deps) {
    const env = {};

    for (const limiter of deps.limiters) {
        const result = limiter.environment({ reservedBytes, ceilingBytes });

        if (result.problem) {
            deps.say(
                `⚠️  ${PREFIX} ${limiter.displayName} not set: ` +
                    `${result.problem}.`,
            );
            continue;
        }

        Object.assign(env, result.env);

        const pairs = Object.entries(result.env)
            .map(([name, value]) => `${name}=${value}`)
            .join(" ");

        deps.say(`${PREFIX} ${limiter.displayName}: ${pairs}`);
    }

    return env;
}

/**
 * Routes SIGINT, SIGTERM and SIGHUP for the wrapper's whole life, so
 * there is never a moment with no listener and the default action
 * (exit) leaves a job behind.
 */
function routeSignals(deps) {
    const state = { onStop: null, child: null };

    function stop() {
        state.onStop?.();
    }

    function passOn(signal) {
        if (state.child) {
            state.child.kill(signal);
            return;
        }

        stop();
    }

    const removers = [
        deps.onSignal("SIGINT", () => {
            if (!state.child) {
                stop();
            }
        }),
        deps.onSignal("SIGHUP", () => {
            if (!state.child) {
                stop();
            }
        }),
        deps.onSignal("SIGTERM", () => passOn("SIGTERM")),
    ];

    return {
        state,
        remove: () => {
            for (const remove of removers) {
                remove();
            }
        },
    };
}

//  ---------------------------------------------------------------------
//  The running job's session with saxbyd
//  ---------------------------------------------------------------------

function createSession(plan, deps, reservation, intervalS) {
    let childPid = null;
    let stopBeats = null;
    let inflight = Promise.resolve();
    let finished = false;
    let warned = false;

    async function registerAgain() {
        if (finished) {
            return;
        }

        let reply;

        try {
            reply = await deps.client.create({
                id: reservation.id,
                gib: plan.gib,
                pid: deps.pid,
                child_pid: childPid,
                label: plan.label,
                timeout_s: 0,
                reregister: true,
            });
        } catch {
            return;
        }

        if (reply.status === 201) {
            deps.say(`${PREFIX} saxbyd restarted; the job is registered again`);
            return;
        }

        deps.say(
            `⚠️  ${PREFIX} saxbyd would not take the job back: ` +
                errorMessage(reply),
        );
    }

    async function beat() {
        if (finished) {
            return;
        }

        let reply;

        try {
            reply = await deps.client.heartbeat(reservation.id, childPid);
        } catch {
            if (!warned) {
                deps.say(
                    `⚠️  ${PREFIX} saxbyd stopped answering. The job ` +
                        `keeps running and registers again when saxbyd ` +
                        `is back.`,
                );
                warned = true;
            }

            return;
        }

        warned = false;

        if (reply.status === 404) {
            await registerAgain();
        }
    }

    function beatOnce() {
        inflight = inflight.then(beat);

        return inflight;
    }

    function started(pid) {
        childPid = pid;
        beatOnce();
        stopBeats = deps.every(intervalS * MS_PER_S, beatOnce);
    }

    //  A check-in still in flight could otherwise register the job
    //  again after it has been released.
    async function finish() {
        stopBeats?.();
        finished = true;

        await inflight;

        try {
            await deps.client.release(reservation.id);
        } catch {
            //  saxbyd reaps it once the pids are gone.
        }
    }

    return { started, finish };
}

//  ---------------------------------------------------------------------
//  Running the job
//  ---------------------------------------------------------------------

async function runChild(plan, env, deps, signals, session) {
    let child;

    try {
        child = deps.spawn(plan.command, plan.args, env);
    } catch (err) {
        deps.say(`${PREFIX} could not start '${plan.command}': ${err.message}`);
        await session?.finish();

        return EXIT_NOT_FOUND;
    }

    signals.state.child = child;
    session?.started(child.pid);

    const status = await child.status;

    await session?.finish();

    //  Deno reports a job killed by a signal as 128 + its number,
    //  the shell's convention, so the code passes through as is.
    return status.code;
}

async function runWithoutBroker(plan, deps, signals) {
    deps.say(
        `⚠️  ${PREFIX} --no-broker: saxbyd is NOT told about this job.\n` +
            `   Model loads will not wait for it, and nothing stops it ` +
            `from pushing GPU memory past the ceiling.\n` +
            `   An uncapped GPU job can freeze or panic a Mac.`,
    );

    const reading = deps.probe ? await deps.probe.read() : null;
    const ceilingBytes = reading?.ceilingBytes ?? null;
    const env = buildLimitEnv(gibToBytes(plan.gib), ceilingBytes, deps);

    return await runChild(plan, env, deps, signals, null);
}

function refuse(reply, deps) {
    if (reply.status === 503) {
        deps.say(`${PREFIX} refused: ${errorMessage(reply)}`);
        return EXIT_TEMPFAIL;
    }

    if (reply.status === 400) {
        deps.say(
            `${PREFIX} saxbyd rejected the request: ${errorMessage(reply)}`,
        );
        return EXIT_USAGE;
    }

    //  An older saxbyd has no reservations route; its catch-all sends
    //  the request to Ollama, which answers 404.
    if (reply.status === 404) {
        deps.say(
            `${PREFIX} refusing to run: the saxbyd on port ${deps.port} ` +
                `has no memory broker. Is it older than this saxby?`,
        );
        return EXIT_UNAVAILABLE;
    }

    deps.say(
        `${PREFIX} refusing to run: saxbyd answered ${errorMessage(reply)}`,
    );

    return EXIT_UNAVAILABLE;
}

async function runWithBroker(plan, deps, signals) {
    const controller = new AbortController();

    signals.state.onStop = () => controller.abort();

    deps.say(
        `${PREFIX} asking saxbyd for ${formatGib(gibToBytes(plan.gib))} ` +
            `(waits up to ${plan.timeoutS} s)`,
    );

    let reply;

    try {
        reply = await deps.client.create({
            gib: plan.gib,
            pid: deps.pid,
            label: plan.label,
            timeout_s: plan.timeoutS,
        }, controller.signal);
    } catch (err) {
        if (err.name === "AbortError") {
            deps.say(`${PREFIX} stopped while waiting; nothing ran`);
            return EXIT_INTERRUPTED;
        }

        if (err instanceof BrokerUnreachable) {
            deps.say(
                `${PREFIX} refusing to run: ${err.message}\n` +
                    `   Without the broker nothing keeps this job from ` +
                    `filling GPU memory beside the loaded models.\n` +
                    `   Start saxbyd, or run anyway with --no-broker.`,
            );
            return EXIT_UNAVAILABLE;
        }

        throw err;
    }

    signals.state.onStop = null;

    if (reply.status !== 201) {
        return refuse(reply, deps);
    }

    const body = reply.body;
    const waited = Math.round((body.waited_ms ?? 0) / MS_PER_S);

    deps.say(
        `${PREFIX} reserved ${formatGib(body.reservation.bytes)}` +
            (waited > 0 ? ` after waiting ${waited} s` : ""),
    );

    const env = buildLimitEnv(
        body.reservation.bytes,
        body.ceiling_bytes,
        deps,
    );

    const session = createSession(
        plan,
        deps,
        body.reservation,
        body.heartbeat_interval_s,
    );

    return await runChild(plan, env, deps, signals, session);
}

/**
 * Runs one job inside a reservation.
 * @param {{ gib: number, timeoutS: number, label: string | null,
 *     command: string, args: string[], useBroker: boolean }} plan
 * @param {Object} deps - See reserve.js for the real ones.
 * @returns {Promise<number>} The exit code.
 */
export async function runReserved(plan, deps) {
    const signals = routeSignals(deps);

    try {
        if (!plan.useBroker) {
            return await runWithoutBroker(plan, deps, signals);
        }

        return await runWithBroker(plan, deps, signals);
    } finally {
        signals.remove();
    }
}
