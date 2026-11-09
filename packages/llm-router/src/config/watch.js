//  =====================================================================
//  Config watcher
//  =====================================================================
//  Calls reload when the instance's config file changes.
//
//  The FOLDER is watched, not the file. Editors save by writing a new
//  file and renaming it over the old one, and on Linux a watch on the
//  old file would go on watching a file that is gone. The decision log
//  sits in the same folder and is written all day, so every event is
//  filtered by file name before anything else happens.
//
//  One save is several events, and a half-written file can be among
//  them, so a reload waits until the folder has been quiet for
//  SETTLE_MS. A save caught half-written anyway is declined like any
//  bad file, and the event for the finished write follows it.
//
//  If the watch itself fails, edits stop being picked up. That is said
//  once, loudly, and kept for the status route: a daemon that looks
//  like it reloads and does not is the worst case.
//
//  Not watched: the target of a symlinked config file, when it lives
//  in another folder. Edits there need a restart.

import { basename } from "@std/path";
import { CONFIG_FILE_NAMES } from "@saxby/core";

//  Long enough for an editor's write-then-rename, short enough that a
//  save feels applied at once.
const SETTLE_MS = 250;

//  Reading a file is not a change to it.
const KIND_ACCESS = "access";

/**
 * Whether a file system event is a change to the config file.
 * @param {{ kind: string, paths: string[] }} event - A Deno.FsEvent.
 * @returns {boolean}
 */
export function isConfigEvent(event) {
    if (event.kind === KIND_ACCESS) {
        return false;
    }

    return event.paths.some((path) =>
        CONFIG_FILE_NAMES.includes(basename(path))
    );
}

/**
 * Watches an instance folder and reloads on a config change.
 * @param {Object} options
 * @param {string} options.dir - The instance folder.
 * @param {() => Promise<unknown>} options.reload - Must not reject.
 * @param {(dir: string, options: Object) => AsyncIterable<Object>
 *     & { close: () => void }} [options.watchFs]
 * @param {number} [options.settleMs]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(timer: unknown) => void} [options.clearTimer]
 * @param {(line: string) => void} [options.warn]
 * @returns {{ close: () => void, error: () => string | null }}
 */
export function watchConfig(options) {
    const watchFs = options.watchFs ?? Deno.watchFs;
    const settleMs = options.settleMs ?? SETTLE_MS;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const warn = options.warn ?? ((line) => console.warn(line));

    let watcher = null;
    let timer = null;
    let closed = false;

    /** @type {string | null} */
    let error = null;

    function fail(reason) {
        error = reason;

        warn(
            `⚠️  Config edits are NOT being watched: ${reason}\n` +
                `   Restart to apply an edit: 'saxby service restart'.`,
        );
    }

    function run() {
        timer = null;

        //  The reloader runs reloads one at a time and never rejects;
        //  the catch only keeps a bug there from being unhandled here.
        options.reload().catch((err) => {
            warn(`⚠️  Config reload failed: ${err.message}`);
        });
    }

    function schedule() {
        if (timer !== null) {
            clearTimer(timer);
        }

        timer = setTimer(run, settleMs);
    }

    async function listen() {
        try {
            for await (const event of watcher) {
                if (isConfigEvent(event)) {
                    schedule();
                }
            }
        } catch (err) {
            fail(err.message);
            return;
        }

        if (!closed) {
            fail("the watch on the config folder ended");
        }
    }

    function close() {
        closed = true;

        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }

        watcher?.close();
    }

    try {
        watcher = watchFs(options.dir, { recursive: false });
    } catch (err) {
        fail(err.message);

        return { close, error: () => error };
    }

    listen();

    return { close, error: () => error };
}
