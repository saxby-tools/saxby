//  =====================================================================
//  Other brokers on this machine
//  =====================================================================
//  Each instance's broker keeps its own ledger, and GPU memory belongs
//  to the machine. A job reserved through the dev instance is invisible
//  to the default instance's gate, so a load through the default
//  instance does not wait for it. Sharing the ledger would change who
//  may talk to whom, which is the post-v1 exposure work (AGENTS.md),
//  so for now the gap is named rather than closed: at boot, after the
//  broker starts, every other instance whose saxbyd answers gets one
//  line.
//
//  This is observability, never load-bearing. An instance with no
//  config, an unreadable one, or a port that does not answer is
//  skipped in silence, and the probes run together so the boot waits
//  one probe timeout at most. Nothing here runs on the request path.
//
//  How an instance is found is core's: the folder list, its config
//  and the status probe are the same calls `saxby instance list`
//  makes. They are passed in so the tests run with no folders and no
//  network.

import {
    fetchInstanceStatus,
    instancePhrase,
    listInstances,
    loadConfig,
} from "@saxby/core";

const DOC_SECTION = "docs/memory-broker.md#limits";

/**
 * Name and port of one other instance, when its own saxbyd answers on
 * its configured port. Null for every other outcome: the folder has
 * no config, the config cannot be read, nothing answers, or what
 * answers is not this instance, which the CLI's list reports as
 * blocked rather than running.
 * @param {string | null} name - from listInstances
 * @param {{ load: Function, fetchStatus: Function }} deps
 * @returns {Promise<{ name: string | null, port: number } | null>}
 */
async function probeNeighbour(name, deps) {
    let config;

    try {
        config = await deps.load(name);
    } catch {
        return null;
    }

    let holder;

    try {
        holder = await deps.fetchStatus(config, name);
    } catch {
        return null;
    }

    if (!holder) {
        return null;
    }

    if (holder.instance !== name) {
        return null;
    }

    return { name, port: config.listen_port };
}

/**
 * Every other instance under the config root whose saxbyd answers,
 * in the order listInstances gives: the default instance first, then
 * named ones sorted. The booting instance is left out; it is not its
 * own neighbour.
 * @param {{ instance: string | null, list?: Function, load?: Function,
 *     fetchStatus?: Function }} deps - the instance booting, and the
 *     three core calls, replaced in tests
 * @returns {Promise<{ name: string | null, port: number }[]>}
 */
export async function findNeighbours({
    instance,
    list = listInstances,
    load = loadConfig,
    fetchStatus = fetchInstanceStatus,
}) {
    let names;

    try {
        names = await list();
    } catch {
        return [];
    }

    const others = names.filter((name) => name !== instance);

    const found = await Promise.all(
        others.map((name) => probeNeighbour(name, { load, fetchStatus })),
    );

    return found.filter((neighbour) => neighbour !== null);
}

/**
 * The boot line for one neighbour.
 * @param {{ name: string | null, port: number }} neighbour
 * @returns {string}
 */
export function describeNeighbour(neighbour) {
    const who = instancePhrase(neighbour.name);
    const label = who.charAt(0).toUpperCase() + who.slice(1);

    return `ℹ️  ${label} also runs on this machine (port ` +
        `${neighbour.port}). A job reserved there is invisible to ` +
        `this broker (${DOC_SECTION}).`;
}

/**
 * Prints one line per other instance that answers, and nothing when
 * none does. Called once, after the broker's own boot lines.
 * @param {Parameters<typeof findNeighbours>[0]} deps
 * @param {(line: string) => void} [print]
 * @returns {Promise<void>}
 */
export async function announceNeighbours(deps, print = console.log) {
    const neighbours = await findNeighbours(deps);

    for (const neighbour of neighbours) {
        print(describeNeighbour(neighbour));
    }
}
