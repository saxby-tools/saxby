//  =====================================================================
//  deno task deploy
//  =====================================================================
//  Puts a fresh build of this checkout into service on this machine:
//
//    1. build saxbyd and saxby for this machine (scripts/build.js)
//    2. install both into ~/.local/bin
//    3. restart the default instance's service with the new saxby
//    4. confirm the service reports the version just built
//
//  Step 4 is the point. Typed by hand, these steps went stale after a
//  version bump: the build passed, the install named an old folder and
//  failed, and the service quietly kept the old build. A deploy that
//  ends anywhere but "the service runs <version>" exits non-zero.
//
//  Default instance only; dev runs from source with `deno task dev`.
//  Service-file changes, such as a new environment variable, need
//  `saxby service install` instead of a restart.
//
//  The task's --allow-run is unscoped because the new saxby lives
//  under $HOME, which deno.json cannot name.

import { join } from "@std/path";
import { fetchSaxbyStatus, getHomeDir, loadConfig } from "@saxby/core";
import { build } from "./build.js";

const INSTALL_SUBDIR = ".local/bin";
const BINARIES = ["saxbyd", "saxby"];

//  `install` removes the old file and writes a new one, so the running
//  process keeps its binary until it restarts. `cp` overwrites the file
//  in place, which on macOS can get the running process killed once
//  its code signature no longer matches the pages on disk.
const INSTALL_MODE = "755";

function installDir() {
    const home = getHomeDir();

    if (!home) {
        throw new Error("No home directory: HOME is not set.");
    }

    return join(home, INSTALL_SUBDIR);
}

async function run(command, args) {
    const child = new Deno.Command(command, {
        args,
        stdout: "inherit",
        stderr: "inherit",
    });

    const { code } = await child.output();

    return code;
}

async function installBinaries(stageDir, targetDir) {
    await Deno.mkdir(targetDir, { recursive: true });

    const sources = BINARIES.map((name) => join(stageDir, name));
    const code = await run("install", [
        "-m",
        INSTALL_MODE,
        ...sources,
        targetDir,
    ]);

    if (code !== 0) {
        throw new Error(`install exited ${code}; nothing was restarted.`);
    }

    console.log(`📥 ${BINARIES.join(" and ")} → ${targetDir}`);
}

//  A warning, not a failure: the service runs the absolute path in its
//  service file. But `saxby` typed in a terminal would find another
//  copy, or none.
function warnIfOffPath(targetDir) {
    const dirs = (Deno.env.get("PATH") ?? "").split(":");

    if (dirs.includes(targetDir)) {
        return;
    }

    console.warn(
        `⚠️  ${targetDir} is not on PATH, so 'saxby' in a terminal ` +
            `will not find this build.`,
    );
}

async function restartService(targetDir) {
    const code = await run(join(targetDir, "saxby"), ["service", "restart"]);

    if (code !== 0) {
        throw new Error(
            "The binaries are installed, but the service did not " +
                "restart. See the message above.",
        );
    }
}

async function verifyVersion(version) {
    const config = await loadConfig();
    const port = config.listen_port;
    const holder = await fetchSaxbyStatus(port);

    if (!holder) {
        throw new Error(
            `Nothing answers on :${port} after the restart. Check ` +
                `the logs: saxby service status.`,
        );
    }

    if (holder.version !== version) {
        throw new Error(
            `The service on :${port} reports ${holder.version}, but ` +
                `this build is ${version}. Its service file may run a ` +
                `saxbyd from another folder; 'saxby service install' ` +
                `points it at the one on PATH.`,
        );
    }
}

async function main() {
    const { version, stageDirs } = await build([]);
    const targetDir = installDir();

    console.log("");

    await installBinaries(stageDirs[0], targetDir);
    warnIfOffPath(targetDir);

    await restartService(targetDir);
    await verifyVersion(version);

    console.log(`\n✅ The service on this machine runs Saxby ${version}.`);
}

//  Same as build.js: these are user errors, so print the message, not
//  a stack trace.
if (import.meta.main) {
    try {
        await main();
    } catch (err) {
        console.error(`❌ ${err.message}`);
        Deno.exit(1);
    }
}
