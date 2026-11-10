import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { isConfigEvent, listWatchTargets, watchConfig } from "./watch.js";

//  =====================================================================
//  Harness
//  =====================================================================
//  The file system watch and the timer are faked, so a test pushes
//  events and fires the timer by hand. `turn` lets the watcher's loop
//  take what was pushed.

const DIR = "/home/someone/.config/saxby";

const REAL_WATCH_TIMEOUT_MS = 5000;

function turn() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeWatch() {
    const queue = [];

    let wake = null;
    let ended = false;
    let failure = null;

    return {
        push: (kind, name) => {
            queue.push({ kind, paths: [join(DIR, name)] });
            wake?.();
        },
        fail: (err) => {
            failure = err;
            wake?.();
        },
        close: () => {
            ended = true;
            wake?.();
        },
        async *[Symbol.asyncIterator]() {
            while (true) {
                while (queue.length > 0) {
                    yield queue.shift();
                }

                if (failure !== null) {
                    throw failure;
                }

                if (ended) {
                    return;
                }

                await new Promise((resolve) => {
                    wake = resolve;
                });
            }
        },
    };
}

//  A realPath over a table of links. A path not in the table is its
//  own real path; MISSING stands for a file that does not exist.
const MISSING = Symbol("missing");

function fakeRealPath(links) {
    return (path) => {
        const target = links[path] ?? path;

        if (target === MISSING) {
            throw new Deno.errors.NotFound(path);
        }

        return target;
    };
}

function harness(options = {}) {
    const fs = fakeWatch();
    const warned = [];
    const links = options.links ?? {};

    let reloads = 0;
    let pending = null;
    let timersSet = 0;
    let watchedDirs = null;

    const watching = watchConfig({
        dir: DIR,
        reload: () => {
            reloads += 1;

            return Promise.resolve();
        },
        watchFs: (dirs) => {
            watchedDirs = dirs;

            return fs;
        },
        realPath: fakeRealPath(links),
        setTimer: (fn) => {
            pending = fn;
            timersSet += 1;

            return fn;
        },
        clearTimer: (fn) => {
            if (pending === fn) {
                pending = null;
            }
        },
        warn: (line) => warned.push(line),
    });

    return {
        fs,
        watching,
        warned,
        links,
        watchedDirs: () => watchedDirs,
        reloads: () => reloads,
        timersSet: () => timersSet,
        hasTimer: () => pending !== null,
        fire: () => {
            const fn = pending;

            pending = null;
            fn();
        },
    };
}

//  =====================================================================
//  Events
//  =====================================================================

Deno.test("isConfigEvent — only the config file's own changes", () => {
    const at = (kind, name) => ({ kind, paths: [join(DIR, name)] });

    assertEquals(isConfigEvent(at("modify", "config.jsonc")), true);
    assertEquals(isConfigEvent(at("rename", "config.jsonc")), true);
    assertEquals(isConfigEvent(at("create", "config.json")), true);
    assertEquals(isConfigEvent(at("remove", "config.jsonc")), true);

    assertEquals(isConfigEvent(at("access", "config.jsonc")), false);
    assertEquals(isConfigEvent(at("modify", "decision-log.db")), false);
    assertEquals(isConfigEvent(at("modify", "decision-log.db-wal")), false);
    assertEquals(isConfigEvent(at("modify", "api-token")), false);
    assertEquals(isConfigEvent(at("modify", "config.jsonc.swp")), false);
});

Deno.test("watch — one save, several events, one reload", async () => {
    const h = harness();

    h.fs.push("create", "config.jsonc");
    h.fs.push("modify", "config.jsonc");
    h.fs.push("rename", "config.jsonc");
    await turn();

    assertEquals(h.reloads(), 0);
    assertEquals(h.timersSet(), 3);

    h.fire();

    assertEquals(h.reloads(), 1);
    assertEquals(h.hasTimer(), false);

    h.watching.close();
    await turn();
});

Deno.test("watch — the decision log's writes never reload", async () => {
    const h = harness();

    h.fs.push("modify", "decision-log.db");
    h.fs.push("modify", "decision-log.db-wal");
    await turn();

    assertEquals(h.hasTimer(), false);
    assertEquals(h.reloads(), 0);

    h.watching.close();
    await turn();
});

Deno.test("watch — a second save reloads again", async () => {
    const h = harness();

    h.fs.push("modify", "config.jsonc");
    await turn();
    h.fire();

    h.fs.push("modify", "config.jsonc");
    await turn();
    h.fire();

    assertEquals(h.reloads(), 2);

    h.watching.close();
    await turn();
});

Deno.test("watch — closing drops a reload not yet run", async () => {
    const h = harness();

    h.fs.push("modify", "config.jsonc");
    await turn();

    h.watching.close();
    await turn();

    assertEquals(h.hasTimer(), false);
    assertEquals(h.reloads(), 0);
    assertEquals(h.watching.error(), null);
    assertEquals(h.warned, []);
});

