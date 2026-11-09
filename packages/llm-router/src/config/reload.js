//  =====================================================================
//  Config reload
//  =====================================================================
//  Takes an edited config without a restart. Three rules:
//
//    1. All or nothing. The new config is read, validated and given
//       its Tier 3 vectors off to the side, then swapped in with one
//       assignment. The running config is always exactly one version
//       of the file, never a mix that was never on disk.
//    2. Replaced, never edited. A request in flight keeps the config
//       object it started with.
//    3. A declined edit is never silent. The old config keeps serving,
//       the reason is printed, and status() carries it until the file
//       is fixed, so `saxby status` can say what the log already said.
//       A restart would have refused the same file at boot.
//
//  Some fields cannot change under a running daemon. An edit that
//  touches one is declined whole, with the field named:
//
//    listen_host   the listener is bound once
//    listen_port
//    log_path      the decision log is opened once, and the vector
//                  cache lives in it
//    memory        the broker's sweep timer and heartbeat interval are
//                  tied to jobs already holding reservations
//
//  The API token is not part of this: saxbyd reads it at boot only.
//
//  Everything outside this file is passed in (the loader, the Tier 3
//  warm-up, what to do after a swap, the clock, the console), so tests
//  run it with no file and no network.

export const RESTART_ONLY_FIELDS = [
    "listen_host",
    "listen_port",
    "log_path",
    "memory",
];

export const RELOAD_APPLIED = "applied";
export const RELOAD_UNCHANGED = "unchanged";
export const RELOAD_DECLINED = "declined";

const RESTART_HINT = "Restart to apply it: 'saxby service restart'.";

//  ---------------------------------------------------------------------
//  Helpers
//  ---------------------------------------------------------------------

/**
 * Whether two validated config values are the same. The validator
 * writes object keys in schema order, so the same settings give the
 * same text whatever order the file lists them in. Catalog and
 * persona order is the file's own, so a reorder there counts as a
 * change, and is applied.
 */
function isSameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The top-level fields that differ between two configs.
 * @returns {string[]}
 */
export function listChangedFields(running, next) {
    const fields = new Set([...Object.keys(running), ...Object.keys(next)]);

    return [...fields].filter((field) =>
        !isSameJson(running[field], next[field])
    );
}

/**
 * Everything Tier 3's vectors are built from. When none of it moved,
 * the vectors in memory are still right and no embedder is called.
 */
function semanticInputs(config) {
    const exemplars = Object.entries(config.personas).map(
        ([name, persona]) => [name, persona.exemplars],
    );

    return {
        semantic: config.semantic,
        upstream_url: config.upstream_url,
        exemplars,
    };
}

function describeBlocked(fields) {
    if (fields.length === 1) {
        return `${fields[0]} changed, and that needs a restart. ` +
            RESTART_HINT;
    }

    return `${fields.join(", ")} changed, and those need a restart. ` +
        RESTART_HINT;
}

//  ---------------------------------------------------------------------
//  Reloader
//  ---------------------------------------------------------------------

/**
 * Holds the running config and Tier 3 state, and replaces both when
 * the file changes.
 * @param {Object} options
 * @param {Object} options.config - The config saxbyd booted with.
 * @param {Object | null} options.semantic - Tier 3 as warmed at boot.
 * @param {() => Promise<Object>} options.load - Reads and validates
 *     the file. Throws with a message fit to print.
 * @param {(config: Object) => Promise<Object | null>} options.warm -
 *     Builds Tier 3 for a config. Null when the config asks for none;
 *     throws when the embedder cannot be used.
 * @param {(state: { config: Object, semantic: Object | null },
 *     changed: string[]) => void} [options.onApply] - Runs right after
 *     a swap, in the same tick. Must be synchronous.
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.say]
 * @param {(line: string) => void} [options.warn]
 */
export function createReloader(options) {
    const now = options.now ?? (() => Date.now());
    const say = options.say ?? ((line) => console.log(line));
    const warn = options.warn ?? ((line) => console.warn(line));

    let state = { config: options.config, semantic: options.semantic };
    let loadedAt = new Date(now()).toISOString();

    /** @type {{ at: string, reason: string } | null} */
    let declined = null;

    //  Reloads run one at a time, in the order asked for.
    let last = Promise.resolve();

    function decline(reason) {
        declined = { at: new Date(now()).toISOString(), reason };

        warn(
            `⚠️  Config on disk NOT applied. Still running the config ` +
                `loaded ${loadedAt}.\n${reason}`,
        );

        return { outcome: RELOAD_DECLINED, reason };
    }

    //  The file is the running config again: a bad edit was undone, or
    //  a save changed nothing.
    function settle() {
        if (declined !== null) {
            declined = null;
            say("✅ Config on disk matches the running config again.");
        }

        return { outcome: RELOAD_UNCHANGED };
    }

    /**
     * Tier 3 for the new config. A reload never turns off a Tier 3
     * that is working: if the embedder cannot build the new vectors,
     * the reload is declined instead. When Tier 3 is already off, a
     * failure loses nothing, so the rest of the config is applied, as
     * a boot would.
     */
    async function warmFor(next) {
        const sameInputs = isSameJson(
            semanticInputs(state.config),
            semanticInputs(next),
        );

        if (sameInputs && state.semantic !== null) {
            return state.semantic;
        }

        try {
            return await options.warm(next);
        } catch (err) {
            if (state.semantic === null) {
                warn(
                    `⚠️  Tier 3 unavailable, continuing without it: ` +
                        err.message,
                );

                return null;
            }

            throw new Error(
                `Tier 3 could not be rebuilt for the new config, and ` +
                    `applying it would turn Tier 3 off: ${err.message}`,
            );
        }
    }

    async function attempt() {
        const next = await options.load();

        if (isSameJson(state.config, next)) {
            return settle();
        }

        const changed = listChangedFields(state.config, next);

        const blocked = changed.filter((field) =>
            RESTART_ONLY_FIELDS.includes(field)
        );

        if (blocked.length > 0) {
            return decline(describeBlocked(blocked));
        }

        const semantic = await warmFor(next);

        //  Nothing below can fail or wait, so the swap and what
        //  follows it happen in one tick.
        state = { config: next, semantic };
        loadedAt = new Date(now()).toISOString();
        declined = null;

        say(`🔄 Config reloaded: ${changed.join(", ")} changed.`);

        //  The swap is done, so a failure here must not read as a
        //  declined edit.
        try {
            options.onApply?.(state, changed);
        } catch (err) {
            warn(
                `⚠️  Config reloaded, but a step after it failed: ` +
                    `${err.message}
   Restart so every part runs ` +
                    `the new config.`,
            );
        }

        return { outcome: RELOAD_APPLIED, changed };
    }

    //  Never rejects: whatever goes wrong, the old config keeps
    //  serving and the reason is kept.
    async function attemptSafely() {
        try {
            return await attempt();
        } catch (err) {
            return decline(err.message);
        }
    }

    /**
     * Reads the file and applies it, or says why not.
     * @returns {Promise<{ outcome: string, changed?: string[],
     *     reason?: string }>}
     */
    function reload() {
        const run = last.then(attemptSafely);

        last = run;

        return run;
    }

    /** The running config and Tier 3 state. Read once per request. */
    function current() {
        return state;
    }

    /**
     * What the status route reports.
     * @returns {{ loaded_at: string,
     *     declined: { at: string, reason: string } | null }}
     */
    function status() {
        return { loaded_at: loadedAt, declined };
    }

    return { reload, current, status };
}
