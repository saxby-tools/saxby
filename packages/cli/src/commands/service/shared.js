import {
    fetchShuntdStatus,
    loadConfig,
    resolveInstanceName,
} from "@shuntd/core";
import { findServiceAdapter } from "../../services/index.js";

//  Tier 3 warms its exemplar cache before the router listens, so a
//  first boot on a new instance can take a while.
const ANSWER_TIMEOUT_MS = 30_000;
const ANSWER_POLL_MS = 500;

export function fail(message) {
    console.error(`❌ ${message}`);
    Deno.exit(1);
}

export function displayName(instance) {
    return instance ?? "default";
}

/**
 * Everything a service command needs before it acts: the instance,
 * the platform's adapter, and that instance's config. Exits with a
 * message rather than throwing, since these are user errors.
 */
export async function prepare(flag) {
    let instance;

    try {
        instance = resolveInstanceName(flag);
    } catch (err) {
        fail(err.message);
    }

    const adapter = findServiceAdapter();

    if (!adapter) {
        fail(`No service manager is supported on ${Deno.build.os}.`);
    }

    try {
        await adapter.preflight();
    } catch (err) {
        fail(err.message);
    }

    let config;

    //  The loader's messages carry their own marker and fix-it hint.
    try {
        config = await loadConfig(instance);
    } catch (err) {
        console.error(err.message);
        Deno.exit(1);
    }

    return { instance, adapter, config };
}

/**
 * Polls /shuntd/v1/status until this instance answers from a process
 * other than `previousPid`, so a restart is not mistaken for success
 * while the old process is still up.
 * @returns {Promise<Object | null>} The status, or null on timeout.
 */
export async function waitForAnswer(port, instance, previousPid = null) {
    const deadline = Date.now() + ANSWER_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const holder = await fetchShuntdStatus(port);

        const isNew = holder !== null &&
            holder.instance === instance &&
            holder.pid !== previousPid;

        if (isNew) {
            return holder;
        }

        await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
    }

    return null;
}

export function reportAnswer(holder, adapter, instance) {
    if (!holder) {
        console.log(
            `⚠️  Not answering yet. Check the logs: ` +
                adapter.logHint(instance),
        );
        return;
    }

    console.log(
        `✅ Running: instance '${displayName(instance)}', ` +
            `pid ${holder.pid}, version ${holder.version ?? "unknown"}.`,
    );
}