//  =====================================================================
//  A watch that fails
//  =====================================================================

Deno.test("watch — a watch that breaks says so and keeps it", async () => {
    const h = harness();

    h.fs.fail(new Error("too many open files"));
    await turn();

    assertEquals(h.watching.error(), "too many open files");
    assertEquals(h.warned.length, 1);
    assertStringIncludes(h.warned[0], "NOT being watched");
    assertStringIncludes(h.warned[0], "saxby service restart");
});

Deno.test("watch — a watch that cannot start says so too", () => {
    const warned = [];

    const watching = watchConfig({
        dir: DIR,
        reload: () => Promise.resolve(),
        watchFs: () => {
            throw new Error("no such folder");
        },
        warn: (line) => warned.push(line),
    });

    assertEquals(watching.error(), "no such folder");
    assertEquals(warned.length, 1);

    watching.close();
});

//  =====================================================================
//  A symlinked config
//  =====================================================================

const DOTFILES = "/home/someone/dotfiles/saxby";

Deno.test("targets — a plain config watches its own folder", () => {
    const links = { [join(DIR, "config.json")]: MISSING };

    assertEquals(listWatchTargets(DIR, fakeRealPath(links)), {
        dirs: [DIR],
        names: ["config.jsonc", "config.json"],
    });
});

Deno.test("targets — a linked config adds the real file's folder", () => {
    const links = {
        [join(DIR, "config.jsonc")]: join(DOTFILES, "saxby.jsonc"),
        [join(DIR, "config.json")]: MISSING,
    };

    assertEquals(listWatchTargets(DIR, fakeRealPath(links)), {
        dirs: [DIR, DOTFILES],
        names: ["config.jsonc", "config.json", "saxby.jsonc"],
    });
});

Deno.test("targets — a linked instance folder is still one folder", () => {
    //  ~/.config/saxby is itself a link; the file is not linked again.
    const links = {
        [DIR]: DOTFILES,
        [join(DIR, "config.jsonc")]: join(DOTFILES, "config.jsonc"),
        [join(DIR, "config.json")]: MISSING,
    };

    assertEquals(listWatchTargets(DIR, fakeRealPath(links)).dirs, [DIR]);
});

Deno.test("watch — an edit to a linked config's target reloads", async () => {
    const h = harness({
        links: {
            [join(DIR, "config.jsonc")]: join(DOTFILES, "saxby.jsonc"),
            [join(DIR, "config.json")]: MISSING,
        },
    });

    assertEquals(h.watchedDirs(), [DIR, DOTFILES]);

    h.fs.push("modify", "saxby.jsonc");
    await turn();
    h.fire();

    assertEquals(h.reloads(), 1);

    h.watching.close();
    await turn();
});

Deno.test("watch — a link moved to a new folder is reported", async () => {
    const elsewhere = "/home/someone/other";

    const h = harness({
        links: { [join(DIR, "config.json")]: MISSING },
    });

    //  Replacing the file with a link is a change in the instance
    //  folder, so it reloads; the new folder was never watched.
    h.links[join(DIR, "config.jsonc")] = join(elsewhere, "config.jsonc");
    h.fs.push("create", "config.jsonc");
    await turn();
    h.fire();
    await turn();

    assertEquals(h.reloads(), 1);
    assertStringIncludes(h.watching.error(), elsewhere);
    assertEquals(h.warned.length, 1);
    assertStringIncludes(h.warned[0], "NOT being watched");

    h.watching.close();
    await turn();
});

Deno.test("watch — a real save in a real folder reloads", async () => {
    const dir = await Deno.makeTempDir();

    let reloads = 0;
    let seen = null;

    const reloaded = new Promise((resolve) => {
        seen = resolve;
    });

    const watching = watchConfig({
        dir,
        settleMs: 20,
        reload: () => {
            reloads += 1;
            seen();

            return Promise.resolve();
        },
    });

    //  Write-then-rename, as editors save.
    await Deno.writeTextFile(join(dir, "config.jsonc.tmp"), "{}");
    await Deno.rename(
        join(dir, "config.jsonc.tmp"),
        join(dir, "config.jsonc"),
    );

    //  A watch that never fires must fail the test, not hang it.
    let giveUp = null;

    const timedOut = new Promise((_, reject) => {
        giveUp = setTimeout(
            () => reject(new Error("no reload within 5 s of a save")),
            REAL_WATCH_TIMEOUT_MS,
        );
    });

    try {
        await Promise.race([reloaded, timedOut]);
    } finally {
        clearTimeout(giveUp);
        watching.close();
        await Deno.remove(dir, { recursive: true });
    }

    assertEquals(reloads, 1);
    assertEquals(watching.error(), null);
});
