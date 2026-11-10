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
//  A config file may be a symlink into another folder, as GNU Stow
//  and dotfile repos make it. An edit to the real file raises no
//  event in the instance folder, so the real file's folder is watched
//  too. Where the link points is read when the watch starts. If it is
//  later pointed into a different folder, that folder is not watched,
//  and that is reported the same way as a watch that failed.

import { basename, dirname, join } from "@std/path";
import { CONFIG_FILE_NAMES } from "@saxby/core";

//  Long enough for an editor's write-then-rename, short enough that a
//  save feels applied at once.
const SETTLE_MS = 250;

//  Reading a file is not a change to it.
const KIND_ACCESS = "access";

/**
 * The folders to watch and the file names that matter in them: the
 * instance folder and the config names, plus the folder and name of
 * the real file when a config name is a symlink into another folder.
 * A config name that does not exist adds nothing.
 * @param {string} dir - The instance folder.
 * @param {(path: string) => string} [realPath]
 * @returns {{ dirs: string[], names: string[] }}
 */
export function listWatchTargets(dir, realPath = Deno.realPathSync) {
    const dirs = new Set([dir]);
    const names = new Set(CONFIG_FILE_NAMES);

    //  The instance folder may itself be reached through a link, so
    //  folders are compared by their real paths.
    let realDir;

    try {
        realDir = realPath(dir);
    } catch {
        return { dirs: [...dirs], names: [...names] };
    }

    for (const name of CONFIG_FILE_NAMES) {
        let real;

        try {
            real = realPath(join(dir, name));
        } catch {
            continue;
        }

        if (dirname(real) === realDir) {
            continue;
        }

        dirs.add(dirname(real));
        names.add(basename(real));
    }

    return { dirs: [...dirs], names: [...names] };
}

/**
 * Whether a file system event is a change to the config file.
 * @param {{ kind: string, paths: string[] }} event - A Deno.FsEvent.
 * @param {string[]} [names] - from listWatchTargets
 * @returns {boolean}
 */
export function isConfigEvent(event, names = CONFIG_FILE_NAMES) {
    if (event.kind === KIND_ACCESS) {
        return false;
    }

    return event.paths.some((path) => names.includes(basename(path)));
}

/**
 * Watches an instance folder and reloads on a config change.
 * @param {Object} options
 * @param {string} options.dir - The instance folder.
 * @param {() => Promise<unknown>} options.reload - Must not reject.
 * @param {(dirs: string[], options: Object) => AsyncIterable<Object>
 *     & { close: () => void }} [options.watchFs]
 * @param {(path: string) => string} [options.realPath]
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
    const realPath = options.realPath ?? Deno.realPathSync;

    const targets = listWatchTargets(options.dir, realPath);

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

    //  Run after each reload. A link pointed into a new folder was
    //  itself a change in the instance folder, so that reload read the
    //  new file; what is lost is every edit to it after this one.
    function checkTargets() {
        if (error !== null) {
            return;
        }

        const now = listWatchTargets(options.dir, realPath);
        const added = now.dirs.filter((dir) => !targets.dirs.includes(dir));

        if (added.length === 0) {
            return;
        }

        fail(
            `the config file now links into ${added.join(", ")}, ` +
                `which was not being watched when saxbyd started`,
        );
    }

    function run() {
        timer = null;

        //  The reloader runs reloads one at a time and never rejects;
        //  the catch only keeps a bug there from being unhandled here.
        options.reload().then(checkTargets).catch((err) => {
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
                if (isConfigEvent(event, targets.names)) {
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
        watcher = watchFs(targets.dirs, { recursive: false });
    } catch (err) {
        fail(err.message);

        return { close, error: () => error };
    }

    listen();

    return { close, error: () => error };
}
